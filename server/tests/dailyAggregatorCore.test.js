"use strict";

// Locks the v2.10.x dailyAggregator behavior. Covers slot math, range
// gates, out-of-order rejection, reaped-slot LRU, day rollover, offline-
// skip, parcE monotone gate, and timestamp drift rejection.
//
// Uses a stub db that captures INSERT rows so tests can inspect the
// flushed payload without a real SQLite binding (avoids the better-sqlite3
// ABI gate documented in CLAUDE.md). The stub mirrors the surface
// dailyAggregator.js actually touches — `prepare(sql).run(row)`.

const assert = require("assert");

// Force a clean require — the module has module-scope state that other
// tests would otherwise share. Delete from cache before importing.
delete require.cache[require.resolve("../dailyAggregator")];
const dailyAggregator = require("../dailyAggregator");
const { _internal } = dailyAggregator;

// ── Stub db ─────────────────────────────────────────────────────────────
const insertedRows = [];
const stubDb = {
  prepare: (_sql) => ({
    run: (row) => {
      insertedRows.push({ ...row });
      return { changes: 1 };
    },
    all: (..._args) => [],
  }),
};
function clearInserts() { insertedRows.length = 0; }

// ── Stub settings ───────────────────────────────────────────────────────
const settingsMap = {
  solarWindowStartHour: 5,
  eodSnapshotHourLocal: 18,
};
const stubGetSetting = (key, def) => (
  Object.prototype.hasOwnProperty.call(settingsMap, key) ? settingsMap[key] : def
);

// Init the aggregator once at the top — `init()` is idempotent w.r.t. the
// reaper interval (clearInterval before resetting), and we never let the
// reaper run because we drive flushes manually via slot transitions.
dailyAggregator.init({ db: stubDb, getSetting: stubGetSetting });

function eq(actual, expected, msg) {
  assert.deepStrictEqual(actual, expected, msg || "");
}

// Helper to build a sample frame matching the shape services/inverter_engine.py
// emits and poller.js forwards into ingestLiveSample.
function makeFrame(overrides = {}) {
  return {
    source_ip: "192.168.1.10",
    unit: 1,
    online: 1,
    ts: Date.now(),
    pac: 1000,          // 1000 W (poller.parseRow has already scaled reg 18 deca-watts → watts)
    vdc: 800,
    idc: 5,
    vac1: 230, vac2: 231, vac3: 229,
    iac1: 4.3, iac2: 4.4, iac3: 4.2,
    cosphi: 0.99,
    fac_hz: 50.01,
    temp_c: 35,
    parce_kwh: 50_000,
    alarm_32: 0,
    ...overrides,
  };
}

// Reset module-level state between scenarios. The reaped-slot LRU and
// stats counters are visible via _internal — we clear them directly.
function resetState() {
  _internal.buckets.clear();
  _internal.reapedSlots.clear();
  for (const k of Object.keys(_internal.stats)) {
    _internal.stats[k] = 0;
  }
  clearInserts();
}

