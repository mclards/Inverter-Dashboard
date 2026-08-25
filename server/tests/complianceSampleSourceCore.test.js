"use strict";

/**
 * complianceSampleSourceCore.test.js — locks the live-vs-5min-agg priority
 * for compliance test sample capture.
 *
 * Slice θ regression: earlier versions of _fetchLiveSampleForCompliance read
 * straight from `inverter_5min_param`, returning the same 5-min row up to
 * 150× per real refresh at the test cadence (T2/T5 sample every 2 s). That
 * masked grid excursions in T2 and made T5 APC sweeps false-fail because the
 * achieved-value averaging trailed reality by minutes.
 *
 * The fix lives in server/compliance/sampleSource.js — the helpers below are
 * pure (no DB, no I/O), so this file is the most stable place to lock the
 * shape contract. If a future refactor accidentally swaps the priority back,
 * the fail message here points straight at the audit trail.
 */

const assert = require("assert");
delete require.cache[require.resolve("../compliance/sampleSource")];
const {
  buildIpToInverterMap,
  liveFrameToSample,
  fiveMinRowToSample,
  resolveComplianceSample,
  LIVE_FRESH_MS_DEFAULT,
} = require("../compliance/sampleSource");

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

console.log("\n  complianceSampleSourceCore.test.js — Slice θ live-source priority\n");

const SAMPLE_IP_CONFIG = {
  inverters: { 1: "192.168.1.101", 2: "192.168.1.102", 27: "192.168.1.127" },
  units: { 1: [1, 2, 3, 4], 2: [1, 2] },
};

// ─── buildIpToInverterMap ─────────────────────────────────────────────────

test("buildIpToInverterMap walks the object-map ipconfig shape", () => {
  const m = buildIpToInverterMap(SAMPLE_IP_CONFIG);
  assert.strictEqual(m.get("192.168.1.101"), 1);
  assert.strictEqual(m.get("192.168.1.127"), 27);
  assert.strictEqual(m.size >= 3, true);
});

test("buildIpToInverterMap tolerates null/undefined/wrong-shape ipconfig", () => {
  assert.strictEqual(buildIpToInverterMap(null).size, 0);
  assert.strictEqual(buildIpToInverterMap(undefined).size, 0);
  assert.strictEqual(buildIpToInverterMap({}).size, 0);
  // legacy "array of records" shape — must NOT pollute the map
  assert.strictEqual(
    buildIpToInverterMap({ inverters: [{ inverter: 1, ip: "1.1.1.1" }] }).size,
    0,
    "array-of-records shape must yield empty map (regression for the IGBT thermal-baseline bug)",
  );
});

// ─── liveFrameToSample ────────────────────────────────────────────────────

test("liveFrameToSample maps every compliance field correctly", () => {
  const frame = {
    ts: 1_700_000_000_000,
    pac: 122_125,                // W (after Slice α scaling)
    qac_var: -45_000,            // VAR
    vac1: 230, vac2: 232, vac3: 228,
    iac1: 200, iac2: 201, iac3: 199,
    fac_hz: 60.012,
    cosphi: 0.985,
    temp_c: 41.5,
    inverter_state_raw: 514,
    alarm_32: 0,
    power_reduction_bits: 2,
  };
  const s = liveFrameToSample(frame);
  assert.strictEqual(s.ts_ms, 1_700_000_000_000);
  assert.strictEqual(s.pac_w, 122_125);
  assert.strictEqual(s.qac_var, -45_000);
  assert.strictEqual(Math.round(s.vac_avg_v * 100) / 100, 230);
  assert.strictEqual(Math.round(s.iac_avg_a * 100) / 100, 200);
  assert.strictEqual(s.freq_hz, 60.012);
  assert.strictEqual(s.cosphi, 0.985);
  assert.strictEqual(s.temp_c, 41.5);
  assert.strictEqual(s.state_raw, 514);
  assert.strictEqual(s.alarm_32, 0);
  assert.strictEqual(s.pwr_red_bits, 2);
});

test("liveFrameToSample propagates null cleanly (slow-poll-only fields)", () => {
  const s = liveFrameToSample({
    ts: 1, pac: 0, qac_var: null, vac1: 0, vac2: 0, vac3: 0, iac1: 0, iac2: 0, iac3: 0,
    fac_hz: null, cosphi: null, temp_c: null, inverter_state_raw: null, alarm_32: null,
    power_reduction_bits: null,
  });
  assert.strictEqual(s.qac_var, null);
  assert.strictEqual(s.freq_hz, null);
  assert.strictEqual(s.cosphi, null);
  assert.strictEqual(s.temp_c, null);
  assert.strictEqual(s.state_raw, null);
  assert.strictEqual(s.alarm_32, null);
  assert.strictEqual(s.pwr_red_bits, null);
});

test("liveFrameToSample returns null for null/non-object input", () => {
  assert.strictEqual(liveFrameToSample(null), null);
  assert.strictEqual(liveFrameToSample(undefined), null);
  assert.strictEqual(liveFrameToSample("string"), null);
});

// ─── fiveMinRowToSample ───────────────────────────────────────────────────

