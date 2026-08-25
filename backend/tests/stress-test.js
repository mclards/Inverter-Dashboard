"use strict";
/**
 * stress-test.js — High-Concurrency & Multi-Controller Mutex Stress Test Suite
 */

const http = require("http");
const { WebSocket } = require("ws");
const express = require("express");
const cors = require("cors");

const dbManager = require("../core/db");
const DeviceRegistry = require("../core/deviceRegistry");
const ControlArbiter = require("../core/controlArbiter");
const websocketHub = require("../core/websocket");

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

const deviceRegistry = new DeviceRegistry(dbManager.db);
const controlArbiter = new ControlArbiter({
  defaultLeaseSec: 2,
  onLockChange: (status) => websocketHub.broadcastLockState(status)
});
websocketHub.init(server);

app.use("/api/device", require("../api/devices")(deviceRegistry));
app.use("/api/control", require("../api/control")(controlArbiter, dbManager));
app.use("/api/config", require("../api/config")(dbManager));

const TEST_PORT = 3594;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

async function runStress() {
  console.log("================================================================");
  console.log("  ADSI INVERTER DASHBOARD 2.0 — STRESS & CONCURRENCY TEST");
  console.log("================================================================\n");

  server.listen(TEST_PORT, "127.0.0.1", async () => {
    try {
      // ── Test 1: 50 Rapid Database Writes in WAL Mode ──────────────
      console.log("[1/3] Testing 50 Concurrent SQLite WAL Writes & Preference Updates...");
      const writePromises = [];
      for (let i = 1; i <= 50; i++) {
        writePromises.push(
          fetch(`${BASE_URL}/api/device/register`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              deviceId: `stress-operator-${i}`,
              deviceName: `Operator Workstation #${i}`,
              operatorName: `Engineer ${i}`
            })
          }).then(r => r.json())
        );
      }
      const writeResults = await Promise.all(writePromises);
      const allSuccess = writeResults.every(r => r.ok === true);
      if (allSuccess) {
        console.log("  ✅ PASS: 50 concurrent SQLite writes completed with 0 errors.");
      } else {
        throw new Error("Some concurrent writes failed!");
      }

      // ── Test 2: Multi-Operator Inverter Lock Contention ───────────
      console.log("\n[2/3] Testing Inverter Control Lock Contention & Rejection...");
      // Operator 1 claims lease
      const acq1 = await (await fetch(`${BASE_URL}/api/control/acquire`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Device-Id": "stress-operator-1", "X-Operator-Name": "Engineer 1" },
        body: JSON.stringify({ durationSec: 2 })
      })).json();
      if (!acq1.leaseGranted) throw new Error("Operator 1 failed to acquire lease");
      console.log("  ✅ PASS: Operator 1 acquired 2-second exclusive control lease.");

      // Operators 2 through 10 try to acquire at the same time -> All must receive 423
      const clashPromises = [];
      for (let i = 2; i <= 10; i++) {
        clashPromises.push(
          fetch(`${BASE_URL}/api/control/acquire`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Device-Id": `stress-operator-${i}`, "X-Operator-Name": `Engineer ${i}` },
            body: JSON.stringify({ durationSec: 2 })
          })
        );
      }
      const clashResults = await Promise.all(clashPromises);
      const allBlocked = clashResults.every(r => r.status === 423);
      if (allBlocked) {
        console.log("  ✅ PASS: 9 concurrent conflicting operators successfully blocked (HTTP 423).");
      } else {
        throw new Error("Lock safety failure: Conflicting operator was not blocked!");
      }

      // ── Test 3: Auto-Expiration & Mutex Hand-off ─────────────────
      console.log("\n[3/3] Testing 2-Second Sliding Mutex Auto-Expiration...");
      console.log("  ⏳ Waiting 2.2 seconds for Operator 1's lease to expire naturally...");
      await new Promise(r => setTimeout(r, 2200));

      // Operator 2 now attempts to acquire -> Must succeed
      const acq2 = await (await fetch(`${BASE_URL}/api/control/acquire`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Device-Id": "stress-operator-2", "X-Operator-Name": "Engineer 2" },
        body: JSON.stringify({ durationSec: 2 })
      })).json();

      if (acq2.leaseGranted && acq2.activeLock.deviceId === "stress-operator-2") {
        console.log("  ✅ PASS: Lease auto-expired cleanly and was handed off to Operator 2.");
      } else {
        throw new Error("Auto-expiration failed!");
      }

      console.log("\n================================================================");
      console.log("  ALL STRESS & CONCURRENCY TESTS PASSED 100%!");
      console.log("================================================================");

    } catch (err) {
      console.error("\n❌ STRESS TEST FAILED:", err);
      process.exit(1);
    } finally {
      server.close();
      dbManager.db.close();
      process.exit(0);
    }
  });
}

runStress();
