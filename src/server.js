const express = require("express");
const puppeteer = require("puppeteer");

const app = express();
const port = Number(process.env.PORT) || 3000;

let browserPromise = null;
const pendingRoutes = new Map();
const routeCache = new Map();

const ROUTE_TIMEOUT_MS = readPositiveNumberEnv("ROUTE_TIMEOUT_MS", 4000);
const NAVIGATION_TIMEOUT_MS = ROUTE_TIMEOUT_MS + 1000;
const ROUTE_CACHE_TTL_MS = readNonNegativeNumberEnv("ROUTE_CACHE_TTL_MS", 5 * 60 * 1000);
const ROUTE_CACHE_MAX = readPositiveNumberEnv("ROUTE_CACHE_MAX", 500);
const ROUTE_CACHE_COORD_STEP = 0.00005;
// Keep scripts and XHR unblocked; Maps needs them to request /maps/preview/directions.
const BLOCKED_RESOURCE_PATTERNS = [
  "*.avif*",
  "*.apng*",
  "*.bmp*",
  "*.png*",
  "*.jpg*",
  "*.jpeg*",
  "*.gif*",
  "*.webp*",
  "*.svg*",
  "*.ico*",
  "*.tif*",
  "*.tiff*",
  "*.heic*",
  "*.heif*",
  "*.css*",
  "*.woff*",
  "*.woff2*",
  "*.ttf*",
  "*.otf*",
  "*.eot*",
  "*.mp4*",
  "*.m4v*",
  "*.mov*",
  "*.avi*",
  "*.webm*",
  "*.ogv*",
  "*.mp3*",
  "*.wav*",
  "*.m4a*",
  "*.aac*",
  "*.flac*",
  "*.opus*",
  "*://*.doubleclick.net/*",
  "*://*.google-analytics.com/*",
  "*://*.googletagmanager.com/*",
  "*://adservice.google.com/*",
  "*://googleads.g.doubleclick.net/*",
  "https://fonts.googleapis.com/*",
  "https://fonts.gstatic.com/*",
  "https://lh*.googleusercontent.com/*",
  "https://geo*.ggpht.com/*",
  "https://khms*.google.com/*",
  "https://mt*.google.com/*",
  "https://play.google.com/log*",
  "https://streetviewpixels-pa.googleapis.com/*",
  "https://www.google.com/client_204*",
  "https://www.google.com/gen_204*",
  "https://www.google.com/log*",
  "https://www.gstatic.com/images/*",
  "https://maps.gstatic.com/*/icons/*",
  "https://maps.gstatic.com/mapfiles/*",
  "https://maps.gstatic.com/tactile/*"
];

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
app.post("/distance", async (req, res) => {
  try {
    const { source, destination } = parseInput(req);

    logInfo("distance:fetch", { source, destination });

    const data = await fetchRoute(source, destination);

    const first = data.routes[0] || {};

    logInfo("distance:success", {
      source,
      destination,
      routeCount: data.routes.length,
      distance: first.distance || null,
      duration: first.duration || null
    });

    res.json({
      source,
      destination,
      distance: first.distance || null,
      duration: first.duration || null
    });
  } catch (e) {
    logError("distance:error", e, { body: req.body });
    res.status(500).json({ error: e.message });
  }
});

// ✅ 2. Polyline API
app.post("/polyline", async (req, res) => {
  try {
    const { source, destination } = parseInput(req);

    logInfo("polyline:fetch", { source, destination });

    const data = await fetchRoute(source, destination);

    const first = data.routes[0] || {};

    logInfo("polyline:success", {
      source,
      destination,
      routeCount: data.routes.length,
      pointCount: first.polyline?.pointCount || 0
    });

    res.json({
      source,
      destination,
      polyline: first.polyline || null
    });
  } catch (e) {
    logError("polyline:error", e, { body: req.body });
    res.status(500).json({ error: e.message });
  }
});

/* ================= SERVER ================= */

app.listen(port, () => {
  logInfo("server:started", { port });

  if (process.env.PREWARM_BROWSER !== "false") {
    getBrowser().catch(() => {});
  }
});

/* ================= CORE ================= */