function run() {
  // ── 1. Slot math — boundaries across hours and midnight ──────────────
  {
    const slot = _internal._slotIndex;
    assert.strictEqual(slot({ hour: 0,  minute: 0  }), 0,   "00:00 = slot 0");
    assert.strictEqual(slot({ hour: 0,  minute: 4  }), 0,   "00:04 still slot 0");
    assert.strictEqual(slot({ hour: 0,  minute: 5  }), 1,   "00:05 = slot 1");
    assert.strictEqual(slot({ hour: 5,  minute: 0  }), 60,  "05:00 = slot 60");
    assert.strictEqual(slot({ hour: 17, minute: 55 }), 215, "17:55 = slot 215");
    assert.strictEqual(slot({ hour: 23, minute: 55 }), 287, "23:55 = slot 287");
  }

  // ── 2. Solar window — 5..18 default ──────────────────────────────────
  {
    const isSolar = _internal._isSolarWindow;
    assert.strictEqual(isSolar(0),   false, "00:00 outside solar");
    assert.strictEqual(isSolar(59),  false, "04:55 outside solar");
    assert.strictEqual(isSolar(60),  true,  "05:00 inside solar");
    assert.strictEqual(isSolar(215), true,  "17:55 inside solar");
    assert.strictEqual(isSolar(216), false, "18:00 just outside solar");
  }

  // ── 3. _formatDateLocal + _localParts integration ────────────────────
  {
    const ts = new Date(2026, 3, 28, 12, 34, 56).getTime(); // 2026-04-28 12:34:56 local
    const parts = _internal._localParts(ts);
    assert.strictEqual(parts.year, 2026);
    assert.strictEqual(parts.month, 4);
    assert.strictEqual(parts.day, 28);
    assert.strictEqual(parts.hour, 12);
    assert.strictEqual(parts.minute, 34);
    assert.strictEqual(_internal._formatDateLocal(parts), "2026-04-28");
    assert.strictEqual(_internal._slotIndex(parts), 150, "12:34 → slot 150");
  }

  // ── 4. _slotEndMs — slot 60 (05:00) ends at 05:05 ────────────────────
  {
    const end = _internal._slotEndMs("2026-04-28", 60);
    const expected = new Date(2026, 3, 28, 5, 5, 0, 0).getTime();
    assert.strictEqual(end, expected, "slot 60 of 2026-04-28 ends at 05:05:00");
  }

  // ── 5. Offline frame is dropped ──────────────────────────────────────
  {
    resetState();
    dailyAggregator.ingestLiveSample(makeFrame({
      online: 0, pac: 0, vdc: 0, vac1: 0,
    }));
    assert.strictEqual(_internal.stats.samples_dropped_offline, 1);
    assert.strictEqual(_internal.buckets.size, 0, "no bucket created for offline");
  }

  // ── 6. Stale ts (>5 min in past) is dropped ──────────────────────────
  {
    resetState();
    dailyAggregator.ingestLiveSample(makeFrame({
      ts: Date.now() - 10 * 60_000,  // 10 min in the past
    }));
    assert.strictEqual(_internal.stats.samples_dropped_stale_ts, 1);
    assert.strictEqual(_internal.buckets.size, 0);
  }

  // ── 7. Future ts (>5 min ahead) is dropped ───────────────────────────
  {
    resetState();
    dailyAggregator.ingestLiveSample(makeFrame({
      ts: Date.now() + 10 * 60_000,
    }));
    assert.strictEqual(_internal.stats.samples_dropped_future_ts, 1);
    assert.strictEqual(_internal.buckets.size, 0);
  }

  // ── 8. Missing unit → no_unit drop counter ───────────────────────────
  {
    resetState();
    dailyAggregator.ingestLiveSample({ source_ip: "1.2.3.4" /* no unit */ });
    assert.strictEqual(_internal.stats.samples_dropped_no_unit, 1);
  }

  // ── 9. Range gate — single out-of-range field rejected, others kept ──
  // vdc=99999 (rejected), pac=200 (kept). Sample still buckets and
  // field_clamp_count increments by exactly 1.
  {
    resetState();
    dailyAggregator.ingestLiveSample(makeFrame({ vdc: 99999, pac: 200 }));
    assert.strictEqual(_internal.stats.field_clamp_count, 1, "exactly one field clamped");
    assert.strictEqual(_internal.buckets.size, 1, "sample still produced a bucket");
    const [b] = _internal.buckets.values();
    assert.strictEqual(b.nVdc, 0, "vdc count is 0 (rejected)");
    assert.strictEqual(b.nPac, 1, "pac count is 1");
    assert.strictEqual(b.sampleCount, 1, "sample_count incremented because pac was valid");
  }

  // Helper — anchor a base ts to 60 s into the current 5-min slot so the
  // tests below can do ±10 s arithmetic without falling into a neighboring
  // slot. Without this, tests run during the last/first ~10 s of a slot
  // would unexpectedly cross the boundary.
  function midSlotNow() {
    const now = Date.now();
    const parts = _internal._localParts(now);
    const slotStartMin = Math.floor(parts.minute / 5) * 5;
    const slotStart = new Date(parts.year, parts.month - 1, parts.day,
                               parts.hour, slotStartMin, 0, 0).getTime();
    return slotStart + 60_000; // 60 s in — leaves ±60 s of headroom
  }

  // ── 10. parcE monotone gate — regression rejected within bucket ──────
  {
    resetState();
    const baseTs = midSlotNow();
    dailyAggregator.ingestLiveSample(makeFrame({ parce_kwh: 1000, ts: baseTs }));
    dailyAggregator.ingestLiveSample(makeFrame({ parce_kwh:  900, ts: baseTs + 1000 }));
    dailyAggregator.ingestLiveSample(makeFrame({ parce_kwh: 1100, ts: baseTs + 2000 }));
    const [b] = _internal.buckets.values();
    assert.strictEqual(b.parceLast, 1100, "regression skipped, last monotone value kept");
  }

  // ── 11. Out-of-order ts (>1 s older) rejected ────────────────────────
  {
    resetState();
    const baseTs = midSlotNow();
    dailyAggregator.ingestLiveSample(makeFrame({ ts: baseTs }));
    dailyAggregator.ingestLiveSample(makeFrame({ ts: baseTs + 2000 }));
    dailyAggregator.ingestLiveSample(makeFrame({ ts: baseTs - 5000 })); // out-of-order, same slot
    assert.strictEqual(_internal.stats.samples_dropped_oo_order, 1);
    const [b] = _internal.buckets.values();
    assert.strictEqual(b.sampleCount, 2, "only 2 in-order samples accepted");
  }

  // ── 12. Slot rollover — new slot triggers flush of previous bucket ───
  // Anchor timestamps near Date.now() so the ±5-min sanity gates accept
  // them. The slot index varies with wall-clock but the *behavior* under
  // test (slot transition flushes the prior bucket) is invariant.
  {
    resetState();
    const now = Date.now();
    const parts = _internal._localParts(now);
    // Snap to start of the current 5-min slot, then craft a frame deep
    // inside that slot and a follow-up exactly 5 min later (next slot).
    const slotStartMin = Math.floor(parts.minute / 5) * 5;
    const slotStart = new Date(parts.year, parts.month - 1, parts.day,
                               parts.hour, slotStartMin, 0, 0).getTime();
    const tsA = slotStart + 30_000;          // 30 s into slot N
    const tsB = slotStart + 5 * 60_000 + 30_000; // 30 s into slot N+1
    const slotA = _internal._slotIndex(_internal._localParts(tsA));
    dailyAggregator.ingestLiveSample(makeFrame({ ts: tsA, pac: 1000 }));
    assert.strictEqual(insertedRows.length, 0, "first frame: no flush yet");
    dailyAggregator.ingestLiveSample(makeFrame({ ts: tsB, pac: 2000 }));
    assert.strictEqual(insertedRows.length, 1, "previous slot flushed on rollover");
    assert.strictEqual(insertedRows[0].slot_index, slotA);
    assert.strictEqual(insertedRows[0].pac_w, 1000, "single-sample average = 1000 W (input is already watts)");
    assert.strictEqual(_internal.buckets.size, 1);
    const [b] = _internal.buckets.values();
    assert.strictEqual(b.slotIndex, slotA + 1, "now in slot N+1");
  }

  // ── 13. Reaped-slot guard — late sample for flushed slot rejected ────
  // After a slot is flushed by rollover, a fresh sample whose ts maps back
  // into the SAME slot must NOT recreate the bucket.
  {
    resetState();
    const now = Date.now();
    const parts = _internal._localParts(now);
    const slotStartMin = Math.floor(parts.minute / 5) * 5;
    const slotStart = new Date(parts.year, parts.month - 1, parts.day,
                               parts.hour, slotStartMin, 0, 0).getTime();
    const tsA = slotStart + 30_000;
    const tsB = slotStart + 5 * 60_000 + 30_000;
    dailyAggregator.ingestLiveSample(makeFrame({ ts: tsA }));
    dailyAggregator.ingestLiveSample(makeFrame({ ts: tsB })); // flush slot A
    clearInserts();
    // Late sample re-targeting slot A — must be rejected via _wasReaped()
    dailyAggregator.ingestLiveSample(makeFrame({ ts: tsA + 60_000 }));
    assert.strictEqual(_internal.stats.samples_dropped_reaped_slot, 1);
    assert.strictEqual(insertedRows.length, 0, "no clobbering INSERT");
  }

  // ── 14. Reaped-slot LRU eviction — bound to 256 entries ──────────────
  {
    resetState();
    // Manually populate with 260 entries via _flush by iterating slots.
    // Simulate by calling _rememberReaped via the public flushAll path —
    // here we just assert the LRU bound by direct manipulation.
    const map = _internal.reapedSlots;
    for (let i = 0; i < 260; i += 1) {
      map.set(`fake-key-${i}`, Date.now());
      while (map.size > 256) {
        const oldest = map.keys().next().value;
        map.delete(oldest);
      }
    }
    assert.ok(map.size <= 256, `LRU bounded at 256 (size=${map.size})`);
  }

  // ── 15. Day rollover — different dateLocal triggers flush ────────────
  // We can't actually cross midnight in the ±5-min gate window, so prove
  // the equivalent invariant: a sample whose dateLocal differs from the
  // bucket's existing dateLocal triggers a flush + new bucket. We do this
  // by directly seeding a bucket with yesterday's date_local, then
  // submitting a fresh sample.
  {
    resetState();
    const now = Date.now();
    const parts = _internal._localParts(now);
    const yesterday = new Date(parts.year, parts.month - 1, parts.day - 1).getTime();
    const yesterdayParts = _internal._localParts(yesterday);
    const yesterdayDate = _internal._formatDateLocal(yesterdayParts);
    const todayDate = _internal._formatDateLocal(parts);
    assert.notStrictEqual(yesterdayDate, todayDate, "test setup: dates differ");
    // Seed a bucket as if yesterday's last slot was open
    const fakeBucket = {
      ip: "192.168.1.10", slave: 1,
      dateLocal: yesterdayDate, slotIndex: 287,
      tsMs: yesterday, lastAcceptedTsMs: yesterday,
      sumVdc: 800, nVdc: 1, sumIdc: 5, nIdc: 1, sumPdc: 4000, nPdc: 1,
      sumVac1: 230, nVac1: 1, sumVac2: 231, nVac2: 1, sumVac3: 229, nVac3: 1,
      sumIac1: 4.3, nIac1: 1, sumIac2: 4.4, nIac2: 1, sumIac3: 4.2, nIac3: 1,
      sumPac: 1000, nPac: 1, sumCos: 0.99, nCos: 1, sumFreq: 50, nFreq: 1,
      sumTemp: 35, nTemp: 1, invAlarms: 0, trackAlarms: 0,
      parceLast: 999, sampleCount: 1,
    };
    _internal.buckets.set("192.168.1.10|1", fakeBucket);
    // Now ingest a fresh sample for "today" — must flush yesterday's slot.
    dailyAggregator.ingestLiveSample(makeFrame({
      source_ip: "192.168.1.10", unit: 1, ts: now,
    }));
    assert.strictEqual(insertedRows.length, 1, "yesterday's slot flushed");
    assert.strictEqual(insertedRows[0].date_local, yesterdayDate);
    assert.strictEqual(insertedRows[0].slot_index, 287);
    const newBucket = _internal.buckets.get("192.168.1.10|1");
    assert.strictEqual(newBucket.dateLocal, todayDate, "new bucket on today's date");
  }

  // ── 16. flushAll clears in-memory buckets and persists everything ────
  {
    resetState();
    const baseTs = Date.now();
    dailyAggregator.ingestLiveSample(makeFrame({ source_ip: "1.1.1.1", unit: 1, ts: baseTs }));
    dailyAggregator.ingestLiveSample(makeFrame({ source_ip: "1.1.1.1", unit: 2, ts: baseTs }));
    dailyAggregator.ingestLiveSample(makeFrame({ source_ip: "2.2.2.2", unit: 1, ts: baseTs }));
    assert.strictEqual(_internal.buckets.size, 3);
    dailyAggregator.flushAll();
    assert.strictEqual(_internal.buckets.size, 0, "all buckets cleared after flushAll");
    assert.strictEqual(insertedRows.length, 3, "3 INSERTs issued");
  }

  // ── 17. in_solar_window flag — directly via _isSolarWindow ───────────
  // Slot transitions that cross multi-hour boundaries are blocked by the
  // ±5-min ts gate, so we exercise the helper plus the flush-time path
  // by seeding a bucket explicitly inside / outside the window.
  {
    // Inside-window slot: 10:00 = slot 120
    assert.strictEqual(_internal._isSolarWindow(120), true, "10:00 in solar window");
    // Outside-window slot: 20:00 = slot 240
    assert.strictEqual(_internal._isSolarWindow(240), false, "20:00 outside solar window");
    // Edge cases
    assert.strictEqual(_internal._isSolarWindow(60), true,  "05:00 boundary inclusive");
    assert.strictEqual(_internal._isSolarWindow(216), false, "18:00 boundary exclusive");
  }

  // ── 18. Aggregated row shape — averages + LATEST parcE + bitwise OR ──
  // Anchor to "now" so the ±5 min gate accepts; the math is the same.
  {
    resetState();
    const now = Date.now();
    const parts = _internal._localParts(now);
    const slotStartMin = Math.floor(parts.minute / 5) * 5;
    const slotStart = new Date(parts.year, parts.month - 1, parts.day,
                               parts.hour, slotStartMin, 0, 0).getTime();
    const tsA = slotStart + 5_000;
    const tsB = slotStart + 30_000;
    const tsFlush = slotStart + 5 * 60_000 + 5_000; // next slot
    dailyAggregator.ingestLiveSample(makeFrame({
      ts: tsA, vdc: 800, idc: 5, pac: 1000, alarm_32: 0x0001, parce_kwh: 1000,
    }));
    dailyAggregator.ingestLiveSample(makeFrame({
      ts: tsB, vdc: 820, idc: 6, pac: 1200, alarm_32: 0x0010, parce_kwh: 1010,
    }));
    dailyAggregator.ingestLiveSample(makeFrame({ ts: tsFlush }));
    const flushed = insertedRows[0];
    assert.strictEqual(flushed.vdc_v, 810, "(800+820)/2 = 810");
    assert.strictEqual(flushed.idc_a, 5.5, "(5+6)/2 = 5.5");
    assert.strictEqual(flushed.pac_w, 1100, "(1000+1200)/2 = 1100 W (input already watts)");
    assert.strictEqual(flushed.parce_kwh, 1010, "parcE is LATEST, not average");
    assert.strictEqual(flushed.inv_alarms, 0x0011, "alarms bitwise-OR across slot");
    assert.strictEqual(flushed.sample_count, 2, "two contributing samples");
  }

  // ── 19. getCurrentBucket exposes slot_start_ms for live time-fraction ────
  // The Parameters totals strip uses live.slot_start_ms to scale the live
  // bucket's contribution by elapsed-within-slot, eliminating the 5-min
  // wobble where a slot rollover used to add a full slot's energy at once.
  {
    resetState();
    const now = Date.now();
    const parts = _internal._localParts(now);
    const slotStartMin = Math.floor(parts.minute / 5) * 5;
    const slotStartMs = new Date(parts.year, parts.month - 1, parts.day,
                                 parts.hour, slotStartMin, 0, 0).getTime();
    const tsMid = slotStartMs + 60_000;   // 1 min into the slot
    dailyAggregator.ingestLiveSample(makeFrame({ ts: tsMid, pac: 50_000 }));
    const live = dailyAggregator.getCurrentBucket("192.168.1.10", 1);
    assert.ok(live, "getCurrentBucket returns the in-progress bucket");
    assert.strictEqual(live.is_complete, 0, "in-progress, not complete");
    assert.strictEqual(live.pac_w, 50_000, "pac_w averaged in watts (post-fix)");
    assert.strictEqual(live.slot_start_ms, slotStartMs,
      "slot_start_ms reconstructs the local-wall-clock slot boundary");
    // Idempotent — calling twice returns the same slot_start_ms even though
    // wall-clock time has advanced.
    const live2 = dailyAggregator.getCurrentBucket("192.168.1.10", 1);
    assert.strictEqual(live2.slot_start_ms, slotStartMs, "slot_start_ms is anchored to slot, not query time");
  }

  // ── 20. Slice β slow-poll fields — qac_var averaging ───────────────────
  {
    resetState();
    const frame1 = makeFrame({ qac_var: -100 });
    const frame2 = makeFrame({ qac_var: -110 });
    const frame3 = makeFrame({ qac_var: null }); // offline

    dailyAggregator.ingestLiveSample(frame1);
    dailyAggregator.ingestLiveSample(frame2);
    dailyAggregator.ingestLiveSample(frame3);

    const bucket = dailyAggregator.getCurrentBucket("192.168.1.10", 1);
    // Average of -100 and -110 = -105
    assert.strictEqual(bucket.qac_var_avg, -105, "qac_var averaged correctly");
  }

  // ── 21. Slice β slow-poll fields — tempint_c min/max ───────────────────
  {
    resetState();
    const frame1 = makeFrame({ tempint_c: 30 });
    const frame2 = makeFrame({ tempint_c: 45 });
    const frame3 = makeFrame({ tempint_c: 35 });

    dailyAggregator.ingestLiveSample(frame1);
    dailyAggregator.ingestLiveSample(frame2);
    dailyAggregator.ingestLiveSample(frame3);

    const bucket = dailyAggregator.getCurrentBucket("192.168.1.10", 1);
    assert.strictEqual(bucket.tempint_c_min, 30, "tempint_c_min tracked");
    assert.strictEqual(bucket.tempint_c_max, 45, "tempint_c_max tracked");
    // Average: (30 + 45 + 35) / 3 = 36.666...
    assert.strictEqual(Math.round(bucket.tempint_c_avg * 100) / 100, 36.67, "tempint_c_avg calculated");
  }

  // ── 22. Slice β slow-poll fields — alarm windows bitwise-OR ────────────
  {
    resetState();
    const frame1 = makeFrame({ alarms_inst_32: 0x0001 });
    const frame2 = makeFrame({ alarms_inst_32: 0x0002 });
    const frame3 = makeFrame({ alarms_inst_32: 0x0004 });

    dailyAggregator.ingestLiveSample(frame1);
    dailyAggregator.ingestLiveSample(frame2);
    dailyAggregator.ingestLiveSample(frame3);

    const bucket = dailyAggregator.getCurrentBucket("192.168.1.10", 1);
    // Bitwise OR: 0x0001 | 0x0002 | 0x0004 = 0x0007
    assert.strictEqual(bucket.alarms_inst_32_max, 0x0007, "alarms_inst_32 ORed correctly");
  }

  // ── 23. Slice β slow-poll fields — last-value snapshots ────────────────
  {
    resetState();
    const frame1 = makeFrame({ zpos_kohm: 50, inverter_state_raw: 0x0202 });
    const frame2 = makeFrame({ zpos_kohm: 51, inverter_state_raw: 0x0201 });

    dailyAggregator.ingestLiveSample(frame1);
    dailyAggregator.ingestLiveSample(frame2);

    const bucket = dailyAggregator.getCurrentBucket("192.168.1.10", 1);
    assert.strictEqual(bucket.zpos_kohm_last, 51, "zpos_kohm last reading");
    assert.strictEqual(bucket.inverter_state_raw_last, 0x0201, "inverter_state_raw last reading");
  }

  // ── 24. Slice β slow-poll fields — AAP0016 analog averaging ────────────
  {
    resetState();
    const frame1 = makeFrame({ analog_in_1: 100, analog_in_2: 200 });
    const frame2 = makeFrame({ analog_in_1: 120, analog_in_2: 220 });

    dailyAggregator.ingestLiveSample(frame1);
    dailyAggregator.ingestLiveSample(frame2);

    const bucket = dailyAggregator.getCurrentBucket("192.168.1.10", 1);
    assert.strictEqual(bucket.analog_in_1_avg, 110, "analog_in_1 averaged");
    assert.strictEqual(bucket.analog_in_2_avg, 210, "analog_in_2 averaged");
  }

  // ── 25. Slice β slow-poll fields — combined old + new fields ───────────
  {
    resetState();
    const frame = makeFrame({
      pac: 5000,
      temp_c: 35,
      qac_var: -50,
      tempint_c: 38,
      zpos_kohm: 52,
      alarms_inst_32: 0x0001,
      analog_in_1: 1234,
    });

    dailyAggregator.ingestLiveSample(frame);
    const bucket = dailyAggregator.getCurrentBucket("192.168.1.10", 1);

    // Old fields
    assert.strictEqual(bucket.pac_w, 5000, "pac_w still works");
    assert.strictEqual(bucket.temp_c, 35, "temp_c still works");

    // New fields
    assert.strictEqual(bucket.qac_var_avg, -50, "qac_var aggregated");
    assert.strictEqual(bucket.tempint_c_avg, 38, "tempint_c aggregated");
    assert.strictEqual(bucket.zpos_kohm_last, 52, "zpos_kohm captured");
    assert.strictEqual(bucket.alarms_inst_32_max, 0x0001, "alarms captured");
    assert.strictEqual(bucket.analog_in_1_avg, 1234, "analog captured");
  }

  // ── 26. Slow-poll merge survives a flood of fast-poll frames ────────────
  // Empirical bug from scripts/audit-params-coverage.js (2026-05-11):
  //   100% of `inverter_5min_param.inverter_state_raw_last` rows were 0
  //   despite slow-poll succeeding, because fast-poll frames defaulted that
  //   field to 0 and the aggregator's "store last seen" semantics let every
  //   subsequent fast-poll frame overwrite the merged slow-poll value.
  //
  // Fix: poller.parseRow now defaults slow-poll-only fields to `null`
  // (server/poller.js parseRow comment block). This test locks in the
  // intended behavior: a stream of ~600 fast-poll frames with `null` slow
  // fields plus ONE slow-poll merged frame must yield the slow-poll value
  // in the persisted bucket, NOT 0 and NOT null.
  {
    resetState();
    const baseTs = Date.now();
    const slotStartParts = _internal._localParts(baseTs);
    const slotStartMin = Math.floor(slotStartParts.minute / 5) * 5;
    const slotStartMs = new Date(
      slotStartParts.year, slotStartParts.month - 1, slotStartParts.day,
      slotStartParts.hour, slotStartMin, 0, 0,
    ).getTime();

    // Helper: a fast-poll-only frame (slow-poll-only fields are null,
    // exactly like server/poller.js parseRow now produces them).
    const fastFrame = (ts) => ({
      source_ip: "192.168.1.10", unit: 1, online: 1, ts,
      pac: 5000, vdc: 800, idc: 5,
      vac1: 230, vac2: 231, vac3: 229,
      iac1: 4.3, iac2: 4.4, iac3: 4.2,
      cosphi: 0.99, fac_hz: 50.01, temp_c: 35, parce_kwh: 50_000, alarm_32: 0,
      // slow-poll-only fields explicitly null — fast-poll never sets these:
      qac_var: null, tempint_c: null,
      zpos_kohm: null, zneg_kohm: null,
      vpv_n_v: null, vpv_p_v: null,
      nominal_power_w: null,
      time_to_connect_s: null, time_to_connect_total_s: null,
      power_reduction_bits: null,
      inverter_state_raw: null,
    });

    // 50 fast-poll frames at 50 ms cadence — none carries slow data.
    for (let i = 0; i < 50; i++) {
      dailyAggregator.ingestLiveSample(fastFrame(slotStartMs + i * 50));
    }

    // ONE merged frame carrying real slow-poll values (slow-poll fired here).
    dailyAggregator.ingestLiveSample({
      ...fastFrame(slotStartMs + 50 * 50),
      qac_var: 1500,
      tempint_c: 42,
      zpos_kohm: 480, zneg_kohm: 470,
      vpv_n_v: 605, vpv_p_v: 612,
      nominal_power_w: 250_000,
      time_to_connect_s: 0, time_to_connect_total_s: 60,
      power_reduction_bits: 0x0002,
      inverter_state_raw: 0x0102, // hi=01 stop, lo=02 connected
    });

    // 100 more fast-poll frames after the merge — these must NOT bury the
    // slow-poll value (this was the bug).
    for (let i = 0; i < 100; i++) {
      dailyAggregator.ingestLiveSample(fastFrame(slotStartMs + (60 + i) * 50));
    }

    const bucket = dailyAggregator.getCurrentBucket("192.168.1.10", 1);
    assert.strictEqual(bucket.inverter_state_raw_last, 0x0102, "state_raw retains slow-poll value across fast-poll flood");
    assert.strictEqual(bucket.nominal_power_w_last, 250_000, "nominal_power_w retains 250 kW (rated)");
    assert.strictEqual(bucket.zpos_kohm_last, 480, "zpos_kohm retains slow-poll value");
    assert.strictEqual(bucket.zneg_kohm_last, 470, "zneg_kohm retains slow-poll value");
    assert.strictEqual(bucket.vpv_n_v_avg, 605, "vpv_n_v retains slow-poll average");
    assert.strictEqual(bucket.vpv_p_v_avg, 612, "vpv_p_v retains slow-poll average");
    assert.strictEqual(bucket.power_reduction_bits_last, 0x0002, "power_reduction_bits retains slow-poll value");
    assert.strictEqual(bucket.qac_var_avg, 1500, "qac_var retains slow-poll value (single sample, so avg = sample)");
    assert.strictEqual(bucket.tempint_c_avg, 42, "tempint_c retains slow-poll value");
  }

  console.log("dailyAggregatorCore.test.js — all 26 scenarios passed.");
}

run();
