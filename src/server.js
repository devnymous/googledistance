const cors = require("cors");
const express = require("express");
const axios = require("axios");
const http = require("http");
const https = require("https");

const app = express();
const port = Number(process.env.PORT) || 3000;

const pendingRoutes = new Map();
const routeCache = new Map();

const ROUTE_TIMEOUT_MS = readPositiveNumberEnv("ROUTE_TIMEOUT_MS", 4000);
const ROUTE_CACHE_TTL_MS = readNonNegativeNumberEnv("ROUTE_CACHE_TTL_MS", 5 * 60 * 1000);
const ROUTE_CACHE_MAX = readPositiveNumberEnv("ROUTE_CACHE_MAX", 500);
const ROUTE_CACHE_COORD_STEP = 0.00005;
const GOOGLE_MAPS_BASE_URL = "https://www.google.com";
const GOOGLE_MAPS_HEADERS = {
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Encoding": "gzip, deflate, br",
  "Accept-Language": "en-US,en;q=0.9",
  "Connection": "keep-alive",
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
};
const googleMapsClient = axios.create({
  timeout: ROUTE_TIMEOUT_MS,
  headers: GOOGLE_MAPS_HEADERS,
  httpAgent: new http.Agent({ keepAlive: true, maxSockets: 50 }),
  httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 50 }),
  maxRedirects: 3,
  responseType: "text"
});
const DEFAULT_TRAVEL_MODE = "driving";
const TRAVEL_MODES = new Set(["driving", "walking", "bicycling", "transit"]);
const DIRECTIONS_MODE_OPTIONS = {
  driving: {
    travelModeCode: 0,
    outerFlagCount: 54,
    innerFlagCount: 24,
    modeFlags: "!246b1!253b1!260b1!266b1!270b1!273b1!279b1"
  },
  walking: {
    travelModeCode: 2,
    outerFlagCount: 55,
    innerFlagCount: 25,
    modeFlags: "!246b1!253b1!260b1!266b1!270b1!271b1!273b1!279b1"
  },
  bicycling: {
    travelModeCode: 1,
    outerFlagCount: 55,
    innerFlagCount: 25,
    modeFlags: "!239b1!246b1!253b1!260b1!266b1!270b1!273b1!279b1"
  },
  transit: {
    travelModeCode: 3,
    outerFlagCount: 55,
    innerFlagCount: 25,
    modeFlags: "!246b1!253b1!260b1!266b1!270b1!273b1!279b1!281b1"
  }
};

app.use(cors({ origin: "*" }));
app.use(express.json());
app.use((req, res, next) => {
  const startedAt = Date.now();

  logInfo("request:start", {
    method: req.method,
    path: req.originalUrl
  });

  res.on("finish", () => {
    logInfo("request:finish", {
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt
    });
  });

  next();
});

/* ================= ROUTES ================= */

// ✅ 1. Distance API
app.get("/distance", async (req, res) => {
  const startedAt = Date.now();

  try {
    const { source, destination, travelMode } = parseInput(req);
    const googleMapUrl = buildGoogleMapsUrl(source, destination, travelMode);

    logInfo("distance:fetch", { source, destination, travelMode });

    const data = await fetchRoute(source, destination, travelMode, {
      includePolyline: false
    });

    const selectedRoute = selectShortestRoute(data.routes);

    const distanceKm = selectedRoute.distanceKm ?? parseDistanceToKm(selectedRoute.distance);

    logInfo("distance:success", {
      source,
      destination,
      travelMode,
      routeCount: data.routes.length,
      routeIndex: selectedRoute.index ?? null,
      distanceKm,
      duration: selectedRoute.duration || null
    });

    res.json({
      source,
      destination,
      travelMode,
      googleMapUrl,
      distance: distanceKm,
      duration: selectedRoute.duration || null,
      processingTimeMs: Date.now() - startedAt
    });
  } catch (e) {
    logError("distance:error", e, { body: req.body });
    res.status(500).json({
      error: e.message,
      processingTimeMs: Date.now() - startedAt
    });
  }
});

