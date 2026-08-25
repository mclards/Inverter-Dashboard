"use strict";

/**
 * gridControlVerifierCore.test.js — pure-orchestration tests for
 * gridControlVerifier.scheduleVerify + _classify.
 * Plan: plans/2026-05-12-ppc-capabilities-implementation.md §4
 */

const assert = require("assert");

delete require.cache[require.resolve("../gridControlVerifier")];
const { GridControlVerifier, DEFAULT_TOLERANCE_RAW } = require("../gridControlVerifier");

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) { console.error(`  ✗ ${name}`); console.error(`    ${err.message}`); process.exitCode = 1; }
}
async function asyncTest(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (err) { console.error(`  ✗ ${name}`); console.error(`    ${err.message}`); process.exitCode = 1; }
}

function makeMockDeps(readResult = { ok: true, phi_tangent_raw: 0, reactive_raw: 0 }) {
  const logRows = [];
  const broadcasts = [];
  const timers = [];
  let nowMs = 0;
  const deps = {
    readGridState: async () => readResult,
    insertVerifyLog: (row) => logRows.push(row),
    broadcast: (event, payload) => broadcasts.push({ event, payload }),
    now: () => nowMs,
    setTimeoutFn: (fn, delay) => {
      const handle = { fn, delay };
      timers.push(handle);
      // Return an unrefable handle so the real verifier doesn't crash on .unref()
      return { unref: () => {}, _handle: handle };
    },
    delayMs: 100,
    timeoutMs: 1000,
    toleranceRaw: DEFAULT_TOLERANCE_RAW,
  };
  return { deps, logRows, broadcasts, timers, advance: (ms) => { nowMs += ms; } };
}

function run() {
  console.log("\n──────────────────────────────────────────────────────────");
  console.log("  gridControlVerifierCore.test.js");
  console.log("──────────────────────────────────────────────────────────\n");

  // ── classification matrix ─────────────────────────────────────────────────
  test("_classify ok when phi raw within tolerance", () => {
    const v = new GridControlVerifier({ insertVerifyLog: () => {} });
    const r = v._classify({ kind: "phi", raw: 10000 }, { ok: true, phi_tangent_raw: 10100 });
    assert.strictEqual(r, "ok");
  });

  test("_classify mismatch when phi raw beyond tolerance", () => {
    const v = new GridControlVerifier({ insertVerifyLog: () => {} });
    const r = v._classify({ kind: "phi", raw: 10000 }, { ok: true, phi_tangent_raw: 12000 });
    assert.strictEqual(r, "mismatch");
  });

  test("_classify sign-casts UInt16 read-back to Int16", () => {
    // raw -10000 = 0xD8F0 = 55536 unsigned. Verifier must decode as -10000.
    const v = new GridControlVerifier({ insertVerifyLog: () => {} });
    const r = v._classify({ kind: "phi", raw: -10000 }, { ok: true, phi_tangent_raw: 55536 });
    assert.strictEqual(r, "ok");
  });

  test("_classify ok on disable when both regs ≈ 0", () => {
    const v = new GridControlVerifier({ insertVerifyLog: () => {} });
    const r = v._classify({ kind: "disable" }, { ok: true, phi_tangent_raw: 5, reactive_raw: -2 });
    assert.strictEqual(r, "ok");
  });

  test("_classify mismatch on disable when phi still set", () => {
    const v = new GridControlVerifier({ insertVerifyLog: () => {} });
    const r = v._classify({ kind: "disable" }, { ok: true, phi_tangent_raw: 9000, reactive_raw: 0 });
    assert.strictEqual(r, "mismatch");
  });

  test("_classify no_response when read failed", () => {
    const v = new GridControlVerifier({ insertVerifyLog: () => {} });
    const r = v._classify({ kind: "phi", raw: 1000 }, { ok: false, error: "timeout" });
    assert.strictEqual(r, "no_response");
  });

  // ── schedule + log flow ───────────────────────────────────────────────────
  test("scheduleVerify rejects bad args", () => {
    const { deps } = makeMockDeps();
    const v = new GridControlVerifier(deps);
    assert.strictEqual(v.scheduleVerify(null), null);
    assert.strictEqual(v.scheduleVerify({ inverter_ip: "1.1.1.1", slave: null, kind: "phi" }), null);
    assert.strictEqual(v.scheduleVerify({ inverter_ip: "1.1.1.1", slave: 1, kind: "garbage" }), null);
  });

  test("scheduleVerify inserts pending row + queues timer", () => {
    const { deps, logRows, broadcasts, timers } = makeMockDeps();
    const v = new GridControlVerifier(deps);
    const key = v.scheduleVerify({ inverter_ip: "10.0.0.5", slave: 2, kind: "phi", raw: 1234, operator: "ops" });
    assert.strictEqual(key, "10.0.0.5/2");
    assert.strictEqual(logRows.length, 1);
    assert.strictEqual(logRows[0].result, "pending");
    assert.strictEqual(logRows[0].kind, "phi");
    assert.strictEqual(logRows[0].requested_raw, 1234);
    assert.strictEqual(broadcasts.length, 1);
    assert.strictEqual(broadcasts[0].event, "grid_control:verify");
    assert.strictEqual(broadcasts[0].payload.status, "pending");
    assert.strictEqual(timers.length, 1);
  });

  test("newest write cancels prior pending verify (no double-fire)", () => {
    const { deps, timers } = makeMockDeps();
    const v = new GridControlVerifier(deps);
    v.scheduleVerify({ inverter_ip: "1.1.1.1", slave: 1, kind: "phi", raw: 100 });
    const firstTimer = timers[0];
    v.scheduleVerify({ inverter_ip: "1.1.1.1", slave: 1, kind: "phi", raw: 200 });
    assert.strictEqual(timers.length, 2);
    // We can't observe clearTimeout in our mock cleanly without instrumenting it,
    // but we can confirm the pendingByKey map only points to the latest.
    const pending = v.pendingByKey.get("1.1.1.1/1");
    assert.strictEqual(pending.raw, 200);
  });

  asyncTest("end-to-end verify: ok result logged + broadcast", async () => {
    const { deps, logRows, broadcasts, timers, advance } = makeMockDeps({
      ok: true, phi_tangent_raw: 5050, reactive_raw: 0,
    });
    const v = new GridControlVerifier(deps);
    v.scheduleVerify({ inverter_ip: "9.9.9.9", slave: 1, kind: "phi", raw: 5000 });
    advance(100);
    // Manually invoke the captured fn (mock does not auto-fire).
    await timers[0].fn();
    const completed = logRows.find(r => r.result === "ok");
    assert.ok(completed, `expected an 'ok' row, got: ${JSON.stringify(logRows)}`);
    assert.strictEqual(completed.observed_raw, 5050);
    const okBroadcast = broadcasts.find(b => b.payload.status === "ok");
    assert.ok(okBroadcast);
  });

  asyncTest("end-to-end verify: timeout when elapsed > timeoutMs", async () => {
    const { deps, logRows, timers, advance } = makeMockDeps();
    deps.timeoutMs = 500;
    const v = new GridControlVerifier(deps);
    v.scheduleVerify({ inverter_ip: "9.9.9.9", slave: 1, kind: "reactive", raw: 100 });
    advance(2000);  // > timeoutMs
    await timers[0].fn();
    const timedOut = logRows.find(r => r.result === "timeout");
    assert.ok(timedOut);
  });

  console.log(
    process.exitCode === 1
      ? "\n  ✗ gridControlVerifierCore tests FAILED\n"
      : "\n  ✓ gridControlVerifierCore tests passed\n",
  );
}

run();
