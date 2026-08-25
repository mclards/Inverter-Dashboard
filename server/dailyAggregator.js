"use strict";

/**
 * server/dailyAggregator.js — Parameters page 5-min aggregator.
 *
 * Bucketizes the live poll stream into one 5-minute row per (inverter_ip,
 * slave, date_local, slot_index) and persists to `inverter_5min_param`.
 * Replaces the on-screen Energy table (UI only — the existing
 * `inverter_5min` and `energy_5min` tables stay untouched).
 *
 * Flow:
 *   poller.js parsed-row loop  →  ingestLiveSample(parsed)
 *      └─ validate fields per electrical sanity ranges
 *      └─ accumulate into in-memory bucket
 *      └─ when slot rolls (or 30s grace after slot end), _flush()
 *
 * Hardening (v2.10.x):
 *   • Per-field range clamps reject obvious garbage (negative voltages,
 *     freq outside 40-65 Hz, etc.) without dropping the whole sample.
 *   • Sample timestamp must be within ±5 min of server clock; clock-skew
 *     and stale-cache reads can't poison the average.
 *   • Out-of-order ts (sample older than the bucket's last accepted ts)
 *     is rejected so a slow Modbus reply replaying through the queue
 *     doesn't drag the slot label backwards.
 *   • Reaped slots are remembered so a very late sample for the same
 *     slot can't recreate a half-empty bucket and clobber the persisted
 *     row via INSERT OR REPLACE.
 *   • Stats counters (samples_seen / samples_dropped / flushes / errors)
 *     so the operator can sanity-check ingestion via the diagnostic API.
 *   • flushAndStop() is wired to the gateway shutdown sequence so
 *     in-memory partial buckets are persisted before exit.
 *
 * Reads (REST/WS) come from the persisted table; the in-progress bucket
 * is exposed via `getCurrentBucket(ip, slave)` for the live UI tile.
 *
 * Solar-window filter is stamped at flush time (in_solar_window column).
 * Read-side queries filter by that flag — see /api/params/* in index.js.
 *
 * Track Alarms is not exposed by the standard FC04 register block; we
 * always store 0 to keep the column count matching ISM's grid + export.
 *
 * Temp_C is also blank by design — services/inverter_engine.py emits
 * `temp_c: None` until the standard register carrying inverter heatsink
 * temperature is identified. The column exists in inverter_5min_param so
 * a future poll-side change will populate it without a schema migration.
 * See the FIXME v2.11 block in inverter_engine.py read_fast_async().
 */

const { computeSlotCoverage } = require("./dailyAggregatorCoverage");

const FLUSH_GRACE_MS = 30_000;          // reap a bucket 30s after its slot ended
const REAP_INTERVAL_MS = 30_000;        // run the reaper every 30s
const SLOT_MIN = 5;                     // bucket size (minutes)

// Reject samples whose ts drifts more than this far from server clock.
// Inverter RTC drift up to ~1 hr is normal — we still trust pymodbus's
// `time.time()` stamp on the Python side, which uses the gateway's clock.
const TS_PAST_TOLERANCE_MS = 5 * 60_000;
const TS_FUTURE_TOLERANCE_MS = 5 * 60_000;

// Remember the last 256 reaped (ip|unit|date|slot) keys so a stale sample
// for an already-persisted slot can't sneak in and clobber it. Map keeps
// insertion order so we can prune the oldest entry without a queue.
// LO-002: 256 entries ≈ 4.7 hours of history at the worst-case fleet rate
// (27 inverters × 4 nodes × 1 reap/5 min). Anything older than that has
// already been written to the persistent store and is safe to forget.
const REAPED_REMEMBER_LIMIT = 256;
const reapedSlots = new Map();   // key="ip|unit|date|slot" -> reapedAtMs

// Per-(inverter_ip, slave) in-progress bucket.
const buckets = new Map();              // key="ip|slave" -> Bucket

// Captured config — set by init().
let _db = null;
let _getSetting = null;                 // (key, def) => string
let _reaperHandle = null;
let _markDailyUnitsFinal = null;        // injected by init() — called when a past-day bucket is reaped

// Diagnostic counters — exported via getStats() for the settings UI.
const stats = {
  samples_seen: 0,           // every ingestLiveSample call
  samples_dropped_offline: 0,// online=0 + zero readings
  samples_dropped_stale_ts: 0,
  samples_dropped_future_ts: 0,
  samples_dropped_oo_order: 0,
  samples_dropped_reaped_slot: 0,
  samples_dropped_no_unit: 0,
  field_clamp_count: 0,      // # of individual fields rejected by range gate
  buckets_opened: 0,
  flushes_ok: 0,
  flushes_failed: 0,
  reaped: 0,
  shutdown_flushes: 0,
  // v2.10.0 — last-activity timestamps so /api/system/heartbeat can prove
  // the aggregator is ticking independent of which page the UI is on.
  last_sample_ts: 0,
  last_flush_ts: 0,
};

function _solarWindowStartHour() {
  const v = Number(_getSetting?.("solarWindowStartHour", 5));
  return Number.isFinite(v) && v >= 0 && v <= 23 ? Math.trunc(v) : 5;
}
function _eodSnapshotHour() {
  const v = Number(_getSetting?.("eodSnapshotHourLocal", 18));
  return Number.isFinite(v) && v >= 0 && v <= 23 ? Math.trunc(v) : 18;
}

