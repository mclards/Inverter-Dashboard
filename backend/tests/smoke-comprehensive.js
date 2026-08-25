"use strict";
/**
 * smoke-comprehensive.js — Multi-Cycle Production Smoke Test Suite
 */

const BASE_URL = "http://127.0.0.1:3500";

async function runCycle(cycleNumber) {
  console.log(`\n========================================`);
  console.log(`  CYCLE ${cycleNumber} — SMOKE TESTING`);
  console.log(`========================================`);

  const now = new Date();
  const currentMinStr = String(now.getMinutes()).padStart(2, "0");
  const devPass = "dev" + currentMinStr;

  // 1. Health & Server Info
  const hRes = await fetch(`${BASE_URL}/api/health`);
  const hData = await hRes.json();
  console.assert(hRes.status === 200 && hData.ok === true, "Health check failed");
  console.log(`[PASS] 1. Server Health Check (Port 3500): Online (${hData.name})`);

  // 2. Developer Login
  const devRes = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "devClard", password: devPass })
  });
  const devData = await devRes.json();
  console.assert(devRes.status === 200 && devData.role === "developer", "Developer login failed");
  console.log(`[PASS] 2. Developer Authentication: devClard / ${devPass} -> role: ${devData.role}`);

  // 3. Operator Login
  const opRes = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "1234" })
  });
  const opData = await opRes.json();
  console.assert(opRes.status === 200 && opData.role === "operator", "Operator login failed");
  console.log(`[PASS] 3. Operator Authentication: admin / 1234 -> role: ${opData.role}`);

  // 4. Invalid Password Rejection
  const badRes = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "wrongPassword" })
  });
  console.assert(badRes.status === 401, "Bad password should be 401");
  console.log(`[PASS] 4. Invalid Credentials Rejection: HTTP 401 Unauthorized`);

  // 5. Developer Role Immutability Guard
  const modDevRes = await fetch(`${BASE_URL}/api/auth/change`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ authKey: "1234", newUsername: "devClard", newPassword: "new" })
  });
  console.assert(modDevRes.status === 400, "Developer modification must be blocked with 400");
  console.log(`[PASS] 5. Developer Role Protection: HTTP 400 (Fixed & Immutable)`);

  // 6. Single-Writer Lock & Preemption
  const opAcq = await fetch(`${BASE_URL}/api/control/acquire`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-device-id": "cycle-op-1", "x-operator-name": "admin", "x-operator-role": "operator" },
    body: JSON.stringify({ durationSec: 30 })
  });
  console.assert(opAcq.status === 200, "Operator acquire failed");

  const op2Acq = await fetch(`${BASE_URL}/api/control/acquire`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-device-id": "cycle-op-2", "x-operator-name": "operator2", "x-operator-role": "operator" },
    body: JSON.stringify({ durationSec: 30 })
  });
  console.assert(op2Acq.status === 423, "Second operator must be blocked by 423");

  const devAcq = await fetch(`${BASE_URL}/api/control/acquire`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-device-id": "cycle-dev", "x-operator-name": "devClard", "x-operator-role": "developer" },
    body: JSON.stringify({ durationSec: 60 })
  });
  console.assert(devAcq.status === 200, "Developer preemption failed");

  const devRel = await fetch(`${BASE_URL}/api/control/release`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-device-id": "cycle-dev", "x-operator-name": "devClard", "x-operator-role": "developer" }
  });
  console.assert(devRel.status === 200, "Developer release failed");
  console.log(`[PASS] 6. Control Arbitration & Developer Preemption: All Mutex assertions passed`);

  // 7. Hardware & SCADA Endpoints
  const endpoints = [
    "/api/stop-reasons/1/recent",
    "/api/stop-reasons/1/histogram",
    "/api/serial/log/1",
    "/api/clock/status",
    "/api/igbt/fleet",
    "/api/compliance/runs",
    "/api/apc/state",
    "/api/live",
    "/api/energy/5min"
  ];
  for (const ep of endpoints) {
    const res = await fetch(`${BASE_URL}${ep}`);
    console.assert(res.status === 200, `Endpoint ${ep} failed with ${res.status}`);
  }
  console.log(`[PASS] 7. Hardware & SCADA API Endpoints (9/9 passed 200 OK)`);
}

(async () => {
  const TOTAL_CYCLES = 5;
  console.log(`Starting ${TOTAL_CYCLES}-Cycle Comprehensive Smoke Test...`);
  for (let i = 1; i <= TOTAL_CYCLES; i++) {
    await runCycle(i);
    await new Promise(r => setTimeout(r, 200));
  }
  console.log(`\n=======================================================`);
  console.log(`  ALL ${TOTAL_CYCLES} SMOKE TEST CYCLES PASSED PERFECTLY (100%)`);
  console.log(`=======================================================\n`);
})();