// ✅ 2. Polyline API
app.get("/polyline", async (req, res) => {
  const startedAt = Date.now();

  try {
    const { source, destination, travelMode } = parseInput(req);
    const googleMapUrl = buildGoogleMapsUrl(source, destination, travelMode);

    logInfo("polyline:fetch", { source, destination, travelMode });

    const data = await fetchRoute(source, destination, travelMode, {
      includePolyline: true
    });

    const selectedRoute = selectShortestRoute(data.routes);

    logInfo("polyline:success", {
      source,
      destination,
      travelMode,
      routeCount: data.routes.length,
      routeIndex: selectedRoute.index ?? null,
      pointCount: selectedRoute.polyline?.pointCount || 0
    });

    res.json({
      source,
      destination,
      travelMode,
      googleMapUrl,
      polyline: selectedRoute.polyline || null,
      processingTimeMs: Date.now() - startedAt
    });
  } catch (e) {
    logError("polyline:error", e, { body: req.body });
    res.status(500).json({
      error: e.message,
      processingTimeMs: Date.now() - startedAt
    });
  }
});

/* ================= SERVER ================= */

app.listen(port, () => {
  logInfo("server:started", { port });
});

/* ================= CORE ================= */

async function fetchRoute(source, destination, travelMode, options = {}) {
  const includePolyline = options.includePolyline === true;
  const cacheKey = buildRouteCacheKey(source, destination, travelMode, includePolyline);
  const cached = getCachedRoute(cacheKey);

  if (cached) {
    logInfo("route:cache-hit", { source, destination, travelMode });
    return cached;
  }

  const pending = pendingRoutes.get(cacheKey);

  if (pending) {
    logInfo("route:join-pending", { source, destination, travelMode });
    return pending;
  }

  const routePromise = fetchRouteUncached(source, destination, travelMode, {
    includePolyline
  })
    .then((data) => {
      if (data.routes.length > 0) {
        setCachedRoute(cacheKey, data);
      }

      return data;
    })
    .finally(() => {
      pendingRoutes.delete(cacheKey);
    });

  pendingRoutes.set(cacheKey, routePromise);
  return routePromise;
}

async function fetchRouteUncached(source, destination, travelMode, options = {}) {
  const googleMapUrl = buildGoogleMapsUrl(source, destination, travelMode);
  const includePolyline = options.includePolyline === true;

  logInfo("route:start", { source, destination, travelMode });

  try {
    const directRoutes = await tryFetchGeneratedRoutes(source, destination, travelMode, googleMapUrl, {
      includePolyline
    });

    if (directRoutes) return { routes: directRoutes };

    const fallbackResponse = await fetchPreloadDirections(googleMapUrl, source, destination, travelMode);
    const fallbackRoutes = extractRoutes(fallbackResponse.data, source, destination, {
      includePolyline
    });

    logInfo("route:resolved", {
      source,
      destination,
      travelMode,
      includePolyline,
      strategy: "preload-fallback",
      routeCount: fallbackRoutes.length
    });

    return { routes: fallbackRoutes };
  } catch (e) {
    if (e.code === "ECONNABORTED") {
      logInfo("route:timeout", { source, destination, travelMode });
    } else {
      logError("route:http-error", e, {
        source,
        destination,
        travelMode,
        statusCode: e.response?.status
      });
    }

    return emptyResponse();
  }
}

async function tryFetchGeneratedRoutes(source, destination, travelMode, googleMapUrl, options) {
  try {
    const directResponse = await fetchGeneratedDirections(source, destination, travelMode, googleMapUrl);
    const routes = extractRoutes(directResponse.data, source, destination, options);

    if (routes.length === 0) {
      logInfo("route:generated-empty", { source, destination, travelMode });
      return null;
    }

    logInfo("route:resolved", {
      source,
      destination,
      travelMode,
      includePolyline: options.includePolyline === true,
      strategy: "generated-directions",
      routeCount: routes.length
    });

    return routes;
  } catch (e) {
    if (e.code === "ECONNABORTED") throw e;

    logError("route:generated-error", e, {
      source,
      destination,
      travelMode,
      statusCode: e.response?.status
    });

    return null;
  }
}