function init({ db, getSetting, markDailyUnitsFinal }) {
  if (!db || typeof db.prepare !== "function") {
    throw new Error("dailyAggregator.init: db is required");
  }
  if (typeof getSetting !== "function") {
    throw new Error("dailyAggregator.init: getSetting is required");
  }
  _db = db;
  _getSetting = getSetting;
  if (typeof markDailyUnitsFinal === "function") {
    _markDailyUnitsFinal = markDailyUnitsFinal;
  }

  // Reaper — every 30s force-flush any bucket whose slot has rolled past
  // its grace window. Catches the case where an inverter goes silent
  // mid-bucket and would otherwise sit unflushed forever.
  if (_reaperHandle) {
    clearInterval(_reaperHandle);
    _reaperHandle = null;
  }
  _reaperHandle = setInterval(() => {
    try { reapStale(); } catch (err) {
      console.warn("[dailyAgg] reaper error:", err?.message || err);
    }
  }, REAP_INTERVAL_MS);
  if (typeof _reaperHandle.unref === "function") _reaperHandle.unref();

  return { ingestLiveSample, flushAll, getCurrentBucket };
}

// ─── Slot math (Asia/Manila wall clock) ────────────────────────────────────

function _localParts(tsMs) {
  const d = new Date(Number(tsMs) || Date.now());
  return {
    year: d.getFullYear(),
    month: d.getMonth() + 1,    // 1..12
    day: d.getDate(),           // 1..31
    hour: d.getHours(),         // 0..23
    minute: d.getMinutes(),     // 0..59
    second: d.getSeconds(),
  };
}
function _formatDateLocal(parts) {
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}
function _slotIndex(parts) {
  return Math.floor((parts.hour * 60 + parts.minute) / SLOT_MIN);
}
function _slotEndMs(dateLocal, slotIndex) {
  // Slot N covers [slotStart, slotStart + 5min). slot_end = slotStart + 5min.
  const [y, m, d] = dateLocal.split("-").map(Number);
  const startMin = slotIndex * SLOT_MIN;
  const startH = Math.floor(startMin / 60);
  const startMm = startMin % 60;
  return new Date(y, m - 1, d, startH, startMm, 0, 0).getTime() + SLOT_MIN * 60_000;
}
function _hourOfSlot(slotIndex) {
  return Math.floor(slotIndex / (60 / SLOT_MIN));   // 60/5 = 12 slots per hour
}
function _isSolarWindow(slotIndex) {
  const h = _hourOfSlot(slotIndex);
  return h >= _solarWindowStartHour() && h < _eodSnapshotHour();
}

// ─── Range gates ──────────────────────────────────────────────────────────
// A returned `null` means "field rejected — don't include in the average."
// Conservative bounds — they're meant to catch register-corruption (e.g.
// 0xFFFF interpreted as 65535 V), not borderline-real-world readings.

const _RANGES = {
  vdc:    [0, 2000],          // INGECON SUN bus voltage tops ~1500 V
  idc:    [0, 1500],
  vac:    [0, 1000],          // any single-phase line voltage on this fleet
  iac:    [0, 5000],
  pac:    [0, 260_000],       // per-unit watts; matches poller.parseRow safePac clamp (260 kW)
  cosphi: [-1.05, 1.05],
  fac:    [40, 65],           // 50 Hz / 60 Hz grids; outside this is a sensor fault
  tempC:  [-40, 150],         // industrial inverter envelope
  parce:  [0, 1_000_000_000], // lifetime monotonic counter — same ceiling as eod_clean sanity gate
  // v2.10.x Slice β — slow-poll diagnostic fields (additive)
  qacVar: [-500_000, 500_000], // reactive power in VAR (may be negative)
  tempInt: [-40, 150],         // control electronics temperature, same envelope as temp_c
  zpos:   [0, 1_000_000],      // impedance POS-EARTH in kΩ
  zneg:   [0, 1_000_000],      // impedance NEG-EARTH in kΩ
  vpv:    [0, 2000],           // solar field voltage (PV side)
  nominalPower: [0, 50_000_000], // nominal power in watts
  timeConnect: [0, 3600],      // time-to-connect in seconds (max 1 hour)
  alarmsBits: [0, 0xFFFFFFFF], // 32-bit alarm bitmaps
  analogIn: [0, 4095],         // 12-bit ADC input (0-4095)
  pt100:    [0, 65535],        // PT100 raw ADC value
};

function _vRange(row, key, range) {
  const val = row?.[key];
  // Preserve explicit null from parseRow (offline marker for signed fields)
  if (val === null || val === undefined) return null;
  const x = Number(val);
  if (!Number.isFinite(x)) return null;
  if (x < range[0] || x > range[1]) {
    stats.field_clamp_count += 1;
    return null;
  }
  return x;
}

// ─── Bucket lifecycle ─────────────────────────────────────────────────────

