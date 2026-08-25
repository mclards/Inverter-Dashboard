"use strict";
/**
 * smoke-all.js — Comprehensive Automated Smoke & Integration Test Suite
 * Tests all core subsystems, REST APIs, static assets, and WebSocket streams.
 */

const http = require("http");
const path = require("path");
const fs = require("fs");
const { WebSocket } = require("ws");
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const compression = require("compression");

const dbManager = require("../core/db");
const DeviceRegistry = require("../core/deviceRegistry");
const ControlArbiter = require("../core/controlArbiter");
const websocketHub = require("../core/websocket");

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(compression());
app.use(express.json());

const deviceRegistry = new DeviceRegistry(dbManager.db);
const controlArbiter = new ControlArbiter({
  defaultLeaseSec: 30,
  onLockChange: (status) => websocketHub.broadcastLockState(status)
});
websocketHub.init(server);

app.use("/api/device", require("../api/devices")(deviceRegistry));
app.use("/api/control", require("../api/control")(controlArbiter, dbManager));
app.use("/api/config", require("../api/config")(dbManager));
app.use("/api/telemetry", require("../api/telemetry")(dbManager, websocketHub));
app.use("/api", require("../api/telemetry")(dbManager, websocketHub));
app.use("/api/forecast", require("../api/forecast")(dbManager));

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    name: "ADSI Inverter Dashboard 2.0",
    version: "2.0.0",
    serverTime: new Date().toISOString(),
    connectedClients: websocketHub.getConnectedCount(),
    controlStatus: controlArbiter.getLockStatus()
  });
});

const frontendPublic = path.join(__dirname, "..", "..", "frontend", "public");
app.use(express.static(frontendPublic));

const TEST_PORT = 3596;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

let passedCount = 0;
let failedCount = 0;

function assert(condition, testName) {
  if (condition) {
    console.log(`  ✅ PASS: ${testName}`);
    passedCount++;
  } else {
    console.error(`  ❌ FAIL: ${testName}`);
    failedCount++;
  }
}

