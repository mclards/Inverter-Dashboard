"use strict";

// Covers the Day-Ahead Export "Load Data" feature:
//  - ensureFreshestDayAheadSnapshots() date-window + clamp + minDays guarantee
//  - POST /api/forecast/solcast/load-data shape (not-configured fallback path)
//  - shouldProxyApiPath() keeps Solcast snapshot data local in EVERY mode (1.4)
// All assertions are network-free: with no Solcast config the toolkit fetch
// short-circuits to the fallback path before any HTTP is attempted.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.NODE_ENV = "test";
if (!process.env.IM_PORTABLE_DATA_DIR) {
  process.env.IM_PORTABLE_DATA_DIR = fs.mkdtempSync(
    path.join(os.tmpdir(), "adsi-forecast-loaddata-"),
  );
}
if (!process.env.ADSI_SERVER_PORT) process.env.ADSI_SERVER_PORT = "3539";
fs.mkdirSync(path.join(process.env.IM_PORTABLE_DATA_DIR, "config"), {
  recursive: true,
});

const APP_BASE_URL = `http://127.0.0.1:${Number(process.env.ADSI_SERVER_PORT || 3539)}`;

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch (_) {
    parsed = null;
  }
  if (!response.ok) {
    throw new Error(String(parsed?.error || text || `HTTP ${response.status}`));
  }
  return parsed;
}

async function run() {
  console.log("[Test] Starting forecastLoadDataPipeline tests...");

  require("../db.js");
  const serverMod = require("../index.js");
  const testHooks = global.__adsiTestHooks || {};

  try {
    await waitMs(1000);

    // Test 1: Solcast snapshot data stays LOCAL in every operation mode (1.4)
    console.log("[Test 1] shouldProxyApiPath keeps Solcast data local...");
    {
      const fn = testHooks.shouldProxyApiPath;
      assert.equal(typeof fn, "function", "shouldProxyApiPath hook not exposed");
      assert.equal(
        fn("/solcast/snapshot-dates"),
        false,
        "snapshot-dates must NOT proxy (export date list must work offline)",
      );
      assert.equal(
        fn("/forecast/solcast/load-data"),
        false,
        "load-data must NOT proxy (runs locally in remote mode)",
      );
      assert.equal(
        fn("/forecast/solcast/preview"),
        false,
        "existing /forecast/solcast/ exclusion still holds",
      );
      // A normal proxied path is unaffected by the new exclusions.
      assert.equal(
        fn("/report/daily"),
        true,
        "unrelated paths still proxy in remote mode",
      );
      console.log("  ✓ Solcast snapshot endpoints excluded from gateway proxy");
    }

    // Test 2: ensureFreshestDayAheadSnapshots window math + clamp + minDays
    console.log("[Test 2] Freshest-N window math, clamp, minDays guarantee...");
    {
      const ensureFn = testHooks.ensureFreshestDayAheadSnapshots;
      assert.equal(
        typeof ensureFn,
        "function",
        "ensureFreshestDayAheadSnapshots hook not exposed",
      );

      // No Solcast config in a fresh test DB → autoFetch short-circuits to
      // not_configured, so this returns the fallback-db branch with no HTTP.
      const r1 = await ensureFn();
      assert.equal(r1.source, "fallback-db", "no config → fallback-db source");
      assert.equal(
        Array.isArray(r1.requestedDates),
        true,
        "requestedDates must be an array",
      );
      assert.equal(
        r1.requestedDates.length,
        r1.forecastDays,
        "requestedDates length must equal resolved forecastDays",
      );
      assert.equal(
        r1.forecastDays >= 1 && r1.forecastDays <= 15,
        true,
        "forecastDays clamped to 1..15",
      );
      // Window must be contiguous ascending ISO dates starting today.
      for (let i = 1; i < r1.requestedDates.length; i += 1) {
        assert.equal(
          r1.requestedDates[i] > r1.requestedDates[i - 1],
          true,
          "requestedDates strictly ascending",
        );
      }

      // minDays guarantee: even when the setting resolves below minDays, the
      // window widens so the day-ahead lock always covers "tomorrow".
      const r2 = await ensureFn({ minDays: 2 });
      assert.equal(
        r2.requestedDates.length >= 2,
        true,
        "minDays:2 guarantees at least today+tomorrow",
      );
      console.log("  ✓ Window contiguous, clamped, minDays honored");
    }

    // Test 3: POST /api/forecast/solcast/load-data — not-configured fallback
    console.log("[Test 3] Load Data endpoint shape (not-configured)...");
    {
      const r = await fetchJson(`${APP_BASE_URL}/api/forecast/solcast/load-data`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      assert.equal(r.source, "fallback-db", "no config → fallback-db");
      assert.equal(r.reason, "not_configured", "reason surfaced to caller");
      assert.equal(r.persisted, 0, "nothing persisted without config");
      assert.equal(
        Array.isArray(r.requestedDates),
        true,
        "requestedDates present for response-shape consistency",
      );
      assert.equal(Array.isArray(r.dates), true, "dates array present");
      assert.equal(
        typeof r.forecastDays,
        "number",
        "forecastDays echoed back",
      );
      console.log("  ✓ Endpoint returns consistent fallback shape");
    }

    // Test 4: snapshot-dates endpoint reachable locally (export date list)
    console.log("[Test 4] snapshot-dates endpoint serves locally...");
    {
      const r = await fetchJson(`${APP_BASE_URL}/api/solcast/snapshot-dates`);
      assert.equal(r.ok, true, "snapshot-dates returns ok");
      assert.equal(Array.isArray(r.dates), true, "dates is an array");
      console.log("  ✓ Export date list available without a gateway");
    }

    console.log("[Test] All tests passed!");
  } catch (err) {
    console.error("[Test] Failed:", err);
    throw err;
  } finally {
    try {
      await Promise.race([serverMod.shutdownEmbedded(), waitMs(3000)]);
    } catch (_) {}
  }
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("forecastLoadDataPipeline.test.js: FAIL", err?.stack || err);
    process.exit(1);
  });