function _newBucket(ip, slave, dateLocal, slotIndex, tsMs) {
  stats.buckets_opened += 1;
  return {
    ip,
    slave: Number(slave) || 0,
    dateLocal,
    slotIndex,
    tsMs: Number(tsMs) || Date.now(),
    lastAcceptedTsMs: 0,        // for out-of-order rejection within the slot

    // Sums for averaging
    sumVdc: 0, nVdc: 0,
    sumIdc: 0, nIdc: 0,
    sumPdc: 0, nPdc: 0,
    sumVac1: 0, nVac1: 0,
    sumVac2: 0, nVac2: 0,
    sumVac3: 0, nVac3: 0,
    sumIac1: 0, nIac1: 0,
    sumIac2: 0, nIac2: 0,
    sumIac3: 0, nIac3: 0,
    sumPac: 0, nPac: 0,
    sumCos: 0, nCos: 0,
    sumFreq: 0, nFreq: 0,
    sumTemp: 0, nTemp: 0,

    // v2.10.x Slice β — slow-poll accumulators (additive)
    sumQacVar: 0, nQacVar: 0,
    minTempInt: null, maxTempInt: null, sumTempInt: 0, nTempInt: 0,
    minZpos: null, maxZpos: null,
    minZneg: null, maxZneg: null,
    zposLast: null,
    znegLast: null,
    minVpvN: null, maxVpvN: null, sumVpvN: 0, nVpvN: 0,
    minVpvP: null, maxVpvP: null, sumVpvP: 0, nVpvP: 0,
    nominalPowerLast: null,
    minTimeConnect: null, maxTimeConnect: null, sumTimeConnect: 0, nTimeConnect: 0,
    minTimeConnectTotal: null, maxTimeConnectTotal: null, sumTimeConnectTotal: 0, nTimeConnectTotal: 0,
    alarmsInst32Max: 0,   // bitwise-OR
    alarmsMaint32Max: 0,  // bitwise-OR
    powerReductionBitsLast: null,
    sumAnalogIn1: 0, nAnalogIn1: 0,
    sumAnalogIn2: 0, nAnalogIn2: 0,
    sumAnalogIn3: 0, nAnalogIn3: 0,
    sumAnalogIn4: 0, nAnalogIn4: 0,
    pt100_1Last: null,
    pt100_2Last: null,
    inverterStateRawLast: null,

    // Bitmaps: max-merge over the bucket
    invAlarms: 0,
    trackAlarms: 0,

    // parcE is a lifetime-monotonic counter; we keep the LATEST value seen
    // during the slot so the persisted row reflects the end-of-slot
    // snapshot. Row-to-row delta gives the slot's actual energy.
    parceLast: null,

    // v2.11.x Slice κ — grid-connection cycle counters (K1 wear).
    // Same monotone-counter pattern as parceLast: store the latest snapshot
    // we saw during the slot. Row-to-row delta gives the cycle count over
    // that 5-min window (~zero for healthy nodes; rises sharply on chatter).
    conexLifetimeLast:   null,
    conexResettableLast: null,

    sampleCount: 0,             // # of polls that contributed at least one field
  };
}

