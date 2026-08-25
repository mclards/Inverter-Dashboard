"use strict";

/**
 * calibrationSession recovery semantics — the pre-conditions the route
 * /api/calibration/session/start relies on when it auto-recovers from a
 * stuck session (server/calibrationRoutes.js).
 *
 * Locks the contract that:
 *   • begin() throws when a session is already active.
 *   • abortAll() unconditionally clears the in-memory session so a
 *     subsequent begin() succeeds (same OR different target).
 *   • isActive() / currentSession() reflect the state correctly.
 *   • The recovery is safe to fire BEFORE the watchdog tick (we don't
 *     have to wait for it).
 *
 * These guarantees are what the route layer wraps in two safe cases:
 *   (a) operator restarts the SAME (inverter, slave)         → abortAll then begin.
 *   (b) existing session is past its idle window (stale)     → abortAll then begin.
 *
 * Pure-JS, no Express / no DB needed.
 */

const assert = require("assert");

function fresh() {
  // The module keeps a singleton _session — load it fresh each test so
  // state from a previous test can't leak.
  delete require.cache[require.resolve("../calibrationSession")];
  return require("../calibrationSession");
}

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error(err.stack || err);
    process.exitCode = 1;
  }
}

function run() {
  test("begin: creates a session and reflects in isActive/currentSession", () => {
    const cs = fresh();
    assert.strictEqual(cs.isActive(), false);
    cs.begin({ inverter: 1, slave: 2, operator: "op1" });
    assert.strictEqual(cs.isActive(), true);
    const s = cs.currentSession();
    assert.strictEqual(s.inverter, 1);
    assert.strictEqual(s.slave, 2);
    assert.strictEqual(s.operator, "op1");
    // Cleanup so other tests in same process start clean.
    cs.abortAll("teardown");
  });

  test("second begin() throws SESSION_ACTIVE", () => {
    const cs = fresh();
    cs.begin({ inverter: 1, slave: 2, operator: "op1" });
    let threw = false;
    try {
      cs.begin({ inverter: 1, slave: 2, operator: "op2" });
    } catch (err) {
      threw = true;
      assert.strictEqual(err.code, "SESSION_ACTIVE");
      assert.ok(err.active);
      assert.strictEqual(err.active.inverter, 1);
    }
    assert.strictEqual(threw, true, "begin() must throw when session is active");
    cs.abortAll("teardown");
  });

  test("abortAll then begin: same target succeeds (route case A)", () => {
    const cs = fresh();
    cs.begin({ inverter: 1, slave: 2, operator: "op1" });
    cs.abortAll("operator_restart");
    assert.strictEqual(cs.isActive(), false, "abortAll must clear in-memory session");
    cs.begin({ inverter: 1, slave: 2, operator: "op1" });
    assert.strictEqual(cs.isActive(), true);
    assert.strictEqual(cs.currentSession().inverter, 1);
    assert.strictEqual(cs.currentSession().slave, 2);
    cs.abortAll("teardown");
  });

  test("abortAll then begin: different target succeeds (route case B)", () => {
    const cs = fresh();
    cs.begin({ inverter: 1, slave: 2, operator: "op1" });
    cs.abortAll("stale_takeover");
    cs.begin({ inverter: 3, slave: 4, operator: "op2" });
    assert.strictEqual(cs.currentSession().inverter, 3);
    assert.strictEqual(cs.currentSession().slave, 4);
    cs.abortAll("teardown");
  });

  test("currentSession idle_ms / idle_timeout_ms surface for route's staleness check", () => {
    const cs = fresh();
    cs.begin({ inverter: 1, slave: 2, operator: "op1" });
    const snap = cs.currentSession();
    assert.ok(Number.isFinite(snap.idle_ms), "idle_ms must be a number");
    assert.ok(snap.idle_ms >= 0);
    assert.ok(Number.isFinite(snap.idle_timeout_ms), "idle_timeout_ms must be a number");
    assert.ok(snap.idle_timeout_ms > 0);
    cs.abortAll("teardown");
  });

  test("heartbeat updates last_heartbeat_ms so idle_ms shrinks back to ~0", () => {
    const cs = fresh();
    const begin = cs.begin({ inverter: 1, slave: 2, operator: "op1" });
    // Sleep a few ms by busy loop so idle_ms accumulates measurably.
    const t0 = Date.now();
    while (Date.now() - t0 < 15) { /* spin */ }
    const beforeHb = cs.currentSession().idle_ms;
    assert.ok(beforeHb >= 10, `idle_ms expected ≥ 10, got ${beforeHb}`);
    const hb = cs.heartbeat(begin.session_id);
    assert.strictEqual(hb.ok, true);
    const afterHb = cs.currentSession().idle_ms;
    assert.ok(afterHb < beforeHb, `idle_ms should drop after heartbeat (before=${beforeHb}, after=${afterHb})`);
    cs.abortAll("teardown");
  });

  test("abortAll on no-session is a noop (route can call it unconditionally)", () => {
    const cs = fresh();
    const r = cs.abortAll("anything");
    assert.strictEqual(r.aborted, false);
    assert.strictEqual(cs.isActive(), false);
  });

  console.log("calibrationSessionRecovery.test.js: done");
}

run();