async function fetchRoute(source, destination) {
  const cacheKey = buildRouteCacheKey(source, destination);
  const cached = getCachedRoute(cacheKey);

  if (cached) {
    logInfo("route:cache-hit", { source, destination });
    return cached;
  }

  const pending = pendingRoutes.get(cacheKey);

  if (pending) {
    logInfo("route:join-pending", { source, destination });
    return pending;
  }

  const routePromise = fetchRouteUncached(source, destination)
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

async function fetchRouteUncached(source, destination) {
  const url = buildGoogleMapsUrl(source, destination);

  logInfo("route:start", { source, destination });

  const browser = await getBrowser();
  const page = await browser.newPage();
  let client = null;
  let finished = false;

  try {
    client = await prepareFastPage(page);

    const directionsResponse = page
      .waitForResponse(
        (response) => response.url().includes("/maps/preview/directions"),
        { timeout: ROUTE_TIMEOUT_MS }
      )
      .then(async (response) => {
        const text = await response.text();
        const routes = extractRoutes(text, source, destination);

        logInfo("route:resolved", {
          source,
          destination,
          routeCount: routes.length
        });

        return { routes };
      })
      .catch((e) => {
        if (finished) {
          return emptyResponse(source, destination);
        }

        if (e.name === "TimeoutError") {
          logInfo("route:timeout", { source, destination });
        } else {
          logError("route:parse-error", e, { source, destination });
        }

        return emptyResponse(source, destination);
      });

    const pageLoadFailure = page
      .goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS })
      .then(() => new Promise(() => {}))
      .catch((e) => {
        if (!finished) {
          logError("route:page-load-error", e, { source, destination });
        }

        return emptyResponse(source, destination);
      });

    const result = await Promise.race([directionsResponse, pageLoadFailure]);
    finished = true;
    return result;
  } finally {
    if (client) {
      await client.detach().catch(() => {});
    }

    if (!page.isClosed()) {
      await page.close().catch((e) => {
        logError("route:page-close-error", e, { source, destination });
      });
    }
  }
}

/* ================= BROWSER ================= */

async function getBrowser() {
  if (!browserPromise) {
    logInfo("browser:launch");
    browserPromise = puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-background-networking",
        "--disable-default-apps",
        "--disable-extensions",
        "--disable-sync",
        "--disable-translate",
        "--hide-scrollbars",
        "--mute-audio",
        "--no-first-run",
        "--blink-settings=imagesEnabled=false"
      ]
    })
      .then((browser) => {
        logInfo("browser:ready");
        browser.on("disconnected", () => {
          browserPromise = null;
          logInfo("browser:disconnected");
        });
        return browser;
      })
      .catch((e) => {
        browserPromise = null;
        logError("browser:error", e);
        throw e;
      });
  }
  return browserPromise;
}

async function prepareFastPage(page) {
  await page.setViewport({ width: 800, height: 600, deviceScaleFactor: 1 });
  await page.setCacheEnabled(true);

  const client = await page.target().createCDPSession();
  await client.send("Network.enable");
  await client.send("Network.setBlockedURLs", {
    urls: BLOCKED_RESOURCE_PATTERNS
  });

  return client;
}

/* ================= PARSER ================= */

function extractRoutes(text, origin, destination) {
  try {
    const data = JSON.parse(text.replace(/^\)\]\}'\n/, ""));
    const routes = data?.[0]?.[1] || [];

    return routes.map((r, i) => buildRoute(r, i, origin, destination));
  } catch {
    return [];
  }
}

function buildRoute(route, index, origin, destination) {
  const summary = route?.[0];
  const points = extractPoints(route, origin, destination);

  return {
    index,
    distance: summary?.[2]?.[1] || null,
    duration: summary?.[3]?.[1] || null,
    polyline: buildPolyline(points)
  };
}

/* ================= POLYLINE ================= */

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
  return {
    source: parseRequestCoordinate(req.body.source),
    destination: parseRequestCoordinate(req.body.destination)
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

function isValid(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng);
}

function readPositiveNumberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function readNonNegativeNumberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function buildRouteCacheKey(source, destination) {
  return `${formatCacheCoordinate(source.lat)},${formatCacheCoordinate(source.lng)}->${formatCacheCoordinate(destination.lat)},${formatCacheCoordinate(destination.lng)}`;
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

function buildGoogleMapsUrl(s, d) {
  return `https://www.google.com/maps/dir/${s.lat},${s.lng}/${d.lat},${d.lng}`;
}

function emptyResponse(source, destination) {
  return {
    routes: []
  };
}
