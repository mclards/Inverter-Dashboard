"use strict";

/**
 * Slice δ TDD — APC closed-loop verifier (server/apcVerify.js).
 *
 * The verifier reads the most recent inverter_5min_param row and compares
 * the observed PAC against the requested setpoint. We test the pure
 * classification + decode logic; the full schedule loop is tested with an
 * injected fake setTimeout to avoid wall-clock waits.
 */

const assert = require("assert");
delete require.cache[require.resolve("../apcVerify")];
const { ApcVerifier, DEFAULT_DELAY_MS, DEFAULT_TOLERANCE_PCT } = require("../apcVerify");

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    process.exitCode = 1;
  }
}

console.log("\n  apcVerifyCore.test.js — Slice δ\n");

test("constants exposed", () => {
  assert.strictEqual(typeof DEFAULT_DELAY_MS, "number");
  assert.strictEqual(typeof DEFAULT_TOLERANCE_PCT, "number");
});

test("_decodeRow handles null row → all nulls", () => {
  const v = new ApcVerifier();
  const r = v._decodeRow(null, 249.41, 0);
  assert.strictEqual(r.observed_pct, null);
  assert.strictEqual(r.bit1_active, null);
  assert.ok(r.sample_age_ms === Infinity);
});

test("_decodeRow handles full row → observed_pct", () => {
  const v = new ApcVerifier();
  const now = 10_000;
  const row = { ts_ms: 9_000, pac_w: 124_705, pwr_red_bits: 0b10 }; // bit 1 set
  const r = v._decodeRow(row, 249.41, now);
  // pac_w / (249.41 × 1000) × 100 = 124705 / 249410 × 100 = 50.0
  assert.ok(Math.abs(r.observed_pct - 50.0) < 0.01, `expected ≈50, got ${r.observed_pct}`);
  assert.strictEqual(r.bit1_active, 1);
  assert.strictEqual(r.sample_age_ms, 1_000);
});

test("_decodeRow handles bit 1 = 0 explicitly", () => {
  const v = new ApcVerifier();
  const r = v._decodeRow({ ts_ms: 1, pac_w: 100, pwr_red_bits: 0b1 }, 1, 1);
  assert.strictEqual(r.bit1_active, 0);
});

test("_decodeRow handles missing pwr_red_bits → null", () => {
  const v = new ApcVerifier();
  const r = v._decodeRow({ ts_ms: 1, pac_w: 100 }, 1, 1);
  assert.strictEqual(r.bit1_active, null);
});

test("_classify returns 'no_response' when observed_pct null", () => {
  const v = new ApcVerifier();
  assert.strictEqual(v._classify(75, null, 1, 1000), "no_response");
});

test("_classify returns 'ok' when observed within tolerance", () => {
  const v = new ApcVerifier({ tolerancePct: 5 });
  // requested 50, observed 52 → dev 2 ≤ 5 → ok (with bit 1 active)
  assert.strictEqual(v._classify(50, 52, 1, 1000), "ok");
});

test("_classify returns 'mismatch' when observed exceeds tolerance", () => {
  const v = new ApcVerifier({ tolerancePct: 2 });
  assert.strictEqual(v._classify(50, 60, 1, 1000), "mismatch");
});

test("_classify returns 'mismatch' when within tolerance but bit 1 explicitly 0 for non-100% setpoint", () => {
  const v = new ApcVerifier({ tolerancePct: 5 });
  assert.strictEqual(v._classify(50, 51, 0, 1000), "mismatch");
});

test("_classify returns 'ok' when within tolerance and requested = 100% (bit 1 not required)", () => {
  const v = new ApcVerifier({ tolerancePct: 5 });
  assert.strictEqual(v._classify(100, 99, 0, 1000), "ok");
  assert.strictEqual(v._classify(100, 99, null, 1000), "ok");
});

test("scheduleVerify inserts pending row + schedules timer", () => {
  const log = [];
  const fakeTimer = (cb, ms) => { log.push(["scheduled", ms]); return { unref: () => {} }; };
  const v = new ApcVerifier({
    insertApcVerifyLog: (row) => log.push(["insert", row.result, row.requested_pct]),
    setTimeoutFn: fakeTimer,
  });
  v.scheduleVerify({ inverter_ip: "1.1.1.1", slave: 1, requested_pct: 75, rated_kw: 249.41 });
  assert.ok(log.some(l => l[0] === "insert" && l[1] === "pending" && l[2] === 75), "expected pending row insert");
  assert.ok(log.some(l => l[0] === "scheduled"), "expected timer schedule");
});

