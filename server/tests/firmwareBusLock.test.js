"use strict";

// Source-of-truth test for the Node (consumer) side of the cross-process
// firmware-flash bus lock (server/firmwareBusLock.js). The poller reads
// this to suppress a false comms outage while the calibrator flashes an
// inverter. The pure `_parseClaims` filter is the safety-critical core:
// it must be FAIL-OPEN — anything that isn't an unambiguous, unexpired
// claim must be dropped, never silencing live polling on bad input.
//
// Pure static — does NOT load better-sqlite3 (mirrors firmwareMap /
// serialBulkMap), so it runs under both Node-ABI and Electron-ABI builds.

const assert = require("assert");
const { _parseClaims, activeInverterIps } = require("../firmwareBusLock");

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}: ${err.message}`);
    process.exitCode = 1;
  }
}

const NOW = 1_000_000;

check("active vs expired claims are filtered by expires_ms", () => {
  const raw = { claims: [
    { inverter_ip: "192.168.1.101", node: 1, slave: 1, job_id: "a", expires_ms: NOW + 1 },
    { inverter_ip: "192.168.1.102", node: 2, slave: 2, job_id: "b", expires_ms: NOW - 1 },
  ] };
  const active = _parseClaims(raw, NOW);
  assert.strictEqual(active.length, 1);
  assert.strictEqual(active[0].inverter_ip, "192.168.1.101");
  assert.strictEqual(active[0].node, 1);
});

check("expires_ms exactly == now is NOT active (strictly greater)", () => {
  assert.strictEqual(
    _parseClaims({ claims: [{ inverter_ip: "x", expires_ms: NOW }] }, NOW).length, 0);
  assert.strictEqual(
    _parseClaims({ claims: [{ inverter_ip: "x", expires_ms: NOW + 1 }] }, NOW).length, 1);
});

check("multiple live claims all returned", () => {
  const raw = { claims: [
    { inverter_ip: "10.0.0.1", expires_ms: NOW + 5 },
    { inverter_ip: "10.0.0.2", expires_ms: NOW + 5 },
  ] };
  const ips = _parseClaims(raw, NOW).map((c) => c.inverter_ip).sort();
  assert.deepStrictEqual(ips, ["10.0.0.1", "10.0.0.2"]);
});

check("fail-open: missing ip / blank ip / no expiry are dropped", () => {
  const raw = { claims: [
    { expires_ms: NOW + 9 },                       // no ip
    { inverter_ip: "  ", expires_ms: NOW + 9 },     // blank ip
    { inverter_ip: "ok", expires_ms: "garbage" },   // unparseable expiry
    { inverter_ip: "ok2" },                         // no expiry -> 0 -> expired
  ] };
  assert.strictEqual(_parseClaims(raw, NOW).length, 0);
});

check("fail-open: non-object / wrong-shape inputs yield [] (never throws)", () => {
  for (const bad of [null, undefined, 0, "x", [], { claims: null }, { claims: "y" }, { claims: [1, "a", null] }]) {
    assert.deepStrictEqual(_parseClaims(bad, NOW), []);
  }
});

check("ip is trimmed; numeric fields coerced safely", () => {
  const raw = { claims: [
    { inverter_ip: " 192.168.1.5 ", node: "3", slave: "2", job_id: 7, expires_ms: NOW + 1 },
  ] };
  const c = _parseClaims(raw, NOW)[0];
  assert.strictEqual(c.inverter_ip, "192.168.1.5");
  assert.strictEqual(c.node, 3);
  assert.strictEqual(c.slave, 2);
  assert.strictEqual(c.job_id, "7");
});

check("activeInverterIps never throws and returns a Set (fail-open)", () => {
  // No marker file in the test env -> empty Set, no exception. This is the
  // contract the poller relies on to never be silenced by a bad/missing file.
  const s = activeInverterIps(NOW);
  assert.ok(s instanceof Set);
});

if (process.exitCode) {
  console.error(`\nfirmwareBusLock: FAILED (${passed} passed)`);
} else {
  console.log(`\nfirmwareBusLock: all ${passed} checks passed`);
}