function _accum(b, row) {
  // row = the parsed object that the poller broadcasts. Field names mirror
  // services/inverter_engine.py read_fast_async output.
  const vdc = _vRange(row, "vdc", _RANGES.vdc);
  const idc = _vRange(row, "idc", _RANGES.idc);
  const pac = _vRange(row, "pac", _RANGES.pac);
  const fac = _vRange(row, "fac_hz", _RANGES.fac);
  const vac1 = _vRange(row, "vac1", _RANGES.vac);
  const vac2 = _vRange(row, "vac2", _RANGES.vac);
  const vac3 = _vRange(row, "vac3", _RANGES.vac);
  const iac1 = _vRange(row, "iac1", _RANGES.iac);
  const iac2 = _vRange(row, "iac2", _RANGES.iac);
  const iac3 = _vRange(row, "iac3", _RANGES.iac);
  const cosphi = _vRange(row, "cosphi", _RANGES.cosphi);
  const tempC = _vRange(row, "temp_c", _RANGES.tempC);
  const parce = _vRange(row, "parce_kwh", _RANGES.parce);
  const a32 = Number(row?.alarm_32);
  const alarm32 = Number.isFinite(a32) && a32 >= 0 ? (a32 >>> 0) : null;

  let touched = 0;
  if (vdc != null)  { b.sumVdc += vdc;   b.nVdc++; touched++; }
  if (idc != null)  { b.sumIdc += idc;   b.nIdc++; touched++; }
  if (vdc != null && idc != null) {
    // Pdc computed from Vdc × Idc (matches ISM display within ~2%; ISM derives
    // it from these same fields). Stored as integer W.
    b.sumPdc += vdc * idc;  b.nPdc++;
  }
  if (vac1 != null) { b.sumVac1 += vac1; b.nVac1++; touched++; }
  if (vac2 != null) { b.sumVac2 += vac2; b.nVac2++; touched++; }
  if (vac3 != null) { b.sumVac3 += vac3; b.nVac3++; touched++; }
  if (iac1 != null) { b.sumIac1 += iac1; b.nIac1++; touched++; }
  if (iac2 != null) { b.sumIac2 += iac2; b.nIac2++; touched++; }
  if (iac3 != null) { b.sumIac3 += iac3; b.nIac3++; touched++; }
  // pac is already in WATTS here — poller.parseRow:596 multiplied raw
  // deciWatts by 10. Do NOT multiply again. Re-scaling here was the
  // 10× pac_w regression in v2.10.0-beta.1..4 (audits/2026-04-28/pac-w-decascale-fix.md).
  if (pac != null)  { b.sumPac += pac; b.nPac++; touched++; }
  if (cosphi != null) { b.sumCos += cosphi; b.nCos++; touched++; }
  if (fac != null)  { b.sumFreq += fac; b.nFreq++; touched++; }
  if (tempC != null){ b.sumTemp += tempC; b.nTemp++; touched++; }
  // parcE is monotone-non-decreasing; only accept readings >= the last one
  // we saw in this bucket so a glitchy regression can't poison the persisted
  // end-of-slot value. The first valid reading sets the floor.
  if (parce != null) {
    if (b.parceLast == null || parce >= b.parceLast) {
      b.parceLast = parce;
      touched++;
    }
  }
  // v2.11.x Slice κ — Conex (grid-connection cycle count) is also monotone.
  // Same anti-regression guard as parcE. Values are taken from poller's
  // passthrough (Python's read_fast_async addr 4-5 / addr 62-63 UInt32 hi-lo).
  const conexL = Number(row?.conex_lifetime);
  const conexR = Number(row?.conex_resettable);
  if (Number.isFinite(conexL) && conexL >= 0) {
    if (b.conexLifetimeLast == null || conexL >= b.conexLifetimeLast) {
      b.conexLifetimeLast = conexL | 0;
    }
  }
  if (Number.isFinite(conexR) && conexR >= 0) {
    if (b.conexResettableLast == null || conexR >= b.conexResettableLast) {
      b.conexResettableLast = conexR | 0;
    }
  }
  if (alarm32 != null) {
    b.invAlarms = (Number(b.invAlarms) | alarm32) >>> 0;
  }

  // v2.10.x Slice β — slow-poll field accumulation (additive)
  const qacVar = _vRange(row, "qac_var", _RANGES.qacVar);
  const tempInt = _vRange(row, "tempint_c", _RANGES.tempInt);
  const zpos = _vRange(row, "zpos_kohm", _RANGES.zpos);
  const zneg = _vRange(row, "zneg_kohm", _RANGES.zneg);
  const vpvN = _vRange(row, "vpv_n_v", _RANGES.vpv);
  const vpvP = _vRange(row, "vpv_p_v", _RANGES.vpv);
  const nominalPower = _vRange(row, "nominal_power_w", _RANGES.nominalPower);
  const timeConnect = _vRange(row, "time_to_connect_s", _RANGES.timeConnect);
  const timeConnectTotal = _vRange(row, "time_to_connect_total_s", _RANGES.timeConnect);
  const alarmsInst32 = _vRange(row, "alarms_inst_32", _RANGES.alarmsBits);
  const alarmsMaint32 = _vRange(row, "alarms_maint_32", _RANGES.alarmsBits);
  const powerReductionBits = _vRange(row, "power_reduction_bits", _RANGES.alarmsBits);
  const analogIn1 = _vRange(row, "analog_in_1", _RANGES.analogIn);
  const analogIn2 = _vRange(row, "analog_in_2", _RANGES.analogIn);
  const analogIn3 = _vRange(row, "analog_in_3", _RANGES.analogIn);
  const analogIn4 = _vRange(row, "analog_in_4", _RANGES.analogIn);
  const pt100_1 = _vRange(row, "pt100_1", _RANGES.pt100);
  const pt100_2 = _vRange(row, "pt100_2", _RANGES.pt100);
  const inverterStateRaw = _vRange(row, "inverter_state_raw", _RANGES.alarmsBits);

  // Accumulate slow-poll fields
  if (qacVar != null) { b.sumQacVar += qacVar; b.nQacVar++; touched++; }
  if (tempInt != null) {
    if (b.minTempInt == null || tempInt < b.minTempInt) b.minTempInt = tempInt;
    if (b.maxTempInt == null || tempInt > b.maxTempInt) b.maxTempInt = tempInt;
    b.sumTempInt += tempInt; b.nTempInt++; touched++;
  }
  if (zpos != null) {
    if (b.minZpos == null || zpos < b.minZpos) b.minZpos = zpos;
    if (b.maxZpos == null || zpos > b.maxZpos) b.maxZpos = zpos;
    b.zposLast = zpos; touched++;
  }
  if (zneg != null) {
    if (b.minZneg == null || zneg < b.minZneg) b.minZneg = zneg;
    if (b.maxZneg == null || zneg > b.maxZneg) b.maxZneg = zneg;
    b.znegLast = zneg; touched++;
  }
  if (vpvN != null) {
    if (b.minVpvN == null || vpvN < b.minVpvN) b.minVpvN = vpvN;
    if (b.maxVpvN == null || vpvN > b.maxVpvN) b.maxVpvN = vpvN;
    b.sumVpvN += vpvN; b.nVpvN++; touched++;
  }
  if (vpvP != null) {
    if (b.minVpvP == null || vpvP < b.minVpvP) b.minVpvP = vpvP;
    if (b.maxVpvP == null || vpvP > b.maxVpvP) b.maxVpvP = vpvP;
    b.sumVpvP += vpvP; b.nVpvP++; touched++;
  }
  if (nominalPower != null) {
    b.nominalPowerLast = nominalPower; touched++;
  }
  if (timeConnect != null) {
    if (b.minTimeConnect == null || timeConnect < b.minTimeConnect) b.minTimeConnect = timeConnect;
    if (b.maxTimeConnect == null || timeConnect > b.maxTimeConnect) b.maxTimeConnect = timeConnect;
    b.sumTimeConnect += timeConnect; b.nTimeConnect++; touched++;
  }
  if (timeConnectTotal != null) {
    if (b.minTimeConnectTotal == null || timeConnectTotal < b.minTimeConnectTotal) b.minTimeConnectTotal = timeConnectTotal;
    if (b.maxTimeConnectTotal == null || timeConnectTotal > b.maxTimeConnectTotal) b.maxTimeConnectTotal = timeConnectTotal;
    b.sumTimeConnectTotal += timeConnectTotal; b.nTimeConnectTotal++; touched++;
  }
  if (alarmsInst32 != null) {
    b.alarmsInst32Max = (Number(b.alarmsInst32Max) | alarmsInst32) >>> 0;
  }
  if (alarmsMaint32 != null) {
    b.alarmsMaint32Max = (Number(b.alarmsMaint32Max) | alarmsMaint32) >>> 0;
  }
  if (powerReductionBits != null) {
    b.powerReductionBitsLast = powerReductionBits; touched++;
  }
  if (analogIn1 != null) { b.sumAnalogIn1 += analogIn1; b.nAnalogIn1++; touched++; }
  if (analogIn2 != null) { b.sumAnalogIn2 += analogIn2; b.nAnalogIn2++; touched++; }
  if (analogIn3 != null) { b.sumAnalogIn3 += analogIn3; b.nAnalogIn3++; touched++; }
  if (analogIn4 != null) { b.sumAnalogIn4 += analogIn4; b.nAnalogIn4++; touched++; }
  if (pt100_1 != null) { b.pt100_1Last = pt100_1; touched++; }
  if (pt100_2 != null) { b.pt100_2Last = pt100_2; touched++; }
  if (inverterStateRaw != null) { b.inverterStateRawLast = inverterStateRaw; touched++; }

  // sample_count now counts only polls that contributed at least one valid
  // field, so a fully-corrupt frame doesn't inflate the persisted "samples"
  // counter.
  if (touched > 0) {
    b.sampleCount += 1;
    const tsCandidate = Number(row?.ts);
    if (Number.isFinite(tsCandidate) && tsCandidate > 0) {
      b.tsMs = tsCandidate;
      b.lastAcceptedTsMs = tsCandidate;
    } else if (b.tsMs <= 0) {
      b.tsMs = Date.now();
    }
  }
  return touched;
}

