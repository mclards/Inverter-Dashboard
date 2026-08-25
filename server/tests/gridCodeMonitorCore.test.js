"use strict";

/**
 * gridCodeMonitorCore.test.js — pure-function tests for the grid-code monitor.
 *
 * Plan: plans/2026-05-12-ppc-capabilities-implementation.md §2
 */

const assert = require("assert");

delete require.cache[require.resolve("../gridCodeMonitor")];
const {
  GridCodeMonitor,
  _pfFromPq,
  _linearRegress,
  FRESH_WINDOW_MS,
} = require("../gridCodeMonitor");

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

function approxEq(a, b, tol = 1e-6) {
  assert.ok(
    Math.abs(Number(a) - Number(b)) <= tol,
    `expected ${a} ≈ ${b} (±${tol})`,
  );
}

function run() {
  console.log("\n──────────────────────────────────────────────────────────");
  console.log("  gridCodeMonitorCore.test.js — Grid Code Monitor pure math");
  console.log("──────────────────────────────────────────────────────────\n");

  // ── _pfFromPq ─────────────────────────────────────────────────────────────
  test("pfFromPq returns null for missing inputs", () => {
    assert.strictEqual(_pfFromPq(null, 100), null);
    assert.strictEqual(_pfFromPq(100, null), null);
    assert.strictEqual(_pfFromPq(NaN, 100), null);
  });

  test("pfFromPq returns 1.0 for pure active power", () => {
    approxEq(_pfFromPq(10_000, 0), 1.0);
    approxEq(_pfFromPq(-10_000, 0), 1.0); // unsigned PF
  });

  test("pfFromPq returns 0.0 for pure reactive", () => {
    approxEq(_pfFromPq(0.1, 10_000), 0, 1e-3);
  });

  test("pfFromPq matches 0.95 lag spec", () => {
    // tan(φ) = 0.329 → Q = P × 0.329. PF = 0.95 → both sides ~exact.
    const p = 10_000, q = p * 0.329;
    approxEq(_pfFromPq(p, q), 0.95, 0.01);
  });

  test("pfFromPq guards near-zero apparent power", () => {
    assert.strictEqual(_pfFromPq(0.5, 0.3), null);
  });

  // ── _linearRegress ───────────────────────────────────────────────────────
  test("linearRegress refuses < 3 points", () => {
    const r = _linearRegress([1, 2], [3, 4]);
    assert.strictEqual(r.slope, null);
  });

  test("linearRegress recovers known slope", () => {
    // y = 2x + 1
    const xs = [0, 1, 2, 3, 4];
    const ys = xs.map(x => 2 * x + 1);
    const r = _linearRegress(xs, ys);
    approxEq(r.slope, 2);
    approxEq(r.intercept, 1);
    assert.strictEqual(r.n, 5);
  });

  test("linearRegress refuses degenerate x (vertical)", () => {
    const r = _linearRegress([1, 1, 1], [1, 2, 3]);
    assert.strictEqual(r.slope, null);
  });

  // ── ring buffer ─────────────────────────────────────────────────────────
  test("push then snapshotNode returns fresh shape", () => {
    const mon = new GridCodeMonitor({ now: () => 1000 });
    mon.push({
      ip: "10.0.0.1", slave: 1, ts_ms: 1000,
      pac_w: 12500, qac_var: 400, freq_hz: 60.05,
      vac_avg_v: 480.1, cosphi: 0.98,
    });
    const s = mon.snapshotNode("10.0.0.1", 1);
    assert.ok(s, "snapshot present");
    assert.strictEqual(s.fresh, true);
    assert.strictEqual(s.sample_count, 1);
    approxEq(s.last_pac_w, 12500);
    approxEq(s.last_pf, 0.98);
    assert.strictEqual(s.dP_dt_w_per_s, null); // single sample → no derivative
  });

  test("dP/dt computed across two samples", () => {
    const mon = new GridCodeMonitor({ now: () => 5000 });
    mon.push({ ip: "10.0.0.1", slave: 1, ts_ms: 1000, pac_w: 10000, freq_hz: 60, vac_avg_v: 480 });
    mon.push({ ip: "10.0.0.1", slave: 1, ts_ms: 6000, pac_w: 15000, freq_hz: 60.1, vac_avg_v: 480 });
    const s = mon.snapshotNode("10.0.0.1", 1);
    // (15000-10000)/5 = 1000 W/s
    approxEq(s.dP_dt_w_per_s, 1000);
  });

  test("freshness flips off after FRESH_WINDOW_MS", () => {
    let t = 0;
    const mon = new GridCodeMonitor({ now: () => t });
    t = 1000;
    mon.push({ ip: "10.0.0.1", slave: 1, ts_ms: 1000, pac_w: 5000, freq_hz: 60 });
    t = 1000 + FRESH_WINDOW_MS + 1;
    const s = mon.snapshotNode("10.0.0.1", 1);
    assert.strictEqual(s.fresh, false);
  });

  test("droop_kw_per_hz null when freq is flat", () => {
    const mon = new GridCodeMonitor({ now: () => 10000 });
    for (let i = 0; i < 10; i++) {
      mon.push({ ip: "10.0.0.1", slave: 1, ts_ms: 1000 + i * 500, pac_w: 10000 + i * 100, freq_hz: 60.000 });
    }
    const s = mon.snapshotNode("10.0.0.1", 1);
    assert.strictEqual(s.droop_kw_per_hz, null);
  });

  test("droop_kw_per_hz computed when freq varies enough", () => {
    const mon = new GridCodeMonitor({ now: () => 10000 });
    // Construct a clear droop: as f drops by 0.1 Hz, P drops by 1000 W.
    // 10 points, range = 0.1 → matches min threshold.
    for (let i = 0; i < 10; i++) {
      const f = 60.10 - i * 0.0111; // 0.10 ramp
      mon.push({ ip: "10.0.0.1", slave: 1, ts_ms: 1000 + i * 500, pac_w: 11000 - i * 111, freq_hz: f });
    }
    const s = mon.snapshotNode("10.0.0.1", 1);
    assert.notStrictEqual(s.droop_kw_per_hz, null);
    // slope = ΔP(kW) / Δf(Hz) ≈ 1.0 / 0.1 = 10 kW/Hz (positive — P falls with f).
    approxEq(s.droop_kw_per_hz, 10, 1);
  });

  test("ring capped at ringSize", () => {
    const mon = new GridCodeMonitor({ ringSize: 10, now: () => 100000 });
    for (let i = 0; i < 25; i++) {
      mon.push({ ip: "10.0.0.1", slave: 1, ts_ms: 1000 + i * 100, pac_w: i * 10, freq_hz: 60 });
    }
    const s = mon.snapshotNode("10.0.0.1", 1);
    assert.strictEqual(s.sample_count, 10);
    assert.strictEqual(s.series.length, 10);
    // Should retain the LATEST 10 (15..24).
    approxEq(s.series[0].pac_w, 150);
    approxEq(s.series[9].pac_w, 240);
  });

  test("snapshotPlant counts fresh nodes only", () => {
    let t = 1000;
    const mon = new GridCodeMonitor({ now: () => t });
    // Old sample, will be stale by snapshot time.
    mon.push({ ip: "10.0.0.1", slave: 1, ts_ms: 1000, pac_w: 1000, qac_var: 100, freq_hz: 60, vac_avg_v: 480 });
    // Recent sample, still fresh at snapshot.
    t = 50_000;
    mon.push({ ip: "10.0.0.2", slave: 1, ts_ms: 50_000, pac_w: 2000, qac_var: 200, freq_hz: 60.1, vac_avg_v: 481 });
    t = 51_000;
    const p = mon.snapshotPlant();
    assert.strictEqual(p.total_count, 2);
    assert.strictEqual(p.fresh_count, 1); // only the recent push is fresh
    approxEq(p.plant_pac_kw, 2.0);
    approxEq(p.plant_qac_kvar, 0.2);
  });

  test("malformed pushes are silently dropped", () => {
    const mon = new GridCodeMonitor();
    mon.push(null);
    mon.push({});
    mon.push({ ip: "", slave: 1 });
    mon.push({ ip: "10.0.0.1", slave: 99 });
    assert.deepStrictEqual(mon.snapshotAll(), []);
  });

  test("dP_dt clamped to sanity limits", () => {
    const mon = new GridCodeMonitor({ now: () => 10000 });
    mon.push({ ip: "10.0.0.1", slave: 1, ts_ms: 1000, pac_w: 0, freq_hz: 60 });
    // Massive jump in 1 ms → unclamped would be huge.
    mon.push({ ip: "10.0.0.1", slave: 1, ts_ms: 2000, pac_w: 999_999_999, freq_hz: 60 });
    const s = mon.snapshotNode("10.0.0.1", 1);
    assert.ok(Math.abs(s.dP_dt_w_per_s) <= 200_000, `clamp failed: ${s.dP_dt_w_per_s}`);
  });

  console.log(
    process.exitCode === 1
      ? "\n  ✗ gridCodeMonitorCore tests FAILED\n"
      : "\n  ✓ gridCodeMonitorCore tests passed\n",
  );
}

run();
