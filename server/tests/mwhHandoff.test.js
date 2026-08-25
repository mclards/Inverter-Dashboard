"use strict";
/**
 * MWh handoff regression tests - Remote->Gateway mode switch
 *
 * Uses shared production logic from ../mwhHandoffCore to reduce drift.
 * Run with: node server/tests/mwhHandoff.test.js
 */

const {
  MAX_SHADOW_AGE_MS,
  localDateStr,
  normalizeTodayEnergyRows,
  mergeTodayEnergyRowsMax,
  applyGatewayCarryRows,
  evaluateHandoffProgress,
} = require("../mwhHandoffCore");

const MAX_HANDOFF_ACTIVE_MS = 4 * 60 * 60 * 1000;

// Simulation state (reset per scenario)
let remoteTodayEnergyShadow;
let gatewayTodayCarryState;
let gatewayHandoffMeta;
let pollerKwhByInv; // simulates poller.getTodayPacKwh()
let dbKwhByInv; // simulates energy_5min SUM per inverter
let logs;
let nowMs;

function resetState(now = Date.now()) {
  remoteTodayEnergyShadow = { day: "", rows: [], syncedAt: 0 };
  gatewayTodayCarryState = { day: "", byInv: Object.create(null) };
  gatewayHandoffMeta = {
    active: false,
    startedAt: 0,
    day: "",
    baselines: Object.create(null),
  };
  pollerKwhByInv = {};
  dbKwhByInv = {};
  logs = [];
  nowMs = Number(now || Date.now());
}

function setNow(ts) {
  nowMs = Number(ts || Date.now());
}

function log(msg) {
  logs.push(msg);
}

function getRemoteTodayEnergyShadowRows(day) {
  if (gatewayHandoffMeta.day && gatewayHandoffMeta.day !== day) {
    gatewayHandoffMeta = {
      active: false,
      startedAt: 0,
      day: "",
      baselines: Object.create(null),
    };
  }

  if (remoteTodayEnergyShadow.day !== day) {
    if (remoteTodayEnergyShadow.day) {
      remoteTodayEnergyShadow.day = "";
      remoteTodayEnergyShadow.rows = [];
      remoteTodayEnergyShadow.syncedAt = 0;
    }
    return [];
  }

  const shadowAgeMs = nowMs - Number(remoteTodayEnergyShadow.syncedAt || 0);
  const handoffActive = gatewayHandoffMeta.active && gatewayHandoffMeta.day === day;
  if (!handoffActive && shadowAgeMs > MAX_SHADOW_AGE_MS) {
    log(`[shadow] stale shadow discarded: age=${Math.round(shadowAgeMs / 60000)}min`);
    remoteTodayEnergyShadow.day = "";
    remoteTodayEnergyShadow.rows = [];
    remoteTodayEnergyShadow.syncedAt = 0;
    return [];
  }

  return normalizeTodayEnergyRows(remoteTodayEnergyShadow.rows);
}

function _checkHandoffCompletion(pollerMap, day) {
  const progress = evaluateHandoffProgress({
    handoffMeta: gatewayHandoffMeta,
    carryByInv: gatewayTodayCarryState.byInv,
    pollerMap,
    day,
    now: nowMs,
    maxActiveMs: MAX_HANDOFF_ACTIVE_MS,
  });
  if (progress.action === "none") return;

  const elapsedS = Math.round(Number(progress.elapsedMs || 0) / 1000);
  const resolved = Number(progress.resolvedCount || 0);
  if (progress.action === "timeout") {
    log(
      `[handoff] timeout: elapsed=${elapsedS}s resolved=${resolved}` +
      ` carryRemaining=${Object.keys(gatewayTodayCarryState.byInv).length}`,
    );
    gatewayHandoffMeta.active = false;
    gatewayHandoffMeta.startedAt = 0;
    gatewayHandoffMeta.day = "";
    gatewayHandoffMeta.baselines = Object.create(null);
    return;
  }

  log(`[handoff] complete: elapsed=${elapsedS}s resolved=${resolved} inverters`);
  gatewayHandoffMeta.active = false;
  gatewayHandoffMeta.startedAt = 0;
  gatewayHandoffMeta.day = "";
  gatewayHandoffMeta.baselines = Object.create(null);
}