async function fetchGeneratedDirections(source, destination, travelMode, googleMapUrl) {
  return googleMapsClient.get(buildGeneratedDirectionsUrl(source, destination, travelMode), {
    headers: buildDirectionsHeaders(googleMapUrl)
  });
}

async function fetchPreloadDirections(googleMapUrl, source, destination, travelMode) {
  const pageResponse = await googleMapsClient.get(googleMapUrl);
  const directionsUrl = extractDirectionsUrl(pageResponse.data);

  if (!directionsUrl) {
    logInfo("route:directions-url-missing", { source, destination, travelMode });
    return { data: "" };
  }

  return googleMapsClient.get(directionsUrl, {
    headers: buildDirectionsHeaders(googleMapUrl)
  });
}

function buildDirectionsHeaders(googleMapUrl) {
  return {
    ...GOOGLE_MAPS_HEADERS,
    "Accept": "*/*",
    "Referer": googleMapUrl
  };
}

function buildGeneratedDirectionsUrl(source, destination, travelMode) {
  const options = DIRECTIONS_MODE_OPTIONS[travelMode] || DIRECTIONS_MODE_OPTIONS[DEFAULT_TRAVEL_MODE];
  const pb = [
    `!1m4!3m2!3d${source.lat}!4d${source.lng}!6e2`,
    `!1m4!3m2!3d${destination.lat}!4d${destination.lng}!6e2`,
    "!3m12!1m3!1d60285.46432695884!2d73.0700306!3d19.202118249999998",
    "!2m3!1f0.0!2f0.0!3f0.0!3m2!1i1024!2i768!4f13.1",
    `!6m${options.outerFlagCount}!1m5!18b1!30b1!31m1!1b1!34e1`,
    `!2m4!5m1!6e2!20e3!39b1!6m${options.innerFlagCount}`,
    "!32i1!49b1!63m0!66b1!85b1!114b1!149b1!206b1!209b1!212b1!216b1",
    "!222b1!223b1!232b1!234b1!235b1",
    options.modeFlags,
    "!291m0!10b1!12b1!13b1!14b1!16b1!17m1!3e1",
    `!20m6!1e${options.travelModeCode}!2e3!5e2!6b1!8b1!14b1`,
    "!46m1!1b0!96b1!99b1!15m3!1sdirect!7e81!15i10142"
  ].join("");

  const url = new URL("/maps/preview/directions", GOOGLE_MAPS_BASE_URL);
  url.searchParams.set("authuser", "0");
  url.searchParams.set("hl", "en");
  url.searchParams.set("gl", "in");
  url.searchParams.set("pb", pb);

  return url.toString();
}

/* ================= PARSER ================= */

function extractDirectionsUrl(html) {
  if (typeof html !== "string") return null;

  const match = html.match(/href="([^"]*\/maps\/preview\/directions[^"]*)"/);
  if (!match) return null;

  const href = decodeHtmlEntities(match[1]);
  return new URL(href, GOOGLE_MAPS_BASE_URL).toString();
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function extractRoutes(text, origin, destination, options = {}) {
  try {
    const data = JSON.parse(text.replace(/^\)\]\}'\n/, ""));
    const routes = data?.[0]?.[1] || [];

    return routes.map((r, i) => buildRoute(r, i, origin, destination, options));
  } catch {
    return [];
  }
}

function buildRoute(route, index, origin, destination, options = {}) {
  const summary = route?.[0];
  const includePolyline = options.includePolyline === true;

  return {
    index,
    distance: summary?.[2]?.[1] || null,
    distanceKm: parseDistanceSummaryToKm(summary?.[2]),
    duration: summary?.[3]?.[1] || null,
    polyline: includePolyline ? buildPolyline(extractPoints(route, origin, destination)) : null
  };
}

function extractPoints(route, origin, destination) {
  const points = [];
  const steps = route?.[1]?.[0]?.[1]?.[0]?.[1] || [];

  addPoint(points, origin);

  for (const step of steps) {
    const geo = step?.[0]?.[7];
    addPoint(points, parseCoord(geo?.[1]?.[0]));
    addPoint(points, parseCoord(geo?.[1]?.[1]));
    addPoint(points, parseCoord(geo?.[2]));
  }

  addPoint(points, destination);

  return cleanPoints(points);
}

