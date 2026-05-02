const express = require("express");
const puppeteer = require("puppeteer-core");

const app = express();
const port = 3000;
const googleMapsUrl =
  "https://www.google.com/maps/dir/?api=1&origin=9.8192117,99.9964583&destination=9.712199862086026,99.98672318780132&travelmode=driving";
const chromePath =
  process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
let browserPromise = null;

app.get("/", (req, res) => {
  res.send("Hello World!");
});

app.get("/google", async (req, res) => {
  try {
    const data = await getGoogleMapsData();

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(port, () => {
  console.log(`Example app listening on port localhost:${port}`);
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function getGoogleMapsData() {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
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
    const distance = findDistance(lines);
    const duration = findDuration(lines);

    return {
      url: googleMapsUrl,
      distance: distance || null,
      duration: duration || null,
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
