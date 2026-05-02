const express = require("express");
const puppeteer = require("puppeteer-core");

const app = express();
const port = 3000;
const chromePath =
  process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
let browserPromise = null;

app.use(express.json());

app.get("/", (req, res) => {
  res.send("Hello World!");
});

app.post("/google", async (req, res) => {
  try {
    const source = parseRequestCoordinate(req.body.source, "source");
    const destination = parseRequestCoordinate(req.body.destination, "destination");
    const travelmode = req.body.travelmode || "driving";
    const googleMapsUrl = buildGoogleMapsUrl(source, destination, travelmode);
    const data = await getGoogleMapsData(googleMapsUrl, source, destination);

    res.json(data);
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.listen(port, () => {
  console.log(`Example app listening on port localhost:${port}`);
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function parseRequestCoordinate(value, fieldName) {
  const lat = Number(value?.lat ?? value?.latitude);
  const lng = Number(value?.lng ?? value?.lon ?? value?.longitude);

  if (!isValidCoordinate(lat, lng)) {
    const error = new Error(
      `${fieldName} must be an object like {"lat":9.8192117,"lng":99.9964583}`
    );
    error.statusCode = 400;
    throw error;
  }

  return {
    lat,
    lng
  };
}

function buildGoogleMapsUrl(source, destination, travelmode) {
  const url = new URL("https://www.google.com/maps/dir/");

  url.searchParams.set("api", "1");
  url.searchParams.set("origin", `${source.lat},${source.lng}`);
  url.searchParams.set("destination", `${destination.lat},${destination.lng}`);
  url.searchParams.set("travelmode", travelmode);

  return url.toString();
}

async function getGoogleMapsData(googleMapsUrl, source, destination) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  let directionsResponseText = null;

  try {
    page.on("response", async (response) => {
      if (directionsResponseText || !response.url().includes("/maps/preview/directions")) {
        return;
      }

      try {
        directionsResponseText = await response.text();
      } catch {
        directionsResponseText = null;
      }
    });

    await page.setViewport({ width: 1366, height: 768 });
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    );
    await page.goto(googleMapsUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });
    await waitForRouteText(page);

    const pageText = await page.evaluate(() => document.body.innerText);
    const lines = cleanLines(pageText);
    const routes = extractRoutesFromDirectionsResponse(directionsResponseText, source, destination);
    const firstRoute = routes[0] || {};
    const distance = firstRoute.distance || findDistance(lines);
    const duration = firstRoute.duration || findDuration(lines);

    return {
      url: googleMapsUrl,
      source,
      destination,
      distance: distance || null,
      duration: duration || null,
      polyline: firstRoute.polyline || null,
      routes,
      fullText: lines
    };
  } finally {
    await page.close();
  }
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer
      .launch({
        executablePath: chromePath,
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
      })
      .catch((error) => {
        browserPromise = null;
        throw error;
      });
  }

  const browser = await browserPromise;

  if (!browser.isConnected()) {
    browserPromise = null;
    return getBrowser();
  }

  return browser;
}

async function shutdown() {
  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close();
  }

  process.exit(0);
}

async function waitForRouteText(page) {
  try {
    await page.waitForFunction(
      () => {
        const text = document.body.innerText || "";

        return /(\d+(?:\.\d+)?\s*(km|m|mi|mile|miles))|(\d+\s*(min|mins|hr|hrs|hour|hours))/i.test(
          text
        );
      },
      { timeout: 30000 }
    );
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

function cleanLines(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line, index, lines) => lines.indexOf(line) === index);
}

function findDistance(lines) {
  return lines.find((line) =>
    /^\d+(?:\.\d+)?\s*(km|m|mi|mile|miles)$/i.test(line)
  );
}

function findDuration(lines) {
  return lines.find((line) =>
    /^\d+\s*(min|mins|hr|hrs|hour|hours)(\s+\d+\s*(min|mins))?$/i.test(line)
  );
}

function extractRoutesFromDirectionsResponse(text, origin, destination) {
  if (!text) {
    return [];
  }

  try {
    const data = JSON.parse(stripGoogleJsonPrefix(text));
    const routes = data?.[0]?.[1];

    if (!Array.isArray(routes)) {
      return [];
    }

    return routes
      .map((route, index) => buildRoute(route, index, origin, destination))
      .filter((route) => route.polyline.points.length > 0);
  } catch {
    return [];
  }
}

function stripGoogleJsonPrefix(text) {
  return text.replace(/^\)\]\}'\n/, "");
}

function buildRoute(route, index, origin, destination) {
  const summary = route?.[0];
  const points = extractRoutePoints(route, origin, destination);

  return {
    index,
    name: summary?.[1] || null,
    distance: summary?.[2]?.[1] || null,
    distanceMeters: summary?.[2]?.[0] || null,
    duration: summary?.[3]?.[1] || null,
    durationSeconds: summary?.[3]?.[0] || null,
    polyline: buildPolyline(points)
  };
}

function extractRoutePoints(route, origin, destination) {
  const points = [];
  const steps = route?.[1]?.[0]?.[1]?.[0]?.[1] || [];
  const finalSegment = route?.[1]?.[0]?.[4]?.[2]?.[1] || [];

  addPoint(points, origin);

  for (const step of steps) {
    const geometry = step?.[0]?.[7];

    addPoint(points, googleCoordinateToPoint(geometry?.[1]?.[0]));
    addPoint(points, googleCoordinateToPoint(geometry?.[1]?.[1]));
    addPoint(points, googleCoordinateToPoint(geometry?.[2]));
  }

  for (const coordinate of finalSegment) {
    addPoint(points, googleCoordinateToPoint(coordinate));
  }

  addPoint(points, destination);

  return points;
}

function googleCoordinateToPoint(value) {
  const lat = value?.[2];
  const lng = value?.[3];

  if (!isValidCoordinate(lat, lng)) {
    return null;
  }

  return { lat, lng };
}

function addPoint(points, point) {
  if (!point || !isValidCoordinate(point.lat, point.lng)) {
    return;
  }

  const previous = points[points.length - 1];

  if (previous && previous.lat === point.lat && previous.lng === point.lng) {
    return;
  }

  points.push({
    lat: roundCoordinate(point.lat),
    lng: roundCoordinate(point.lng)
  });
}

function isValidCoordinate(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

function roundCoordinate(value) {
  return Number(value.toFixed(7));
}

function buildPolyline(points) {
  return {
    source: "google_maps_web_internal_directions",
    type: "step-overview",
    pointCount: points.length,
    points,
    encoded: encodePolyline(points),
    geoJson: {
      type: "LineString",
      coordinates: points.map((point) => [point.lng, point.lat])
    },
    note: "Polyline is extracted from Google Maps web-rendered directions data, not the official Directions API."
  };
}

function encodePolyline(points) {
  let previousLat = 0;
  let previousLng = 0;
  let encoded = "";

  for (const point of points) {
    const lat = Math.round(point.lat * 1e5);
    const lng = Math.round(point.lng * 1e5);

    encoded += encodeSignedNumber(lat - previousLat);
    encoded += encodeSignedNumber(lng - previousLng);

    previousLat = lat;
    previousLng = lng;
  }

  return encoded;
}

function encodeSignedNumber(number) {
  let value = number < 0 ? ~(number << 1) : number << 1;
  let encoded = "";

  while (value >= 0x20) {
    encoded += String.fromCharCode((0x20 | (value & 0x1f)) + 63);
    value >>= 5;
  }

  encoded += String.fromCharCode(value + 63);

  return encoded;
}