function getSupplementRows(day) {
  const pollerRows = Object.entries(pollerKwhByInv).map(([inv, kwh]) => ({
    inverter: Number(inv),
    total_kwh: Number(kwh),
  }));
  const shadowRows = getRemoteTodayEnergyShadowRows(day);

  if (!shadowRows.length) {
    gatewayTodayCarryState.day = day;
    gatewayTodayCarryState.byInv = Object.create(null);
    return normalizeTodayEnergyRows(pollerRows);
  }

  if (gatewayTodayCarryState.day !== day) {
    gatewayTodayCarryState.day = day;
    gatewayTodayCarryState.byInv = Object.create(null);
  }

  const { rows, pollerMap } = applyGatewayCarryRows({
    pollerRows,
    shadowRows,
    carryByInv: gatewayTodayCarryState.byInv,
    onEvent(evt) {
      if (!evt || typeof evt !== "object") return;
      if (evt.type === "carry_applied") {
        log(
          `[handoff] carry applied: inv=${evt.inverter}` +
          ` shadow=${Number(evt.shadowKwh || 0).toFixed(2)}` +
          ` poller=${Number(evt.pollerKwh || 0).toFixed(2)}`,
        );
        return;
      }
      if (evt.type === "carry_removed") {
        log(
          `[handoff] inv=${evt.inverter} caught up:` +
          ` poller=${Number(evt.pollerKwh || 0).toFixed(2)}` +
          ` >= shadow=${Number(evt.shadowKwh || 0).toFixed(2)}`,
        );
      }
    },
  });

  _checkHandoffCompletion(pollerMap, day);
  return rows;
}

function buildTotals(day) {
  const resultMap = new Map();
  for (const [inv, kwh] of Object.entries(dbKwhByInv)) {
    const i = Number(inv);
    if (i > 0) resultMap.set(i, Number(kwh));
  }
  const supp = getSupplementRows(day);
  for (const { inverter, total_kwh: totalKwh } of supp) {
    const inv = Number(inverter);
    if (inv <= 0 || !(totalKwh > 0)) continue;
    resultMap.set(inv, Math.max(resultMap.get(inv) || 0, totalKwh));
  }
  return Array.from(resultMap.entries())
    .map(([inverter, total_kwh]) => ({ inverter, total_kwh }))
    .sort((a, b) => a.inverter - b.inverter);
}

function simulateModeSwitch(shadowRowsFromRemote, syncedAtMs = nowMs) {
  const day = localDateStr(syncedAtMs);
  const incoming = normalizeTodayEnergyRows(shadowRowsFromRemote);
  const merged = mergeTodayEnergyRowsMax(remoteTodayEnergyShadow.rows, incoming);
  remoteTodayEnergyShadow.day = day;
  remoteTodayEnergyShadow.rows = merged;
  remoteTodayEnergyShadow.syncedAt = syncedAtMs;

  gatewayHandoffMeta.active = true;
  gatewayHandoffMeta.startedAt = syncedAtMs;
  gatewayHandoffMeta.day = day;
  gatewayHandoffMeta.baselines = Object.create(null);
  for (const r of remoteTodayEnergyShadow.rows) {
    const inv = Number(r.inverter);
    if (inv > 0) gatewayHandoffMeta.baselines[inv] = Number(r.total_kwh || 0);
  }
  log(
    `[handoff] Remote->Gateway started day=${day} baselines=${Object.keys(gatewayHandoffMeta.baselines).length}`,
  );

  // Fresh gateway poller session starts from 0.
  pollerKwhByInv = {};
}

let passed = 0;
let failed = 0;

function assert(condition, desc, detail = "") {
  if (condition) {
    console.log(`  [PASS] ${desc}`);
    passed++;
  } else {
    console.error(`  [FAIL] ${desc}${detail ? ` - ${detail}` : ""}`);
    failed++;
  }
}

function kwhFor(rows, inv) {
  const r = rows.find((x) => x.inverter === inv);
  return r ? r.total_kwh : 0;
}

console.log("\n-- Scenario A: No MWh drop after Remote->Gateway switch --");
resetState();
const TODAY = localDateStr(nowMs);

simulateModeSwitch([
  { inverter: 1, total_kwh: 50 },
  { inverter: 2, total_kwh: 30 },
]);

pollerKwhByInv = { 1: 0, 2: 0 };
dbKwhByInv = {};

const rowsA0 = buildTotals(TODAY);
assert(kwhFor(rowsA0, 1) >= 50, "inv=1 total >= 50 immediately after switch", `got ${kwhFor(rowsA0, 1)}`);
assert(kwhFor(rowsA0, 2) >= 30, "inv=2 total >= 30 immediately after switch", `got ${kwhFor(rowsA0, 2)}`);
assert(kwhFor(rowsA0, 1) === 50, "inv=1 exactly 50 (no inflation)", `got ${kwhFor(rowsA0, 1)}`);

pollerKwhByInv = { 1: 5, 2: 2 };
const rowsA1 = buildTotals(TODAY);
assert(kwhFor(rowsA1, 1) >= 55, "inv=1 total >= 55 after +5 poller", `got ${kwhFor(rowsA1, 1)}`);
assert(Math.abs(kwhFor(rowsA1, 1) - 55) < 1e-6, "inv=1 exactly 55 (shadow + delta)", `got ${kwhFor(rowsA1, 1)}`);
assert(kwhFor(rowsA1, 2) >= 32, "inv=2 total >= 32 after +2 poller", `got ${kwhFor(rowsA1, 2)}`);

