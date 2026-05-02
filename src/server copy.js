const express = require("express");
const { chromium } = require("playwright");

const app = express();
const port = 3000;

app.use(express.json());

let browser;
let context;

/* ================= INIT ================= */

(async () => {
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext();
})();

/* ================= ROUTE ================= */

app.post("/google", async (req, res) => {
  try {
    const source = req.body.source;
    const destination = req.body.destination;

    const url = `https://www.google.com/maps/dir/${source.lat},${source.lng}/${destination.lat},${destination.lng}`;

    const page = await context.newPage();

    const result = await getDirectionsFast(page, url, source, destination);

    await page.close();

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ================= FAST FETCH ================= */

async function getDirectionsFast(page, url, source, destination) {
  return new Promise(async (resolve, reject) => {
    let timeout;

    page.on("response", async (response) => {
      if (response.url().includes("/maps/preview/directions")) {
        try {
          const text = await response.text();
          clearTimeout(timeout);
          resolve(extract(text, source, destination));
        } catch (err) {
          reject(err);
        }
      }
    });

    await page.goto(url, { waitUntil: "domcontentloaded" });

    timeout = setTimeout(() => {
      resolve({
        source,
        destination,
        distance: null,
        duration: null,
        polyline: null,
        note: "Timeout fallback"
      });
    }, 3000);
  });
}

/* ================= PARSER ================= */

function extract(text, source, destination) {
  try {
    const data = JSON.parse(text.replace(/^\)\]\}'\n/, ""));
    const route = data?.[0]?.[1]?.[0]?.[0];

    const distance = route?.[2]?.[1] || null;
    const duration = route?.[3]?.[1] || null;

    const points = extractPoints(data, source, destination);

    return {
      source,
      destination,
      distance,
      duration,
      polyline: {
        points,
         pointCount: points.length,
        encoded: encodePolyline(points)
      },
      note: "Playwright with polyline"
    };
  } catch {
    return {
      source,
      destination,
      distance: null,
      duration: null,
      polyline: null,
      note: "Parse failed"
    };
  }
}

/* ================= POLYLINE EXTRACTION ================= */

function extractPoints(data, source, destination) {
  const points = [];

  try {
    const steps = data?.[0]?.[1]?.[0]?.[1]?.[0]?.[1]?.[0]?.[1] || [];

    points.push(source);

    for (const step of steps) {
      const geo = step?.[0]?.[7];

      addPoint(points, geo?.[1]?.[0]);
      addPoint(points, geo?.[1]?.[1]);
      addPoint(points, geo?.[2]);
    }

    points.push(destination);
  } catch {}

  return points;
}

function addPoint(points, value) {
  if (!value) return;

  const lat = value?.[2];
  const lng = value?.[3];

  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    points.push({ lat, lng });
  }
}

/* ================= ENCODER ================= */

function encodePolyline(points) {
  let prevLat = 0;
  let prevLng = 0;
  let result = "";

  for (const point of points) {
    const lat = Math.round(point.lat * 1e5);
    const lng = Math.round(point.lng * 1e5);

    result += encodeValue(lat - prevLat);
    result += encodeValue(lng - prevLng);

    prevLat = lat;
    prevLng = lng;
  }

  return result;
}

function encodeValue(value) {
  value = value < 0 ? ~(value << 1) : value << 1;
  let encoded = "";

  while (value >= 0x20) {
    encoded += String.fromCharCode((0x20 | (value & 0x1f)) + 63);
    value >>= 5;
  }

  encoded += String.fromCharCode(value + 63);

  return encoded;
}

/* ================= SERVER ================= */

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});