test("scheduleVerify cancels prior pending verify for same node (anti-thrash)", () => {
  const cancelled = [];
  const fakeTimer = (cb, ms) => { return { unref: () => {}, _id: Math.random() }; };
  // We can't easily observe clearTimeout with the fake, but the public symptom
  // is that pendingByKey.size stays at 1 after multiple schedule calls.
  const v = new ApcVerifier({
    insertApcVerifyLog: () => {},
    setTimeoutFn: fakeTimer,
  });
  v.scheduleVerify({ inverter_ip: "1.1.1.1", slave: 1, requested_pct: 50, rated_kw: 249.41 });
  v.scheduleVerify({ inverter_ip: "1.1.1.1", slave: 1, requested_pct: 75, rated_kw: 249.41 });
  v.scheduleVerify({ inverter_ip: "1.1.1.1", slave: 2, requested_pct: 80, rated_kw: 249.41 });
  assert.strictEqual(v.pendingByKey.size, 2, "two unique nodes should be pending");
});

test("scheduleVerify with missing required args returns null", () => {
  const v = new ApcVerifier({ insertApcVerifyLog: () => {}, setTimeoutFn: () => ({ unref: () => {} }) });
  assert.strictEqual(v.scheduleVerify({}), null);
  assert.strictEqual(v.scheduleVerify({ inverter_ip: "x" }), null);
  assert.strictEqual(v.scheduleVerify({ inverter_ip: "x", slave: 1 }), null);
});

test("end-to-end: scheduleVerify → fired → ok result", () => {
  const log = [];
  let firedCb = null;
  const fakeTimer = (cb) => { firedCb = cb; return { unref: () => {} }; };
  const v = new ApcVerifier({
    db: {
      prepare: () => ({
        get: () => ({ ts_ms: Date.now(), pac_w: 124_705, pwr_red_bits: 0b10 }), // 50% of 249.41 kW
      }),
    },
    insertApcVerifyLog: (row) => log.push(row),
    setTimeoutFn: fakeTimer,
    delayMs: 0,
  });
  v.scheduleVerify({ inverter_ip: "10.0.0.1", slave: 1, requested_pct: 50, rated_kw: 249.41 });
  assert.ok(firedCb, "timer callback should be set");
  firedCb();
  // First insert is "pending", second is the verify result
  const final = log[log.length - 1];
  assert.strictEqual(final.result, "ok");
  assert.ok(Math.abs(final.observed_pct - 50.0) < 0.5);
  assert.strictEqual(final.bit1_active, 1);
});

test("end-to-end: stale sample (older than 5 min) → no_response", () => {
  const log = [];
  let firedCb = null;
  const fakeTimer = (cb) => { firedCb = cb; return { unref: () => {} }; };
  const v = new ApcVerifier({
    db: {
      prepare: () => ({
        get: () => ({ ts_ms: Date.now() - 10 * 60_000, pac_w: 100, pwr_red_bits: 0 }),
      }),
    },
    insertApcVerifyLog: (row) => log.push(row),
    setTimeoutFn: fakeTimer,
    delayMs: 0,
  });
  v.scheduleVerify({ inverter_ip: "x", slave: 1, requested_pct: 75, rated_kw: 249.41 });
  firedCb();
  assert.strictEqual(log[log.length - 1].result, "no_response");
});

test("end-to-end: timeout when current time exceeds timeoutMs", () => {
  const log = [];
  let firedCb = null;
  const fakeTimer = (cb) => { firedCb = cb; return { unref: () => {} }; };
  let currentNow = 1_000_000;
  const v = new ApcVerifier({
    insertApcVerifyLog: (row) => log.push(row),
    setTimeoutFn: fakeTimer,
    now: () => currentNow,
    timeoutMs: 5_000,
    delayMs: 0,
  });
  v.scheduleVerify({ inverter_ip: "x", slave: 1, requested_pct: 75, rated_kw: 249.41 });
  // Advance the clock past timeout BEFORE firing
  currentNow += 10_000;
  firedCb();
  assert.strictEqual(log[log.length - 1].result, "timeout");
});
