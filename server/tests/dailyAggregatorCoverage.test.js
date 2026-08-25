"use strict";

// Locks the v2.10.x slot-coverage report semantics so the operator-facing
// gap detection can't silently regress. The exporter, the new
// /api/params/.../coverage/:date endpoint, and the heartbeat all rely on
// these rules being stable.

const assert = require("assert");
const {
  expectedSolarWindowSlots,
  slotIndexToHHMM,
  compressSlotRuns,
  computeSlotCoverage,
} = require("../dailyAggregatorCoverage");

function eq(actual, expected, msg) {
  assert.deepStrictEqual(actual, expected, msg || "");
}

function run() {
  // ── 1. expectedSolarWindowSlots — default 5..18 yields 156 slots ──────
  // 13 hours × 12 slots/hour = 156. First slot is 5*12 = 60 (05:00),
  // last is 17*12+11 = 215 (17:55).
  {
    const xs = expectedSolarWindowSlots();
    assert.strictEqual(xs.length, 156, "default window has 156 slots");
    assert.strictEqual(xs[0],   60,  "first slot is 60 (05:00)");
    assert.strictEqual(xs[155], 215, "last slot is 215 (17:55)");
  }

  // ── 2. expectedSolarWindowSlots — custom hours ────────────────────────
  {
    const xs = expectedSolarWindowSlots({ solarWindowStartHour: 6, eodSnapshotHourLocal: 18 });
    assert.strictEqual(xs.length, 144, "06..18 = 12 hr × 12 = 144 slots");
    assert.strictEqual(xs[0], 72, "first slot at 06:00 = 72");
  }

  // ── 3. expectedSolarWindowSlots — degenerate (end <= start) → empty ──
  {
    eq(expectedSolarWindowSlots({ solarWindowStartHour: 18, eodSnapshotHourLocal: 5 }), []);
    eq(expectedSolarWindowSlots({ solarWindowStartHour: 12, eodSnapshotHourLocal: 12 }), []);
  }

  // ── 4. expectedSolarWindowSlots — out-of-range hours fall back to defaults
  {
    const xs = expectedSolarWindowSlots({ solarWindowStartHour: 99, eodSnapshotHourLocal: -1 });
    // 99 → fallback 5, -1 → fallback 18 → default 156 slots
    assert.strictEqual(xs.length, 156, "garbage hours fall back to 5..18");
  }

  // ── 5. slotIndexToHHMM — boundary labels ─────────────────────────────
  assert.strictEqual(slotIndexToHHMM(0),   "00:00");
  assert.strictEqual(slotIndexToHHMM(60),  "05:00");
  assert.strictEqual(slotIndexToHHMM(215), "17:55");
  assert.strictEqual(slotIndexToHHMM(216), "18:00");
  assert.strictEqual(slotIndexToHHMM(287), "23:55");

  // ── 6. compressSlotRuns — single contiguous run ──────────────────────
  {
    const runs = compressSlotRuns([60, 61, 62, 63]);
    assert.strictEqual(runs.length, 1);
    assert.strictEqual(runs[0].startSlot, 60);
    assert.strictEqual(runs[0].endSlot,   63);
    assert.strictEqual(runs[0].startHHMM, "05:00");
    assert.strictEqual(runs[0].endHHMM,   "05:20"); // exclusive end
  }

  // ── 7. compressSlotRuns — multiple runs with a gap ──────────────────
  {
    const runs = compressSlotRuns([100, 101, 102, 110, 111]);
    assert.strictEqual(runs.length, 2);
    assert.strictEqual(runs[0].startSlot, 100);
    assert.strictEqual(runs[0].endSlot,   102);
    assert.strictEqual(runs[1].startSlot, 110);
    assert.strictEqual(runs[1].endSlot,   111);
  }

  // ── 8. compressSlotRuns — empty + dedup + unsorted input ──────────────
  eq(compressSlotRuns([]), []);
  eq(compressSlotRuns(null), []);
  {
    const runs = compressSlotRuns([5, 5, 6, 4, 7]); // dup + unsorted
    assert.strictEqual(runs.length, 1);
    assert.strictEqual(runs[0].startSlot, 4);
    assert.strictEqual(runs[0].endSlot,   7);
  }

  // ── 9. computeSlotCoverage — fully-complete day ──────────────────────
  {
    const present = expectedSolarWindowSlots(); // every slot present
    const r = computeSlotCoverage({ presentSlots: present });
    assert.strictEqual(r.expected, 156);
    assert.strictEqual(r.present,  156);
    assert.strictEqual(r.missing,  0);
    assert.strictEqual(r.coveragePct, 1);
    assert.strictEqual(r.status, "complete");
    eq(r.missingSlots, []);
    eq(r.missingRuns,  []);
  }

  // ── 10. computeSlotCoverage — partial day, single gap ────────────────
  // Inverter offline 08:00–08:25 → slots 96..101 missing (6 slots)
  {
    const all = expectedSolarWindowSlots();
    const missing = [96, 97, 98, 99, 100, 101];
    const present = all.filter((s) => !missing.includes(s));
    const r = computeSlotCoverage({ presentSlots: present });
    assert.strictEqual(r.expected, 156);
    assert.strictEqual(r.present,  150);
    assert.strictEqual(r.missing,  6);
    assert.strictEqual(r.coveragePct, 0.9615);
    assert.strictEqual(r.status, "partial");
    eq(r.missingSlots, missing);
    assert.strictEqual(r.missingRuns.length, 1);
    assert.strictEqual(r.missingRuns[0].startHHMM, "08:00");
    assert.strictEqual(r.missingRuns[0].endHHMM,   "08:30"); // exclusive of 08:30 = end of slot 101
  }

  // ── 11. computeSlotCoverage — multiple gaps reported as runs ─────────
  {
    const all = expectedSolarWindowSlots();
    const missing = [72, 73, 100, 101, 102, 200];
    const present = all.filter((s) => !missing.includes(s));
    const r = computeSlotCoverage({ presentSlots: present });
    assert.strictEqual(r.missing, 6);
    assert.strictEqual(r.missingRuns.length, 3, "3 distinct runs");
    assert.strictEqual(r.missingRuns[0].startHHMM, "06:00");
    assert.strictEqual(r.missingRuns[0].endHHMM,   "06:10");
    assert.strictEqual(r.missingRuns[1].startHHMM, "08:20");
    assert.strictEqual(r.missingRuns[1].endHHMM,   "08:35");
    assert.strictEqual(r.missingRuns[2].startHHMM, "16:40");
    assert.strictEqual(r.missingRuns[2].endHHMM,   "16:45");
  }

  // ── 12. computeSlotCoverage — totally empty day ──────────────────────
  // Gateway down all day. Status must be "empty", not "partial".
  {
    const r = computeSlotCoverage({ presentSlots: [] });
    assert.strictEqual(r.expected, 156);
    assert.strictEqual(r.present,  0);
    assert.strictEqual(r.missing,  156);
    assert.strictEqual(r.coveragePct, 0);
    assert.strictEqual(r.status, "empty");
    assert.strictEqual(r.missingRuns.length, 1, "single 156-slot run");
    assert.strictEqual(r.missingRuns[0].startHHMM, "05:00");
    assert.strictEqual(r.missingRuns[0].endHHMM,   "18:00");
  }

  // ── 13. computeSlotCoverage — outside-window slots in input are dropped
  // The aggregator may have logged a 04:55 slot from a clock-skewed sample.
  // The coverage report must ignore it, not let it inflate "present".
  {
    const all = expectedSolarWindowSlots();
    const present = [...all, 0, 50, 220, 287]; // 0=00:00, 50=04:10, 220=18:20, 287=23:55
    const r = computeSlotCoverage({ presentSlots: present });
    assert.strictEqual(r.expected, 156);
    assert.strictEqual(r.present,  156, "outside-window slots ignored");
    assert.strictEqual(r.missing,  0);
    assert.strictEqual(r.status, "complete");
  }

  // ── 14. computeSlotCoverage — degenerate window → status: empty ─────
  {
    const r = computeSlotCoverage({
      presentSlots: [10, 20, 30],
      solarWindowStartHour: 12,
      eodSnapshotHourLocal: 12,
    });
    assert.strictEqual(r.expected, 0);
    assert.strictEqual(r.status, "empty");
  }

  // ── 15. computeSlotCoverage — duplicates in input don't double-count ─
  {
    const all = expectedSolarWindowSlots();
    const present = [...all, ...all]; // each slot twice
    const r = computeSlotCoverage({ presentSlots: present });
    assert.strictEqual(r.present, 156, "dedup before counting");
  }

  console.log("dailyAggregatorCoverage.test.js — all 15 scenarios passed.");
}

run();