function parseCoord(v) {
  const lat = v?.[2];
  const lng = v?.[3];
  return isValid(lat, lng) ? { lat, lng } : null;
}

function addPoint(arr, p) {
  if (!p) return;
  const last = arr[arr.length - 1];
  if (!last || last.lat !== p.lat || last.lng !== p.lng) {
    arr.push({
      lat: Number(p.lat.toFixed(6)),
      lng: Number(p.lng.toFixed(6))
    });
  }
}

function selectShortestRoute(routes) {
  if (!Array.isArray(routes) || routes.length === 0) return {};

  return routes.reduce((shortest, route) => {
    const shortestDistance = shortest.distanceKm ?? parseDistanceToKm(shortest.distance);
    const routeDistance = route.distanceKm ?? parseDistanceToKm(route.distance);

    if (shortestDistance == null) return routeDistance == null ? shortest : route;
    if (routeDistance == null) return shortest;

    return routeDistance < shortestDistance ? route : shortest;
  }, routes[0]);
}

function parseDistanceSummaryToKm(summaryDistance) {
  const meters = summaryDistance?.[0];
  if (Number.isFinite(meters)) return meters / 1000;

  return parseDistanceToKm(summaryDistance?.[1]);
}

function cleanPoints(points) {
  return points.filter((p, i, arr) => {
    if (i === 0) return true;
    const prev = arr[i - 1];
    return p.lat !== prev.lat || p.lng !== prev.lng;
  });
}

function buildPolyline(points) {
  return {
    pointCount: points.length,
    encoded: encodePolyline(points)
  };
}

/* ================= ENCODE ================= */

function encodePolyline(points) {
  let prevLat = 0;
  let prevLng = 0;
  let result = "";

  for (const p of points) {
    const lat = Math.round(p.lat * 1e5);
    const lng = Math.round(p.lng * 1e5);

    result += encode(lat - prevLat);
    result += encode(lng - prevLng);

    prevLat = lat;
    prevLng = lng;
  }

  return result;
}

function encode(num) {
  num = num < 0 ? ~(num << 1) : num << 1;
  let str = "";

  while (num >= 0x20) {
    str += String.fromCharCode((0x20 | (num & 0x1f)) + 63);
    num >>= 5;
  }

  str += String.fromCharCode(num + 63);
  return str;
}

/* ================= HELPERS ================= */

function parseInput(req) {
  const query = req.query || {};
  return {
    source: parseRequestCoordinate(getQueryCoordinate(query, "source")),
    destination: parseRequestCoordinate(getQueryCoordinate(query, "destination")),
    travelMode: parseTravelMode(getQueryValue(query, "mode"))
  };
}

function getQueryCoordinate(query, name) {
  const pair = parseLatLngPair(getQueryValue(query, name));
  if (pair) return pair;

  let lat = getQueryValue(query, `${name}Lat`);
  let lng = getQueryValue(query, `${name}Lng`);

  if (lat == null) lat = getQueryValue(query, `${name}_lat`);
  if (lng == null) lng = getQueryValue(query, `${name}_lng`);

  if ((lat == null || lng == null) && name === "destination") {
    const altLat = getQueryValue(query, "destLat") ?? getQueryValue(query, "dest_lat");
    const altLng = getQueryValue(query, "destLng") ?? getQueryValue(query, "dest_lng");
    if (altLat != null || altLng != null) {
      lat = altLat;
      lng = altLng;
    }
  }

  return { lat, lng };
}

function getQueryValue(query, key) {
  const value = query[key];
  if (Array.isArray(value)) return value[0];
  return value;
}

function parseLatLngPair(value) {
  if (value == null) return null;
  const text = Array.isArray(value) ? value[0] : value;
  if (text == null) return null;

  const parts = String(text).split(",");
  if (parts.length !== 2) return null;

  return {
    lat: parts[0].trim(),
    lng: parts[1].trim()
  };
}

