"use strict";

// Pure-function core for the v2.10.x slot-coverage report.
//
// Operator pain point: the Daily Data Export silently emits whatever rows
// exist in `inverter_5min_param`. If a unit was offline 08:00-08:30 there
// are 6 missing slots and the export shows 282 rows instead of 288 — with
// no indication that the day is partial.
//
// This module turns the question "did we capture every expected slot for
// (inverter, slave, date)?" into a single answerable function. The
// exporter and a new diagnostic endpoint use it to surface coverage
// alongside the raw data.
//
// All inputs are plain values so the function can be tested without
// SQLite, the poller, or the Express layer. The DB-querying wrapper that
// feeds it lives in dailyAggregator.js (see getSlotCoverage).

const SLOT_MINUTES_DEFAULT = 5;
const HOUR_MIN = 60;

function _clampHour(h, fallback) {
  const v = Number(h);
  return Number.isFinite(v) && v >= 0 && v <= 23 ? Math.trunc(v) : fallback;
}

// Build the complete list of slot indices the day SHOULD contain inside
// the configured solar window. Slot N covers
//   [N * slotMinutes, N * slotMinutes + slotMinutes)
// in plant-local time, indexed by hour-of-day. The default 5-min/24-hour
// layout yields 288 slots/day (12/hour × 24 hours), of which slots
// [startHour*12, endHour*12) live in the solar window.
function expectedSolarWindowSlots({
  solarWindowStartHour = 5,
  eodSnapshotHourLocal = 18,
  slotMinutes = SLOT_MINUTES_DEFAULT,
} = {}) {
  const sm = Number.isFinite(slotMinutes) && slotMinutes > 0
    ? Math.trunc(slotMinutes)
    : SLOT_MINUTES_DEFAULT;
  const slotsPerHour = Math.floor(HOUR_MIN / sm);
  const startH = _clampHour(solarWindowStartHour, 5);
  const endH   = _clampHour(eodSnapshotHourLocal, 18);
  if (endH <= startH) return [];
  const out = [];
  for (let h = startH; h < endH; h += 1) {
    for (let s = 0; s < slotsPerHour; s += 1) {
      out.push(h * slotsPerHour + s);
    }
  }
  return out;
}

// Translate a slot index back to its HH:MM start label, plant-local.
// Used by the report so missing-slot lists are operator-readable.
function slotIndexToHHMM(slotIndex, slotMinutes = SLOT_MINUTES_DEFAULT) {
  const sm = Number.isFinite(slotMinutes) && slotMinutes > 0
    ? Math.trunc(slotMinutes)
    : SLOT_MINUTES_DEFAULT;
  const startMin = Number(slotIndex) * sm;
  if (!Number.isFinite(startMin) || startMin < 0) return "";
  const h = Math.floor(startMin / HOUR_MIN);
  const m = startMin % HOUR_MIN;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// Compress a sorted list of slot indices into [{startSlot, endSlot, startHHMM, endHHMM}] runs.
// Operators care about "08:00-08:30 missing" more than "slots 96-101 missing".
function compressSlotRuns(slots, slotMinutes = SLOT_MINUTES_DEFAULT) {
  const sm = Number.isFinite(slotMinutes) && slotMinutes > 0
    ? Math.trunc(slotMinutes)
    : SLOT_MINUTES_DEFAULT;
  const sorted = Array.from(new Set((Array.isArray(slots) ? slots : []).map(Number)
    .filter((n) => Number.isFinite(n) && n >= 0))).sort((a, b) => a - b);
  const runs = [];
  let start = null;
  let prev = null;
  for (const s of sorted) {
    if (start == null) { start = s; prev = s; continue; }
    if (s === prev + 1) { prev = s; continue; }
    runs.push({
      startSlot: start,
      endSlot: prev,
      startHHMM: slotIndexToHHMM(start, sm),
      endHHMM:   slotIndexToHHMM(prev + 1, sm), // exclusive end → label of next slot start
    });
    start = s;
    prev = s;
  }
  if (start != null) {
    runs.push({
      startSlot: start,
      endSlot: prev,
      startHHMM: slotIndexToHHMM(start, sm),
      endHHMM:   slotIndexToHHMM(prev + 1, sm),
    });
  }
  return runs;
}

// computeSlotCoverage
//
// Given the slots actually present in the DB for (inverter, slave, date),
// the operator's solar window, and the slot size, return a structured
// report the UI/export can display verbatim.
//
//   presentSlots          number[] of slot_index values found in the DB
//                         for the given (inverter_ip, slave, date_local).
//                         Pass ONLY in-solar-window slots; outside-window
//                         rows aren't part of "expected" coverage.
//   solarWindowStartHour  plant-local hour the solar window begins
//   eodSnapshotHourLocal  plant-local hour the solar window ends (exclusive)
//   slotMinutes           slot size in minutes (default 5)
//
// Output:
//   {
//     expected:    156,
//     present:     153,
//     missing:     3,
//     coveragePct: 0.9808,             // 0..1, 4 decimals
//     missingSlots: [42, 43, 44],
//     missingRuns: [{ startSlot: 42, endSlot: 44, startHHMM: "08:30", endHHMM: "08:45" }],
//     status: "complete" | "partial" | "empty",
//   }

function computeSlotCoverage({
  presentSlots = [],
  solarWindowStartHour = 5,
  eodSnapshotHourLocal = 18,
  slotMinutes = SLOT_MINUTES_DEFAULT,
} = {}) {
  const expectedList = expectedSolarWindowSlots({
    solarWindowStartHour,
    eodSnapshotHourLocal,
    slotMinutes,
  });
  const expectedSet = new Set(expectedList);
  const presentSet = new Set(
    (Array.isArray(presentSlots) ? presentSlots : [])
      .map(Number)
      .filter((n) => Number.isFinite(n) && expectedSet.has(n)),
  );

  const missingSlots = expectedList.filter((s) => !presentSet.has(s));
  const expected = expectedList.length;
  const present = presentSet.size;
  const missing = missingSlots.length;
  const coveragePct = expected > 0
    ? Number((present / expected).toFixed(4))
    : 0;

  let status;
  if (expected === 0)        status = "empty";
  else if (missing === 0)    status = "complete";
  else if (present === 0)    status = "empty";
  else                       status = "partial";

  return {
    expected,
    present,
    missing,
    coveragePct,
    missingSlots,
    missingRuns: compressSlotRuns(missingSlots, slotMinutes),
    status,
  };
}

module.exports = {
  SLOT_MINUTES_DEFAULT,
  expectedSolarWindowSlots,
  slotIndexToHHMM,
  compressSlotRuns,
  computeSlotCoverage,
};
