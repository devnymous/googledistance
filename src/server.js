const express = require("express");
const puppeteer = require("puppeteer");

const app = express();
const port = Number(process.env.PORT) || 3000;

let browserPromise = null;

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
});

/* ================= CORE ================= */

async function fetchRoute(source, destination) {
  const url = buildGoogleMapsUrl(source, destination);

  logInfo("route:start", { source, destination });

  const browser = await getBrowser();
  const page = await browser.newPage();

  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const type = req.resourceType();
    if (["image", "stylesheet", "font", "media"].includes(type)) {
      req.abort();
    } else {
      req.continue();
    }
  });

  let resolved = false;

  return new Promise(async (resolve) => {
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        logInfo("route:timeout", { source, destination });
        resolve(emptyResponse(source, destination));
      }
    }, 5000);

    page.on("response", async (response) => {
      if (resolved) return;

      if (response.url().includes("/maps/preview/directions")) {
        try {
          const text = await response.text();
          const routes = extractRoutes(text, source, destination);

          clearTimeout(timeout);
          resolved = true;

          logInfo("route:resolved", {
            source,
            destination,
            routeCount: routes.length
          });

          resolve({
            routes
          });
        } catch (e) {
          logError("route:parse-error", e, { source, destination });
          resolve(emptyResponse(source, destination));
        }
      }
    });

    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 10000 });
    } catch (e) {
      if (!resolved) {
        clearTimeout(timeout);
        resolved = true;
        logError("route:page-load-error", e, { source, destination });
        resolve(emptyResponse(source, destination));
      }
    }
  }).finally(async () => {
    await page.close();
  });
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
        "--disable-dev-shm-usage"
      ]
    });
    browserPromise
      .then(() => logInfo("browser:ready"))
      .catch((e) => logError("browser:error", e));
  }
  return browserPromise;
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
  return `https://www.google.com/maps/dir/?api=1&origin=${s.lat},${s.lng}&destination=${d.lat},${d.lng}`;
}

function emptyResponse(source, destination) {
  return {
    routes: []
  };
}