function _avg(sum, n, fixed = null) {
  if (!n) return null;
  const x = sum / n;
  return fixed == null ? x : Math.round(x * (10 ** fixed)) / (10 ** fixed);
}

function _rememberReaped(ip, unit, dateLocal, slotIndex) {
  const key = `${ip}|${unit}|${dateLocal}|${slotIndex}`;
  reapedSlots.set(key, Date.now());
  // Trim to bound — drop oldest entry (Map iterates in insertion order).
  while (reapedSlots.size > REAPED_REMEMBER_LIMIT) {
    const oldestKey = reapedSlots.keys().next().value;
    if (oldestKey === undefined) break;
    reapedSlots.delete(oldestKey);
  }
}
function _wasReaped(ip, unit, dateLocal, slotIndex) {
  return reapedSlots.has(`${ip}|${unit}|${dateLocal}|${slotIndex}`);
}

function _flush(b) {
  if (!_db || b.sampleCount === 0) return false;
  const inSolar = _isSolarWindow(b.slotIndex) ? 1 : 0;
  const row = {
    inverter_ip: b.ip,
    slave: b.slave,
    date_local: b.dateLocal,
    slot_index: b.slotIndex,
    ts_ms: b.tsMs,
    vdc_v:    _avg(b.sumVdc,  b.nVdc,  1),
    idc_a:    _avg(b.sumIdc,  b.nIdc,  2),
    pdc_w:    b.nPdc ? Math.round(b.sumPdc / b.nPdc) : null,
    vac1_v:   _avg(b.sumVac1, b.nVac1, 1),
    vac2_v:   _avg(b.sumVac2, b.nVac2, 1),
    vac3_v:   _avg(b.sumVac3, b.nVac3, 1),
    iac1_a:   _avg(b.sumIac1, b.nIac1, 2),
    iac2_a:   _avg(b.sumIac2, b.nIac2, 2),
    iac3_a:   _avg(b.sumIac3, b.nIac3, 2),
    temp_c:   b.nTemp ? Math.round(b.sumTemp / b.nTemp) : null,
    pac_w:    b.nPac ? Math.round(b.sumPac / b.nPac) : null,
    cosphi:   _avg(b.sumCos, b.nCos, 3),
    freq_hz:  _avg(b.sumFreq, b.nFreq, 2),
    inv_alarms: Number(b.invAlarms) >>> 0,
    track_alarms: Number(b.trackAlarms) >>> 0,
    sample_count: b.sampleCount,
    is_complete: 1,
    in_solar_window: inSolar,
    parce_kwh: b.parceLast != null ? Number(b.parceLast) : null,
    // v2.10.x Slice β — slow-poll fields (additive)
    qac_var_avg:         b.nQacVar ? _avg(b.sumQacVar, b.nQacVar, 1) : null,
    tempint_c_min:       b.minTempInt,
    tempint_c_max:       b.maxTempInt,
    tempint_c_avg:       b.nTempInt ? _avg(b.sumTempInt, b.nTempInt, 2) : null,
    zpos_kohm_min:       b.minZpos,
    zpos_kohm_max:       b.maxZpos,
    zpos_kohm_last:      b.zposLast,
    zneg_kohm_min:       b.minZneg,
    zneg_kohm_max:       b.maxZneg,
    zneg_kohm_last:      b.znegLast,
    vpv_n_v_min:         b.minVpvN,
    vpv_n_v_max:         b.maxVpvN,
    vpv_n_v_avg:         b.nVpvN ? _avg(b.sumVpvN, b.nVpvN, 1) : null,
    vpv_p_v_min:         b.minVpvP,
    vpv_p_v_max:         b.maxVpvP,
    vpv_p_v_avg:         b.nVpvP ? _avg(b.sumVpvP, b.nVpvP, 1) : null,
    nominal_power_w_last: b.nominalPowerLast,
    time_to_connect_s_min: b.minTimeConnect,
    time_to_connect_s_max: b.maxTimeConnect,
    time_to_connect_s_avg: b.nTimeConnect ? _avg(b.sumTimeConnect, b.nTimeConnect, 0) : null,
    time_to_connect_total_s_min: b.minTimeConnectTotal,
    time_to_connect_total_s_max: b.maxTimeConnectTotal,
    time_to_connect_total_s_avg: b.nTimeConnectTotal ? _avg(b.sumTimeConnectTotal, b.nTimeConnectTotal, 0) : null,
    alarms_inst_32_max:  Number(b.alarmsInst32Max) >>> 0,
    alarms_maint_32_max: Number(b.alarmsMaint32Max) >>> 0,
    power_reduction_bits_last: b.powerReductionBitsLast,
    analog_in_1_avg:     b.nAnalogIn1 ? _avg(b.sumAnalogIn1, b.nAnalogIn1, 0) : null,
    analog_in_2_avg:     b.nAnalogIn2 ? _avg(b.sumAnalogIn2, b.nAnalogIn2, 0) : null,
    analog_in_3_avg:     b.nAnalogIn3 ? _avg(b.sumAnalogIn3, b.nAnalogIn3, 0) : null,
    analog_in_4_avg:     b.nAnalogIn4 ? _avg(b.sumAnalogIn4, b.nAnalogIn4, 0) : null,
    pt100_1_last:        b.pt100_1Last,
    pt100_2_last:        b.pt100_2Last,
    inverter_state_raw_last: b.inverterStateRawLast,
    // v2.11.x Slice κ — grid-connection cycle counters (K1 wear).
    conex_lifetime_last:   b.conexLifetimeLast,
    conex_resettable_last: b.conexResettableLast,
  };
  try {
    _db.prepare(`
      INSERT OR REPLACE INTO inverter_5min_param (
        inverter_ip, slave, date_local, slot_index, ts_ms,
        vdc_v, idc_a, pdc_w,
        vac1_v, vac2_v, vac3_v,
        iac1_a, iac2_a, iac3_a,
        temp_c, pac_w, cosphi, freq_hz,
        inv_alarms, track_alarms,
        parce_kwh,
        qac_var_avg, tempint_c_min, tempint_c_max, tempint_c_avg,
        zpos_kohm_min, zpos_kohm_max, zpos_kohm_last,
        zneg_kohm_min, zneg_kohm_max, zneg_kohm_last,
        vpv_n_v_min, vpv_n_v_max, vpv_n_v_avg,
        vpv_p_v_min, vpv_p_v_max, vpv_p_v_avg,
        nominal_power_w_last, time_to_connect_s_min, time_to_connect_s_max, time_to_connect_s_avg,
        time_to_connect_total_s_min, time_to_connect_total_s_max, time_to_connect_total_s_avg,
        alarms_inst_32_max, alarms_maint_32_max, power_reduction_bits_last,
        analog_in_1_avg, analog_in_2_avg, analog_in_3_avg, analog_in_4_avg,
        pt100_1_last, pt100_2_last, inverter_state_raw_last,
        conex_lifetime_last, conex_resettable_last,
        sample_count, is_complete, in_solar_window,
        updated_ts
      ) VALUES (
        @inverter_ip, @slave, @date_local, @slot_index, @ts_ms,
        @vdc_v, @idc_a, @pdc_w,
        @vac1_v, @vac2_v, @vac3_v,
        @iac1_a, @iac2_a, @iac3_a,
        @temp_c, @pac_w, @cosphi, @freq_hz,
        @inv_alarms, @track_alarms,
        @parce_kwh,
        @qac_var_avg, @tempint_c_min, @tempint_c_max, @tempint_c_avg,
        @zpos_kohm_min, @zpos_kohm_max, @zpos_kohm_last,
        @zneg_kohm_min, @zneg_kohm_max, @zneg_kohm_last,
        @vpv_n_v_min, @vpv_n_v_max, @vpv_n_v_avg,
        @vpv_p_v_min, @vpv_p_v_max, @vpv_p_v_avg,
        @nominal_power_w_last, @time_to_connect_s_min, @time_to_connect_s_max, @time_to_connect_s_avg,
        @time_to_connect_total_s_min, @time_to_connect_total_s_max, @time_to_connect_total_s_avg,
        @alarms_inst_32_max, @alarms_maint_32_max, @power_reduction_bits_last,
        @analog_in_1_avg, @analog_in_2_avg, @analog_in_3_avg, @analog_in_4_avg,
        @pt100_1_last, @pt100_2_last, @inverter_state_raw_last,
        @conex_lifetime_last, @conex_resettable_last,
        @sample_count, @is_complete, @in_solar_window,
        CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
      )
    `).run(row);
    stats.flushes_ok += 1;
    stats.last_flush_ts = Date.now();
    _rememberReaped(b.ip, b.slave, b.dateLocal, b.slotIndex);
    return true;
  } catch (err) {
    stats.flushes_failed += 1;
    console.warn(`[dailyAgg] flush failed for ${b.ip}|${b.slave} slot ${b.slotIndex}:`, err?.message || err);
    return false;
  }
}