function parseRequestCoordinate(v) {
  const lat = Number(v?.lat);
  const lng = Number(v?.lng);

  if (!isValid(lat, lng)) {
    throw new Error("Invalid coordinates");
  }

  return { lat, lng };
}

function parseTravelMode(value) {
  if (value == null || value === "") return DEFAULT_TRAVEL_MODE;

  const travelMode = String(value).trim().toLowerCase();

  if (!TRAVEL_MODES.has(travelMode)) {
    throw new Error(`Invalid mode. Use one of: ${Array.from(TRAVEL_MODES).join(", ")}`);
  }

  return travelMode;
}

function isValid(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng);
}

function parseDistanceToKm(distanceText) {
  if (distanceText == null) return null;
  if (typeof distanceText === "number" && Number.isFinite(distanceText)) return distanceText;
  if (typeof distanceText !== "string") return null;

  const normalized = distanceText.replace(/,/g, "").trim();
  const match = normalized.match(/([\d.]+)\s*(miles?|mi|kilometers?|kilometres?|km|meters?|metres?|m|feet|foot|ft|yards?|yd)\b/i);

  if (!match) return null;

  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;

  const unit = match[2].toLowerCase();

  switch (unit) {
    case "km":
    case "kilometer":
    case "kilometers":
    case "kilometre":
    case "kilometres":
      return value;
    case "m":
    case "meter":
    case "meters":
    case "metre":
    case "metres":
      return value / 1000;
    case "mi":
    case "mile":
    case "miles":
      return value * 1.609344;
    case "ft":
    case "foot":
    case "feet":
      return value * 0.0003048;
    case "yd":
    case "yard":
    case "yards":
      return value * 0.0009144;
    default:
      return null;
  }
}

function readPositiveNumberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function readNonNegativeNumberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function buildRouteCacheKey(source, destination, travelMode, includePolyline = false) {
  const detail = includePolyline ? "polyline" : "summary";
  return `${detail}:${travelMode}:${formatCacheCoordinate(source.lat)},${formatCacheCoordinate(source.lng)}->${formatCacheCoordinate(destination.lat)},${formatCacheCoordinate(destination.lng)}`;
}

function formatCacheCoordinate(value) {
  return (Math.round(value / ROUTE_CACHE_COORD_STEP) * ROUTE_CACHE_COORD_STEP).toFixed(5);
}

function getCachedRoute(key) {
  if (ROUTE_CACHE_TTL_MS === 0) return null;

  const cached = routeCache.get(key);

  if (!cached) return null;

  if (cached.expiresAt <= Date.now()) {
    routeCache.delete(key);
    return null;
  }

  routeCache.delete(key);
  routeCache.set(key, cached);
  return cached.data;
}

function setCachedRoute(key, data) {
  if (ROUTE_CACHE_TTL_MS === 0) return;

  routeCache.delete(key);
  routeCache.set(key, {
    data,
    expiresAt: Date.now() + ROUTE_CACHE_TTL_MS
  });

  while (routeCache.size > ROUTE_CACHE_MAX) {
    const oldestKey = routeCache.keys().next().value;
    routeCache.delete(oldestKey);
  }
}

function logInfo(message, details = {}) {
  console.log(formatLog("info", message, details));
}

function logError(message, error, details = {}) {
  const errorDetails = error instanceof Error
    ? { error: error.message }
    : { error: String(error) };

  console.error(formatLog("error", message, {
    ...details,
    ...errorDetails
  }));
}

function formatLog(level, message, details = {}) {
  return JSON.stringify({
    time: new Date().toISOString(),
    level,
    message,
    ...details
  });
}

function buildGoogleMapsUrl(s, d, travelMode = DEFAULT_TRAVEL_MODE) {
  const origin = encodeURIComponent(`${s.lat},${s.lng}`);
  const destination = encodeURIComponent(`${d.lat},${d.lng}`);
  const mode = encodeURIComponent(travelMode);

  return `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}&travelmode=${mode}`;
}

function emptyResponse() {
  return {
    routes: []
  };
}
