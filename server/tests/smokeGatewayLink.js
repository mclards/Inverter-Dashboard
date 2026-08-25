"use strict";
// Smoke test for gateway link stability changes.
// Run with: node server/tests/smokeGatewayLink.js

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.NODE_ENV = "test";
if (!process.env.IM_PORTABLE_DATA_DIR) {
  process.env.IM_PORTABLE_DATA_DIR = fs.mkdtempSync(
    path.join(os.tmpdir(), "adsi-gateway-link-smoke-"),
  );
}
if (!process.env.ADSI_SERVER_PORT) process.env.ADSI_SERVER_PORT = "3510";
fs.mkdirSync(path.join(process.env.IM_PORTABLE_DATA_DIR, "config"), {
  recursive: true,
});
const BASE_URL = `http://127.0.0.1:${Number(process.env.ADSI_SERVER_PORT || 3510)}`;

const origListen = http.Server.prototype.listen;
let httpServer = null;
http.Server.prototype.listen = function (...args) {
  httpServer = this;
  return origListen.apply(this, args);
};

// Force gateway mode for the ETag test — the custom ETag path only activates
// in gateway mode (which is the production path the remote client hits).
const db = require("../db.js");
const origMode = db.getSetting("operationMode", "gateway");
if (origMode !== "gateway") {
  db.setSetting("operationMode", "gateway");
  console.log("[test] Temporarily set operationMode=gateway (was " + origMode + ")");
}

try {
  require("../index.js");
} catch (e) {
  console.log("LOAD_ERROR:", e.message);
  process.exit(1);
}