// ─── Public API ────────────────────────────────────────────────────────────

function ingestLiveSample(row) {
  stats.samples_seen += 1;
  stats.last_sample_ts = Date.now();
  if (!row || !row.source_ip || row.unit == null) {
    stats.samples_dropped_no_unit += 1;
    return;
  }
  // Skip offline frames — the inverter explicitly reported online=0 AND every
  // primary reading is zero. A single non-zero field is enough to keep the
  // sample (residual DC voltage, CT-based AC current) since one stale field
  // shouldn't poison an otherwise-real frame.
  if (Number(row.online) === 0
      && Number(row.pac || 0) === 0
      && Number(row.vdc || 0) === 0
      && Number(row.vac1 || 0) === 0) {
    stats.samples_dropped_offline += 1;
    return;
  }
  const tsCandidate = Number(row.ts);
  const tsMs = Number.isFinite(tsCandidate) && tsCandidate > 0 ? tsCandidate : Date.now();
  const nowMs = Date.now();
  // Reject obviously bad timestamps. Stale = wraparound / cached frame from
  // hours ago; future = drift from a runaway RTC. Both would assign the
  // sample to the wrong slot.
  if (tsMs < nowMs - TS_PAST_TOLERANCE_MS) {
    stats.samples_dropped_stale_ts += 1;
    return;
  }
  if (tsMs > nowMs + TS_FUTURE_TOLERANCE_MS) {
    stats.samples_dropped_future_ts += 1;
    return;
  }

  const parts = _localParts(tsMs);
  const dateLocal = _formatDateLocal(parts);
  const slot = _slotIndex(parts);
  const key = `${row.source_ip}|${row.unit}`;

  // Reaped-slot guard — reject samples that target a slot we already flushed
  // and reaped, because re-creating a bucket here would issue a fresh
  // INSERT OR REPLACE and overwrite the persisted row with fewer samples.
  if (_wasReaped(row.source_ip, row.unit, dateLocal, slot)) {
    stats.samples_dropped_reaped_slot += 1;
    return;
  }

  let b = buckets.get(key);
  if (!b || b.dateLocal !== dateLocal || b.slotIndex !== slot) {
    if (b) {
      _flush(b);     // close out the previous slot before starting the new one
    }
    b = _newBucket(row.source_ip, row.unit, dateLocal, slot, tsMs);
    buckets.set(key, b);
  } else if (b.lastAcceptedTsMs > 0 && tsMs < b.lastAcceptedTsMs - 1000) {
    // Out-of-order sample — older than the latest one we already accumulated
    // by more than 1 s. Reject so a delayed Modbus reply doesn't drag the
    // bucket's tsMs (and the persisted row's reported time-of-last-sample)
    // backwards.
    stats.samples_dropped_oo_order += 1;
    return;
  }
  _accum(b, row);
}