console.log("\n-- Scenario B: No double-count once poller/DB catches up --");
resetState(nowMs);
simulateModeSwitch([{ inverter: 1, total_kwh: 50 }]);
pollerKwhByInv = { 1: 0 };
dbKwhByInv = {};

let rowsB = buildTotals(TODAY);
assert(kwhFor(rowsB, 1) >= 50, "inv=1 carry active at 50", `got ${kwhFor(rowsB, 1)}`);

dbKwhByInv = { 1: 52 };
pollerKwhByInv = { 1: 52 };
rowsB = buildTotals(TODAY);
assert(kwhFor(rowsB, 1) === 52, "inv=1 exactly 52 after catch-up", `got ${kwhFor(rowsB, 1)}`);
assert(!gatewayTodayCarryState.byInv[1], "carry for inv=1 removed after catch-up");
assert(!gatewayHandoffMeta.active, "handoff marked complete after baselines met");

console.log("\n-- Scenario C: Stale shadow does not inflate totals --");
resetState(nowMs);
const staleTs = nowMs - (5 * 60 * 60 * 1000);
remoteTodayEnergyShadow.day = TODAY;
remoteTodayEnergyShadow.rows = [{ inverter: 1, total_kwh: 30 }];
remoteTodayEnergyShadow.syncedAt = staleTs;
dbKwhByInv = { 1: 200 };
pollerKwhByInv = { 1: 10 };

const rowsC = buildTotals(TODAY);
assert(kwhFor(rowsC, 1) === 200, "DB wins when same-day shadow is stale", `got ${kwhFor(rowsC, 1)}`);
assert(!remoteTodayEnergyShadow.day, "stale shadow cleared from memory");
const staleLog = logs.find((l) => l.includes("stale shadow discarded"));
assert(Boolean(staleLog), "stale shadow discard log emitted");

resetState(nowMs);
remoteTodayEnergyShadow.day = TODAY;
remoteTodayEnergyShadow.rows = [{ inverter: 1, total_kwh: 999 }];
remoteTodayEnergyShadow.syncedAt = staleTs;
dbKwhByInv = { 1: 5 };
pollerKwhByInv = { 1: 1 };

const rowsC2 = buildTotals(TODAY);
assert(kwhFor(rowsC2, 1) <= 10, "stale high shadow is not applied", `got ${kwhFor(rowsC2, 1)}`);

console.log("\n-- Scenario D: Midnight rollover clears shadow and carry --");
resetState(nowMs);
const YESTERDAY = localDateStr(nowMs - 86400000);
remoteTodayEnergyShadow.day = YESTERDAY;
remoteTodayEnergyShadow.rows = [{ inverter: 1, total_kwh: 100 }];
remoteTodayEnergyShadow.syncedAt = nowMs - 86400000;

gatewayTodayCarryState.day = YESTERDAY;
gatewayTodayCarryState.byInv = { 1: { shadowBaseKwh: 100, anchorPollerKwh: 0 } };

pollerKwhByInv = { 1: 5 };
dbKwhByInv = {};

const rowsD = buildTotals(TODAY);
assert(!remoteTodayEnergyShadow.day, "yesterday shadow cleared on new day");
assert(!gatewayTodayCarryState.byInv[1], "yesterday carry cleared on new day");
assert(kwhFor(rowsD, 1) === 5, "new day uses poller only", `got ${kwhFor(rowsD, 1)}`);

console.log("\n-- Scenario E: Handoff timeout prevents indefinite active state --");
resetState(Date.now());
const t0 = nowMs;
const todayE = localDateStr(t0);
simulateModeSwitch([{ inverter: 1, total_kwh: 75 }], t0);

pollerKwhByInv = { 1: 0 };
dbKwhByInv = {};
const rowsE0 = buildTotals(todayE);
assert(kwhFor(rowsE0, 1) === 75, "carry still protects value before timeout", `got ${kwhFor(rowsE0, 1)}`);
assert(gatewayHandoffMeta.active, "handoff active before timeout");

setNow(t0 + MAX_HANDOFF_ACTIVE_MS + 1000);
const rowsE1 = buildTotals(todayE);
assert(kwhFor(rowsE1, 1) >= 75, "timeout tick still returns protected row", `got ${kwhFor(rowsE1, 1)}`);
assert(!gatewayHandoffMeta.active, "handoff force-completed after timeout");

const rowsE2 = buildTotals(todayE);
assert(kwhFor(rowsE2, 1) === 0, "stale shadow dropped after timeout on next tick", `got ${kwhFor(rowsE2, 1)}`);
assert(!remoteTodayEnergyShadow.day, "shadow cleared once handoff no longer active");
const timeoutLog = logs.find((l) => l.includes("timeout"));
assert(Boolean(timeoutLog), "timeout log emitted");

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
