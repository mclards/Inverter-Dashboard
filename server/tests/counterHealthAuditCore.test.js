"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  DEFAULT_DEDUP_MS,
  decideCounterHealthAudits,
} = require("../counterHealthAuditCore");

console.log("\n  counterHealthAuditCore.test.js — Slice η counter health\n");

const T0 = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

function sample(t, eTotal, pac = 100_000) {
  return { ts_ms: t, etotal_kwh: eTotal, parce_kwh: eTotal / 2, pac_w: pac };
}

/* ── Etotal monotonicity ─────────────────────────────────────────────── */

test("etotal_regressed: emits when latest Etotal < previous", () => {
  const dedup = new Map();
  const r = decideCounterHealthAudits({
    inverter: 16, unit: 1,
    history: [sample(T0, 4_014_400), sample(T0 + 1000, 4_014_300)],
    counterAdvancing: 1,
    prevCounterAdvancing: 1,
    lastAuditAtByKey: dedup,
    nowMs: T0 + 1000,
  });
  assert.equal(r.audits.length, 1);
  assert.equal(r.audits[0].action, "etotal_regressed");
  assert.match(r.audits[0].reason, /4014400 → 4014300 kWh \(drop 100\)/);
  // Dedup state mutated.
  assert.equal(dedup.size, 1);
});

test("etotal_regressed: dedup window suppresses repeat", () => {
  const dedup = new Map();
  const args = (now) => ({
    inverter: 16, unit: 1,
    history: [sample(T0, 4_014_400), sample(T0 + 1000, 4_014_300)],
    counterAdvancing: 1, prevCounterAdvancing: 1,
    lastAuditAtByKey: dedup, nowMs: now,
  });
  decideCounterHealthAudits(args(T0 + 1000));        // emits
  const r2 = decideCounterHealthAudits(args(T0 + 30 * 60 * 1000)); // 30 min later
  assert.equal(r2.audits.length, 0, "still inside 1-hour dedup window");
  const r3 = decideCounterHealthAudits(args(T0 + 1000 + DEFAULT_DEDUP_MS + 1));
  assert.equal(r3.audits.length, 1, "after dedup window expires, fires again");
});

test("etotal_regressed: zero values and missing history don't false-fire", () => {
  const dedup = new Map();
  const r1 = decideCounterHealthAudits({
    inverter: 1, unit: 1,
    history: [sample(T0, 0), sample(T0 + 1000, 0)],
    counterAdvancing: 1, prevCounterAdvancing: 1,
    lastAuditAtByKey: dedup, nowMs: T0 + 1000,
  });
  assert.equal(r1.audits.length, 0);

  const r2 = decideCounterHealthAudits({
    inverter: 1, unit: 1,
    history: [sample(T0, 100)],   // single sample
    counterAdvancing: 1, prevCounterAdvancing: 1,
    lastAuditAtByKey: dedup, nowMs: T0,
  });
  assert.equal(r2.audits.length, 0);
});

/* ── Stuck counter — 1→0 transition ──────────────────────────────────── */

test("counter_stuck: emits on 1→0 transition", () => {
  const dedup = new Map();
  const r = decideCounterHealthAudits({
    inverter: 12, unit: 3,
    history: [sample(T0, 4_014_354), sample(T0 + 1000, 4_014_354)], // Etotal frozen
    counterAdvancing: 0,         // newly degraded
    prevCounterAdvancing: 1,
    lastAuditAtByKey: dedup,
    nowMs: T0 + 1000,
  });
  assert.equal(r.audits.length, 1);
  assert.equal(r.audits[0].action, "counter_stuck");
  assert.match(r.audits[0].reason, /Etotal frozen with mean PAC/);
  assert.equal(r.nextCounterAdvancing, 0);
});

test("counter_stuck: dedup suppresses while still stuck", () => {
  const dedup = new Map();
  const args = (now, prev) => ({
    inverter: 12, unit: 3,
    history: [sample(T0, 4_014_354), sample(T0 + 1000, 4_014_354)],
    counterAdvancing: 0,
    prevCounterAdvancing: prev,
    lastAuditAtByKey: dedup, nowMs: now,
  });
  decideCounterHealthAudits(args(T0 + 1000, 1));       // first stall — emits
  const r2 = decideCounterHealthAudits(args(T0 + 2000, 0)); // still 0→0 — no transition
  assert.equal(r2.audits.length, 0);
});

test("counter_stuck: clears dedup on 0→1 recovery so next stall re-fires", () => {
  const dedup = new Map();
  const baseHistory = [sample(T0, 4_014_354), sample(T0 + 1000, 4_014_354)];
  decideCounterHealthAudits({
    inverter: 12, unit: 3, history: baseHistory,
    counterAdvancing: 0, prevCounterAdvancing: 1,
    lastAuditAtByKey: dedup, nowMs: T0 + 1000,
  });
  assert.equal(dedup.size, 1, "stall recorded");

  // Recovery: counter advances again.
  decideCounterHealthAudits({
    inverter: 12, unit: 3,
    history: [sample(T0 + 2000, 4_014_354), sample(T0 + 3000, 4_014_360)],
    counterAdvancing: 1, prevCounterAdvancing: 0,
    lastAuditAtByKey: dedup, nowMs: T0 + 3000,
  });
  assert.equal(dedup.size, 0, "dedup cleared on recovery");

  // Fresh stall — must re-fire.
  const r3 = decideCounterHealthAudits({
    inverter: 12, unit: 3, history: baseHistory,
    counterAdvancing: 0, prevCounterAdvancing: 1,
    lastAuditAtByKey: dedup, nowMs: T0 + 4000,
  });
  assert.equal(r3.audits.length, 1, "re-fires after recovery");
});

test("counter_stuck: cold start (prevCounterAdvancing undefined) does not fire", () => {
  const dedup = new Map();
  const r = decideCounterHealthAudits({
    inverter: 12, unit: 3,
    history: [sample(T0, 4_014_354), sample(T0 + 1000, 4_014_354)],
    counterAdvancing: 0,
    prevCounterAdvancing: undefined,    // no prior frame
    lastAuditAtByKey: dedup, nowMs: T0 + 1000,
  });
  assert.equal(r.audits.length, 0, "no transition without a prior value");
  assert.equal(r.nextCounterAdvancing, 0, "still records the new state");
});

/* ── Both anomalies in one frame ─────────────────────────────────────── */

test("emits BOTH audits when Etotal regresses AND counter goes stuck same frame", () => {
  const dedup = new Map();
  const r = decideCounterHealthAudits({
    inverter: 5, unit: 2,
    history: [sample(T0, 100), sample(T0 + 1000, 90)],   // regression
    counterAdvancing: 0, prevCounterAdvancing: 1,        // stuck transition
    lastAuditAtByKey: dedup, nowMs: T0 + 1000,
  });
  assert.equal(r.audits.length, 2);
  const actions = r.audits.map((a) => a.action).sort();
  assert.deepEqual(actions, ["counter_stuck", "etotal_regressed"]);
});

/* ── Defaults exposed ────────────────────────────────────────────────── */

test("DEFAULT_DEDUP_MS exposed at 1 hour", () => {
  assert.equal(DEFAULT_DEDUP_MS, HOUR);
});
