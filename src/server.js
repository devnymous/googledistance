const express = require("express");
const puppeteer = require("puppeteer");

const app = express();
const port = 3000;

let browserPromise = null;

app.use(express.json());

app.post("/google", async (req, res) => {
  try {
    const source = parseRequestCoordinate(req.body.source, "source");
    const destination = parseRequestCoordinate(req.body.destination, "destination");

    const url = buildGoogleMapsUrl(source, destination);

    const data = await getGoogleMapsData(url, source, destination);

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

/* ================= CORE ================= */

async function getGoogleMapsData(url, source, destination) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  // 🚀 Block heavy resources
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

  return new Promise(async (resolve, reject) => {
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve(emptyResponse(source, destination));
      }
    }, 5000);

    page.on("response", async (response) => {
      if (resolved) return;

      if (response.url().includes("/maps/preview/directions")) {
        try {
          const text = await response.text();

          const routes = extractRoutes(text, source, destination);
          const first = routes[0] || {};

          clearTimeout(timeout);
          resolved = true;

          resolve({
            url,
            source,
            destination,
            distance: first.distance || null,
            duration: first.duration || null,
            polyline: first.polyline || null,
            routes
          });
        } catch (e) {
          reject(e);
        }
      }
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
  }).finally(async () => {
    await page.close();
  });
}

/* ================= BROWSER ================= */

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage"
      ]
    });
  }

  return browserPromise;
}

/* ================= ROUTE PARSER ================= */

function extractRoutes(text, origin, destination) {
  try {
    const data = JSON.parse(text.replace(/^\)\]\}'\n/, ""));
    const routes = data?.[0]?.[1] || [];

    return routes.map((route, i) => buildRoute(route, i, origin, destination));
  } catch {
    return [];
  }
}

function buildRoute(route, index, origin, destination) {
  const summary = route?.[0];
  const points = extractPoints(route, origin, destination);

  return {
    index,
    name: summary?.[1] || null,
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
    points,
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

function parseRequestCoordinate(v, name) {
  const lat = Number(v?.lat);
  const lng = Number(v?.lng);

  if (!isValid(lat, lng)) {
    throw new Error(`${name} invalid`);
  }

  return { lat, lng };
}

function isValid(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng);
}

function buildGoogleMapsUrl(s, d) {
  return `https://www.google.com/maps/dir/?api=1&origin=${s.lat},${s.lng}&destination=${d.lat},${d.lng}`;
}

function emptyResponse(source, destination) {
  return {
    source,
    destination,
    distance: null,
    duration: null,
    polyline: null,
    routes: []
  };
}