test("fiveMinRowToSample maps qac_var_avg → qac_var (Slice β migration column name)", () => {
  const row = {
    ts_ms: 1_700_000_300_000,
    pac_w: 122_125,
    qac_var_avg: -45_000,
    vac1_v: 230, vac2_v: 232, vac3_v: 228,
    iac1_a: 200, iac2_a: 201, iac3_a: 199,
    freq_hz: 60.012, cosphi: 0.985, temp_c: 41.5,
    inverter_state_raw: 514, inv_alarms: 0, pwr_red_bits: 2,
  };
  const s = fiveMinRowToSample(row);
  assert.strictEqual(s.qac_var, -45_000, "qac_var_avg must map to qac_var");
  assert.strictEqual(s.alarm_32, 0, "inv_alarms must map to alarm_32");
});

// ─── resolveComplianceSample (the priority contract) ──────────────────────

test("resolveComplianceSample PREFERS live frame when fresh", () => {
  const liveFrame = { ts: 100_000, pac: 99_999, fac_hz: 60.05, qac_var: -1000 };
  const fiveMin   = { ts_ms: 50_000, pac_w: 1, freq_hz: 50.0, qac_var_avg: 999 };
  let fiveMinCalled = false;
  const out = resolveComplianceSample({
    ip: "192.168.1.101", slave: 1,
    ipConfig: SAMPLE_IP_CONFIG,
    liveData: { "1_1": liveFrame },
    fetchFiveMinRow: () => { fiveMinCalled = true; return fiveMin; },
    now: 105_000,                                       // 5 s after frame.ts → fresh
  });
  assert.strictEqual(out.pac_w, 99_999, "must take pac from live frame");
  assert.strictEqual(out.freq_hz, 60.05, "must take freq from live frame");
  assert.strictEqual(out.qac_var, -1000, "must take qac_var from live frame");
  assert.strictEqual(fiveMinCalled, false, "5-min fallback must NOT fire when live is fresh");
});

test("resolveComplianceSample FALLS BACK to 5-min row when live is stale", () => {
  const liveFrame = { ts: 100_000, pac: 99_999, fac_hz: 60.05 };
  const fiveMin   = { ts_ms: 95_000, pac_w: 5_000, freq_hz: 60.10, qac_var_avg: 200 };
  const out = resolveComplianceSample({
    ip: "192.168.1.101", slave: 1,
    ipConfig: SAMPLE_IP_CONFIG,
    liveData: { "1_1": liveFrame },
    fetchFiveMinRow: () => fiveMin,
    now: 200_000,                                        // 100 s after frame.ts → stale
    liveFreshMs: 15_000,
  });
  assert.strictEqual(out.pac_w, 5_000, "stale live frame must be skipped");
  assert.strictEqual(out.qac_var, 200, "5-min fallback must surface qac_var_avg");
});

test("resolveComplianceSample FALLS BACK when live frame missing", () => {
  const fiveMin = { ts_ms: 1, pac_w: 7, freq_hz: 60, qac_var_avg: 0 };
  const out = resolveComplianceSample({
    ip: "192.168.1.101", slave: 1,
    ipConfig: SAMPLE_IP_CONFIG,
    liveData: {},                                        // no live frame at all
    fetchFiveMinRow: () => fiveMin,
  });
  assert.strictEqual(out.pac_w, 7);
});

test("resolveComplianceSample returns null when ip not in ipconfig AND no fallback", () => {
  const out = resolveComplianceSample({
    ip: "10.0.0.99", slave: 1,
    ipConfig: SAMPLE_IP_CONFIG,
    liveData: {},
    fetchFiveMinRow: () => null,
  });
  assert.strictEqual(out, null);
});

test("resolveComplianceSample tolerates fetchFiveMinRow throw", () => {
  const out = resolveComplianceSample({
    ip: "10.0.0.99", slave: 1,
    ipConfig: SAMPLE_IP_CONFIG,
    liveData: {},
    fetchFiveMinRow: () => { throw new Error("DB closed"); },
  });
  assert.strictEqual(out, null);
});

test("resolveComplianceSample rejects bad ip/slave inputs", () => {
  assert.strictEqual(resolveComplianceSample({ ip: "", slave: 1, ipConfig: {}, liveData: {}, fetchFiveMinRow: () => null }), null);
  assert.strictEqual(resolveComplianceSample({ ip: "1.1.1.1", slave: 0, ipConfig: {}, liveData: {}, fetchFiveMinRow: () => null }), null);
  assert.strictEqual(resolveComplianceSample({ ip: "1.1.1.1", slave: NaN, ipConfig: {}, liveData: {}, fetchFiveMinRow: () => null }), null);
});

test("LIVE_FRESH_MS_DEFAULT matches server-side LIVE_FRESH_MS contract (15 s)", () => {
  // Locks the renderer-aligned live-freshness window. If the server-side
  // constant ever drifts, this test catches it before T2/T5 grid runs go
  // silently un-fresh in the field.
  assert.strictEqual(LIVE_FRESH_MS_DEFAULT, 15_000);
});
