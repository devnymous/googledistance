const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseDistanceSummaryToKm,
  parseRawDistanceSummaryToKm,
  selectShortestRoute
} = require("../src/server");

test("parses Google display distance before raw meters", () => {
  const summaryDistance = [1366, "1.2 km"];

  assert.equal(parseDistanceSummaryToKm(summaryDistance), 1.2);
  assert.equal(parseRawDistanceSummaryToKm(summaryDistance), 1.366);
});

test("selects shortest route using raw meters", () => {
  const selected = selectShortestRoute([
    {
      index: 0,
      distance: "1.2 km",
      distanceKm: 1.2,
      rawDistanceKm: 1.366
    },
    {
      index: 1,
      distance: "1.3 km",
      distanceKm: 1.3,
      rawDistanceKm: 1.25
    }
  ]);

  assert.equal(selected.index, 1);
});