function flushAll() {
  for (const [key, b] of buckets) {
    _flush(b);
    buckets.delete(key);
  }
}

function flushAndStop() {
  // Called by the gateway shutdown sequence so partial buckets persist.
  if (_reaperHandle) {
    clearInterval(_reaperHandle);
    _reaperHandle = null;
  }
  let flushed = 0;
  for (const [key, b] of buckets) {
    if (_flush(b)) flushed += 1;
    buckets.delete(key);
  }
  stats.shutdown_flushes += flushed;
  return { flushed };
}

function reapStale() {
  const now = Date.now();
  let count = 0;
  const todayLocal = _formatDateLocal(now);
  const pastDaysToFinalize = new Set();
  for (const [key, b] of buckets) {
    const slotEnd = _slotEndMs(b.dateLocal, b.slotIndex);
    if (now > slotEnd + FLUSH_GRACE_MS) {
      if (b.dateLocal < todayLocal) pastDaysToFinalize.add(b.dateLocal);
      _flush(b);
      buckets.delete(key);
      count += 1;
    }
  }
  if (count > 0) stats.reaped += count;
  if (_markDailyUnitsFinal && pastDaysToFinalize.size > 0) {
    for (const day of pastDaysToFinalize) {
      try { _markDailyUnitsFinal(day); } catch (_) { /* non-fatal */ }
    }
  }
}

// Expose the in-progress bucket for the live UI tile. Returns the
// CURRENTLY filling row's averages (sample_count > 0) — never persisted
// data. Read-side endpoints should union this with the persisted rows
// to render today's table without a 5-minute gap at the bottom.
function getCurrentBucket(ip, slave) {
  const b = buckets.get(`${ip}|${Number(slave)}`);
  if (!b || b.sampleCount === 0) return null;
  return {
    inverter_ip: b.ip,
    slave: b.slave,
    date_local: b.dateLocal,
    slot_index: b.slotIndex,
    ts_ms: b.tsMs,
    vdc_v:    _avg(b.sumVdc,  b.nVdc,  1),
    idc_a:    _avg(b.sumIdc,  b.nIdc,  2),
    pdc_w:    b.nPdc ? Math.round(b.sumPdc / b.nPdc) : null,
    vac1_v:   _avg(b.sumVac1, b.nVac1, 1),
    vac2_v:   _avg(b.sumVac2, b.nVac2, 1),
    vac3_v:   _avg(b.sumVac3, b.nVac3, 1),
    iac1_a:   _avg(b.sumIac1, b.nIac1, 2),
    iac2_a:   _avg(b.sumIac2, b.nIac2, 2),
    iac3_a:   _avg(b.sumIac3, b.nIac3, 2),
    temp_c:   b.nTemp ? Math.round(b.sumTemp / b.nTemp) : null,
    pac_w:    b.nPac ? Math.round(b.sumPac / b.nPac) : null,
    cosphi:   _avg(b.sumCos, b.nCos, 3),
    freq_hz:  _avg(b.sumFreq, b.nFreq, 2),
    inv_alarms: Number(b.invAlarms) >>> 0,
    track_alarms: Number(b.trackAlarms) >>> 0,
    parce_kwh: b.parceLast != null ? Number(b.parceLast) : null,
    // v2.10.x Slice β — slow-poll fields (additive)
    qac_var_avg:         b.nQacVar ? _avg(b.sumQacVar, b.nQacVar, 1) : null,
    tempint_c_min:       b.minTempInt,
    tempint_c_max:       b.maxTempInt,
    tempint_c_avg:       b.nTempInt ? _avg(b.sumTempInt, b.nTempInt, 2) : null,
    zpos_kohm_min:       b.minZpos,
    zpos_kohm_max:       b.maxZpos,
    zpos_kohm_last:      b.zposLast,
    zneg_kohm_min:       b.minZneg,
    zneg_kohm_max:       b.maxZneg,
    zneg_kohm_last:      b.znegLast,
    vpv_n_v_min:         b.minVpvN,
    vpv_n_v_max:         b.maxVpvN,
    vpv_n_v_avg:         b.nVpvN ? _avg(b.sumVpvN, b.nVpvN, 1) : null,
    vpv_p_v_min:         b.minVpvP,
    vpv_p_v_max:         b.maxVpvP,
    vpv_p_v_avg:         b.nVpvP ? _avg(b.sumVpvP, b.nVpvP, 1) : null,
    nominal_power_w_last: b.nominalPowerLast,
    time_to_connect_s_min: b.minTimeConnect,
    time_to_connect_s_max: b.maxTimeConnect,
    time_to_connect_s_avg: b.nTimeConnect ? _avg(b.sumTimeConnect, b.nTimeConnect, 0) : null,
    time_to_connect_total_s_min: b.minTimeConnectTotal,
    time_to_connect_total_s_max: b.maxTimeConnectTotal,
    time_to_connect_total_s_avg: b.nTimeConnectTotal ? _avg(b.sumTimeConnectTotal, b.nTimeConnectTotal, 0) : null,
    alarms_inst_32_max:  Number(b.alarmsInst32Max) >>> 0,
    alarms_maint_32_max: Number(b.alarmsMaint32Max) >>> 0,
    power_reduction_bits_last: b.powerReductionBitsLast,
    analog_in_1_avg:     b.nAnalogIn1 ? _avg(b.sumAnalogIn1, b.nAnalogIn1, 0) : null,
    analog_in_2_avg:     b.nAnalogIn2 ? _avg(b.sumAnalogIn2, b.nAnalogIn2, 0) : null,
    analog_in_3_avg:     b.nAnalogIn3 ? _avg(b.sumAnalogIn3, b.nAnalogIn3, 0) : null,
    analog_in_4_avg:     b.nAnalogIn4 ? _avg(b.sumAnalogIn4, b.nAnalogIn4, 0) : null,
    pt100_1_last:        b.pt100_1Last,
    pt100_2_last:        b.pt100_2Last,
    inverter_state_raw_last: b.inverterStateRawLast,
    // v2.11.x Slice κ — grid-connection cycle counters (K1 wear).
    conex_lifetime_last:   b.conexLifetimeLast,
    conex_resettable_last: b.conexResettableLast,
    sample_count: b.sampleCount,
    is_complete: 0,
    in_solar_window: _isSolarWindow(b.slotIndex) ? 1 : 0,
    // Slot start in local-wall-clock ms — lets the totals strip scale the
    // live bucket's contribution by elapsed-within-slot (avoids overstating
    // PAC-INTEGRATED at slot start by projecting current avg through the
    // entire 5-min window).
    slot_start_ms: _slotEndMs(b.dateLocal, b.slotIndex) - SLOT_MIN * 60_000,
  };
}