async function runTests() {
  console.log("================================================================");
  console.log("  ADSI INVERTER DASHBOARD 2.0 — COMPREHENSIVE SMOKE TEST");
  console.log("================================================================\n");

  server.listen(TEST_PORT, "127.0.0.1", async () => {
    try {
      // ── Group 1: Core Health & Info ──────────────────────────────
      console.log("[1/6] Testing Core Server Health & Network Discovery...");
      const health = await (await fetch(`${BASE_URL}/api/health`)).json();
      assert(health.ok === true && health.version === "2.0.0", "GET /api/health returns 2.0.0");

      const connectUrls = await (await fetch(`${BASE_URL}/api/config/connect-urls`)).json();
      assert(connectUrls.ok === true && Array.isArray(connectUrls.urls) && connectUrls.urls.length > 0, "GET /api/config/connect-urls enumerates reachable IPs");

      // ── Group 2: Device Identity & Multi-Controller Registry ──────
      console.log("\n[2/6] Testing Multi-User Device Identity & Personalization...");
      const reg = await (await fetch(`${BASE_URL}/api/device/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceId: "smoke-dev-001",
          deviceName: "Lead Engineer Workstation",
          operatorName: "Engr. Clariden"
        })
      })).json();
      assert(reg.ok === true && reg.device?.operatorName === "Engr. Clariden", "POST /api/device/register registers controller");

      const pref = await (await fetch(`${BASE_URL}/api/device/preferences`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Device-Id": "smoke-dev-001" },
        body: JSON.stringify({ preferences: { theme: "solar", layoutZoom: 1.1 } })
      })).json();
      assert(pref.ok === true && pref.preferences?.theme === "solar", "POST /api/device/preferences saves personal theme");

      const devList = await (await fetch(`${BASE_URL}/api/device/list`)).json();
      assert(devList.ok === true && devList.devices.some(d => d.device_id === "smoke-dev-001"), "GET /api/device/list returns registered controllers");

      // ── Group 3: Single-Writer Inverter Control Arbitration ──────
      console.log("\n[3/6] Testing Single-Writer Inverter Control Arbitration...");
      const leaseA = await (await fetch(`${BASE_URL}/api/control/acquire`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Device-Id": "smoke-dev-001", "X-Operator-Name": "Engr. Clariden" },
        body: JSON.stringify({ durationSec: 30 })
      })).json();
      assert(leaseA.ok === true && leaseA.leaseGranted === true, "POST /api/control/acquire grants control lease to Device A");

      // Device B attempts to acquire control concurrently -> Must be rejected with HTTP 423
      const leaseBRes = await fetch(`${BASE_URL}/api/control/acquire`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Device-Id": "smoke-dev-002", "X-Operator-Name": "Shift Tech" },
        body: JSON.stringify({ durationSec: 30 })
      });
      assert(leaseBRes.status === 423, "POST /api/control/acquire rejects concurrent Device B with HTTP 423 Locked");

      const releaseA = await (await fetch(`${BASE_URL}/api/control/release`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Device-Id": "smoke-dev-001" }
      })).json();
      assert(releaseA.ok === true && releaseA.released === true, "POST /api/control/release releases lease cleanly");

      // ── Group 4: Telemetry, Settings, and Topology ───────────────
      console.log("\n[4/6] Testing Telemetry & Authoritative Settings...");
      const live = await (await fetch(`${BASE_URL}/api/live`)).json();
      assert(live.ok === true && typeof live.timestamp === "number", "GET /api/live returns active telemetry structure");

      const energy5min = await (await fetch(`${BASE_URL}/api/energy/5min`)).json();
      assert(energy5min.ok === true && Array.isArray(energy5min.data), "GET /api/energy/5min queries database without errors");

      const settingsSave = await (await fetch(`${BASE_URL}/api/config/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Device-Id": "smoke-dev-001" },
        body: JSON.stringify({ plantName: "ADSI Solar Farm 2.0", inverterCount: "27" })
      })).json();
      assert(settingsSave.ok === true, "POST /api/config/settings persists settings to server database");

      const settingsGet = await (await fetch(`${BASE_URL}/api/config/settings`)).json();
      assert(settingsGet.ok === true && settingsGet.settings?.plantName === "ADSI Solar Farm 2.0", "GET /api/config/settings reads persisted settings");

      // ── Group 5: Static Assets & CSS/JS Integrity ────────────────
      console.log("\n[5/6] Testing Static Assets & Frontend Files...");
      const htmlRes = await fetch(`${BASE_URL}/`);
      assert(htmlRes.status === 200 && (await htmlRes.text()).includes("ADSI Inverter Dashboard"), "GET / serves index.html");

      const cssRes = await fetch(`${BASE_URL}/css/style.css`);
      assert(cssRes.status === 200 && (await cssRes.text()).length > 1000, "GET /css/style.css serves responsive stylesheet");

      const appJsRes = await fetch(`${BASE_URL}/js/app.js`);
      assert(appJsRes.status === 200 && (await appJsRes.text()).includes("installFetchInterceptor"), "GET /js/app.js serves frontend app with fetch interceptor");

      // ── Group 6: Real-Time WebSocket Hub ─────────────────────────
      console.log("\n[6/6] Testing WebSocket Telemetry & Lock Broadcasts...");
      await new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/ws?deviceId=smoke-dev-001&operatorName=Clariden`);
        let pingPassed = false;
        let welcomePassed = false;

        ws.on("open", () => {
          ws.send(JSON.stringify({ type: "ping" }));
        });

        ws.on("message", (raw) => {
          try {
            const msg = JSON.parse(raw);
            if (msg.type === "welcome") {
              welcomePassed = true;
            }
            if (msg.type === "pong") {
              pingPassed = true;
              assert(welcomePassed && pingPassed, "WebSocket connects, authenticates device, and responds to ping/pong");
              ws.close();
              resolve();
            }
          } catch (_) {}
        });

        setTimeout(() => {
          if (!pingPassed) {
            assert(false, "WebSocket timed out waiting for response");
            ws.terminate();
            resolve();
          }
        }, 3000);
      });

      console.log("\n================================================================");
      console.log(`  SMOKE TEST SUMMARY: ${passedCount} PASSED, ${failedCount} FAILED`);
      console.log("================================================================");

    } catch (err) {
      console.error("\n[CRITICAL ERROR DURING TESTS]:", err);
      failedCount++;
    } finally {
      server.close();
      dbManager.db.close();
      process.exit(failedCount > 0 ? 1 : 0);
    }
  });
}

runTests();