setTimeout(async () => {
  const results = [];
  function check(name, pass) {
    results.push(name + ": " + (pass ? "PASS" : "FAIL"));
  }

  try {
    // --- Gateway-side checks ---
    check("keepAliveTimeout=30000", httpServer?.keepAliveTimeout === 30000);
    check("headersTimeout=35000", httpServer?.headersTimeout === 35000);

    // GET /api/live — should return 200 with custom ETag
    const res1 = await fetch(`${BASE_URL}/api/live`);
    const etag = res1.headers.get("etag");
    const body1 = await res1.text();
    check("GET /api/live 200", res1.status === 200);
    check("ETag present", Boolean(etag));
    check("ETag is custom live-*", Boolean(etag && etag.startsWith('"live-')));
    check("Cache-Control no-cache", res1.headers.get("cache-control") === "no-cache");
    check("Body is valid JSON", body1.startsWith("{") || body1.startsWith("["));

    // Conditional GET with matching ETag — should return 304
    const res2 = await fetch(`${BASE_URL}/api/live`, {
      headers: { "If-None-Match": etag },
    });
    const body2 = await res2.text();
    check("Conditional GET 304", res2.status === 304);
    check("304 body empty", body2.length === 0);

    // Conditional GET with stale ETag — should return 200
    const res3 = await fetch(`${BASE_URL}/api/live`, {
      headers: { "If-None-Match": '"stale-etag"' },
    });
    await res3.text();
    check("Stale ETag gets 200", res3.status === 200);

    // --- Source-level constant checks ---
    const src = fs.readFileSync(
      path.join(__dirname, "..", "index.js"),
      "utf8",
    );
    const appSrc = fs.readFileSync(
      path.join(__dirname, "..", "..", "public", "js", "app.js"),
      "utf8",
    );
    check("Adaptive polling (latency*2)", src.includes("latency * 2"));
    check("Bridge interval 800ms", src.includes("const REMOTE_BRIDGE_INTERVAL_MS = 800"));
    check("Bridge warmup 8s", src.includes("const REMOTE_BRIDGE_WARMUP_MS = 8000"));
    check(
      "Viewer mode disables local fallback",
      src.includes("Viewer model: remote mode never falls back to local DB for historical reads.") &&
        src.includes("function shouldServeLocalFallback(pathname, nowTs = Date.now())") &&
        src.includes("return false;"),
    );
    check("Energy fetch stamps success only", src.includes("lastTodayEnergyFetchTs = ts"));
    check("Offline threshold 6", src.includes("FAILURES_BEFORE_OFFLINE = 6"));
    check("Sync threshold 10", src.includes("BEFORE_OFFLINE_DURING_SYNC = 10"));
    check("Degraded grace 60s", src.includes("DEGRADED_GRACE_MS = 60000"));
    check("Stale retention 180s", src.includes("STALE_RETENTION_MS = 180000"));
    check("Client keepAlive 15s", src.includes("KEEPALIVE_MSECS = 15000"));
    check("Live metric freshness 15s", src.includes("const LIVE_FRESH_MS = 15000"));
    check("ECONNABORTED retryable", src.includes("ECONNABORTED"));
    check("Energy fetch in-flight guard", src.includes("todayEnergyFetchInFlight"));
    check("Energy fetch session guard", src.includes("bridgeSessionId"));
    check(
      "Remote today-energy supplement uses live kWh",
      src.includes("computeTodayEnergyRowsFromLiveData(remoteBridgeState.liveData)"),
    );
    check("Server keepAliveTimeout set", src.includes("httpServer.keepAliveTimeout = 30000"));
    check(
      "Card PAC totals use displayed rows",
      appSrc.includes("summarizeLiveRows(unitsForDisplay)"),
    );
    check(
      "Detail today energy uses authoritative todayEnergyByInv state",
      // v2.9.1+ the kwh assignment became an energy-mode ternary (pac /
      // etotal / parce). Assert the authoritative pac-mode expression
      // is still present rather than the exact old single-line form.
      appSrc.includes("State.todayEnergyByInv[inv] ?? State.invDetailKwh"),
    );
    check(
      "Gateway live payload enriches todayEnergy",
      src.includes("setBroadcastPayloadEnricher((payload) => {") &&
        src.includes("const todayEnergy = Object.prototype.hasOwnProperty.call(payload, \"todayEnergy\")") &&
        src.includes("const enriched = { ...payload, todayEnergy };"),
    );
    check(
      "Gateway live payload enriches todaySummary",
      src.includes("todaySummary = buildCurrentDayEnergySnapshot({") ||
        src.includes("enriched.todaySummary = buildCurrentDayEnergySnapshot({"),
    );
    check(
      "Gateway live payload merges DB cache with live supplement",
      src.includes("function getTodayEnergyRowsForLivePayload(day = localDateStr())") &&
        src.includes("return mergeTodayEnergyRowsMax(cachedRows, liveRows);"),
    );
    check(
      "Client keeps WS todayEnergy authoritative once live",
      appSrc.includes("if (hasTodayMwhWsAuthority()) return false;"),
    );
    check(
      "Client accepts empty todayEnergy WS payloads",
      appSrc.includes("if (Array.isArray(msg.todayEnergy)) {") &&
        !appSrc.includes("if (Array.isArray(msg.todayEnergy) && msg.todayEnergy.length) {"),
    );
    check(
      "Client consumes live todaySummary",
      appSrc.includes("if (msg.todaySummary && typeof msg.todaySummary === \"object\") {") &&
        appSrc.includes("applyCurrentDaySummaryClient(msg.todaySummary, { source: \"ws\" });"),
    );
  } catch (e) {
    results.push("ERROR: " + e.message);
  }

  console.log("\n=== Gateway Link Stability Smoke Test ===\n");
  for (const r of results) console.log("  " + r);

  const failed = results.filter((r) => r.includes("FAIL"));
  console.log("\n" + results.length + " checks, " + failed.length + " failed");

  // Restore original operation mode
  if (origMode !== "gateway") {
    db.setSetting("operationMode", origMode);
    console.log("[test] Restored operationMode=" + origMode);
  }

  if (failed.length) {
    console.log("FAILURES:", failed.map((f) => f.split(":")[0]).join(", "));
    process.exit(1);
  } else {
    console.log("ALL SMOKE TESTS PASSED\n");
    process.exit(0);
  }
}, 3000);