// Diagnostic snapshot for /api/params/diagnostics. All counters are
// monotonically increasing since process start.
function getStats() {
  return {
    ...stats,
    in_memory_buckets: buckets.size,
    reaped_slot_memory: reapedSlots.size,
  };
}

// ─── Slot coverage report (gap detection for the operator) ────────────────
//
// Returns the same shape as `computeSlotCoverage()` plus identifying
// (inverter_ip, slave, date_local) fields, so the Daily Data Export and
// the GET /api/params/:inv/:slave/coverage/:date endpoint can show
// "X of Y slots captured today" + a list of missing HH:MM ranges.
//
// Pure math lives in dailyAggregatorCoverage.js — this wrapper just
// resolves the present-slot list from SQLite and the solar window from
// settings.

function getSlotCoverage(inverterIp, slave, dateLocal) {
  if (!_db) throw new Error("dailyAggregator.getSlotCoverage: not initialized");
  const ip = String(inverterIp || "").trim();
  const sl = Number(slave);
  const day = String(dateLocal || "").trim();
  if (!ip)                        throw new Error("inverter_ip is required");
  if (!Number.isFinite(sl) || sl <= 0) throw new Error("slave must be a positive integer");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("date_local must be YYYY-MM-DD");

  let presentSlots = [];
  try {
    const rows = _db
      .prepare(`
        SELECT slot_index FROM inverter_5min_param
         WHERE inverter_ip = ? AND slave = ? AND date_local = ?
           AND in_solar_window = 1
      `)
      .all(ip, sl, day);
    presentSlots = rows.map((r) => Number(r.slot_index)).filter((n) => Number.isFinite(n));
  } catch (err) {
    console.warn("[dailyAgg] coverage query failed:", err?.message || err);
  }

  const report = computeSlotCoverage({
    presentSlots,
    solarWindowStartHour: _solarWindowStartHour(),
    eodSnapshotHourLocal: _eodSnapshotHour(),
    slotMinutes: SLOT_MIN,
  });
  return {
    inverter_ip: ip,
    slave: sl,
    date_local: day,
    solar_window_start_hour: _solarWindowStartHour(),
    eod_snapshot_hour_local: _eodSnapshotHour(),
    slot_minutes: SLOT_MIN,
    ...report,
  };
}

// ─── Retention pruner ──────────────────────────────────────────────────────

// v2.11.2 — inverter_5min_param archive is finally wired. The hot table
// keeps gaining diagnostic columns via ensureColumn migrations (parce_kwh,
// qac_var_avg, tempint_c_*, zpos/zneg kohm, vpv_n/p_v, time_to_connect_*,
// alarms_inst_32_max, analog_in_*, pt100_*, inverter_state_raw_last, etc.),
// so the archive shard mirrors the hot schema DYNAMICALLY via PRAGMA
// table_info inside server/db.js#archiveTableBeforeCutoff — every future
// ensureColumn flows through automatically without a static-DDL bug.
//
// The archive helper is injected by the cron caller (server/index.js) to
// keep this module free of a circular ./db require. If injection is
// missing we fall back to the legacy DELETE — bounded by the 7-day floor
// — and log loudly so the operator sees it.
async function pruneRetention(retainDays, opts = {}) {
  if (!_db) return { archived: 0 };
  const archiveTableBeforeCutoff =
    opts && typeof opts.archiveTableBeforeCutoff === "function"
      ? opts.archiveTableBeforeCutoff
      : null;
  const days = Math.max(7, Math.min(3650, Number(retainDays) || 365));
  const cutoff = new Date(Date.now() - days * 86400_000);
  const cutoffStr = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, "0")}-${String(cutoff.getDate()).padStart(2, "0")}`;
  try {
    if (archiveTableBeforeCutoff) {
      const migrated = await archiveTableBeforeCutoff({
        tableName: "inverter_5min_param",
        cutoffColumn: "date_local",
        cutoffValue: cutoffStr,
        monthKeyColumn: "date_local",
        monthKeyKind: "date_string",
      });
      return { archived: migrated || 0, cutoff: cutoffStr };
    }
    console.warn(
      "[dailyAgg] archive injector missing — falling back to DELETE (5-min param data loss).",
    );
    const r = _db.prepare(`DELETE FROM inverter_5min_param WHERE date_local < ?`).run(cutoffStr);
    return { archived: 0, deleted: r.changes || 0, cutoff: cutoffStr };
  } catch (err) {
    console.warn("[dailyAgg] prune failed:", err?.message || err);
    return { archived: 0, error: String(err?.message || err) };
  }
}

module.exports = {
  init,
  ingestLiveSample,
  flushAll,
  flushAndStop,
  getCurrentBucket,
  getStats,
  getSlotCoverage,
  pruneRetention,
  // exposed for tests
  _internal: { buckets, reapedSlots, stats, _slotIndex, _formatDateLocal, _localParts, _isSolarWindow, _slotEndMs },
};
