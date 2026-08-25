"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

function run() {
  const src = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");

  assert(src.includes("const FORECAST_SOLAR_SLOT_COUNT ="));
  assert(src.includes("function countDayAheadSolarWindowRows(day)"));
  assert(src.includes("function hasCompleteDayAheadRowsForDate(day)"));
  assert(src.includes("function getIncompleteDayAheadContextDays()"));
  // v2.8.9 fix (2026-04-15): the literal "if (hasCompleteDayAheadRowsForDate(tomorrow))"
  // pattern was replaced by a broader quality-aware check that uses
  // `countDayAheadSolarWindowRows` + `assessTomorrowForecastQuality` — only
  // `quality === "healthy"` short-circuits regeneration now.  Verify the
  // equivalent completeness-check landmark survives in current code.
  assert(src.includes("countDayAheadSolarWindowRows(tomorrow)"));
  assert(src.includes("assessTomorrowForecastQuality"));
  assert(src.includes("const incompleteDays = getIncompleteDayAheadContextDays();"));
  assert(src.includes("storedRows <= 0 || incompleteDays.length > 0"));

  console.log("forecastCompletenessSource.test.js: PASS");
}

run();
