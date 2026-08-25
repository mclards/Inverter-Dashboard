"use strict";
/**
 * dayAheadLock.js — Day-ahead locked snapshot capture (v2.8+).
 *
 * At or before 10 AM local on day D, freeze the Solcast P10/P50/P90 forecast
 * for day D+1 (the WESM FAS submission target) into `solcast_dayahead_locked`.
 *
 * Contract:
 *   - First-write-wins per (forecast_day, slot). Subsequent captures are no-ops.
 *   - Reads from the existing `solcast_snapshots` table. Caller is responsible
 *     for ensuring autoFetchSolcastSnapshots() has been called first if freshness matters.
 *   - Spread normalization uses plant capacity (NOT P50) to avoid dawn/dusk blow-up.
 *
 * Exports:
 *   captureDayAheadSnapshot(forecastDay, reason, options) -> Promise<{ ok, ... }>
 *
 * Non-exports (also exported for unit testing):
 *   _computeSpreadPctCap, _buildLockedRowFromSnapshot
 */

const {
  bulkInsertDayAheadLocked,
  countDayAheadLockedForDay,
  getSolcastSnapshotForDay,
} = require("./db");

// T2.8 fix (Phase 5, 2026-04-14): in-process lock to serialise concurrent
// captures of the same forecast_day.  The DB schema already enforces
// uniqueness via PRIMARY KEY (forecast_day, slot) and bulkInsertDayAheadLocked
// uses INSERT OR IGNORE, so duplicate ROWS are not possible — but two
// concurrent callers could each pass the "already locked?" check and both
// claim "I inserted N rows" when only the first actually did.  The lock
// here ensures callers serialise per forecast_day so the counter and
// return-value semantics match reality.
const _captureLocks = new Map(); // forecast_day -> Promise resolving when in-flight capture done

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function _toNumOrNull(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Compute spread_pct_cap robustly. Uses plant capacity as denominator so
 * dawn/dusk slots (where P50 → 0) don't explode to 12,000%+.
 * Returns null if plant capacity is unknown/zero.
 */
function _computeSpreadPctCap(p10, p90, plantCapMw) {
  if (!_isFiniteNumber(p10) || !_isFiniteNumber(p90)) return null;
  if (!_isFiniteNumber(plantCapMw) || plantCapMw <= 0) return null;
  const spread = p90 - p10;
  if (!Number.isFinite(spread)) return null;
  return (spread / plantCapMw) * 100;
}

/**
 * Build one row payload for `solcast_dayahead_locked` from a
 * `solcast_snapshots` source row.
 */
function _buildLockedRowFromSnapshot(snap, meta) {
  const p10 = _toNumOrNull(snap.forecast_lo_mw);
  const p90 = _toNumOrNull(snap.forecast_hi_mw);
  const p50 = _toNumOrNull(snap.forecast_mw);
  const spreadMw =
    _isFiniteNumber(p10) && _isFiniteNumber(p90) ? p90 - p10 : null;
  return {
    forecast_day: String(snap.forecast_day),
    slot: Number(snap.slot),
    ts_local: Number(snap.ts_local || 0),
    period_end_utc: snap.period_end_utc != null ? String(snap.period_end_utc) : null,
    period: snap.period != null ? String(snap.period) : null,
    p50_mw: p50,
    p10_mw: p10,
    p90_mw: p90,
    p50_kwh: _toNumOrNull(snap.forecast_kwh),
    p10_kwh: _toNumOrNull(snap.forecast_lo_kwh),
    p90_kwh: _toNumOrNull(snap.forecast_hi_kwh),
    spread_mw: spreadMw,
    spread_pct_cap: _computeSpreadPctCap(p10, p90, meta.plantCapMw),
    captured_ts: meta.capturedTs,
    captured_local: meta.capturedLocal,
    capture_reason: meta.captureReason,
    solcast_source: String(snap.source || meta.defaultSource || "toolkit"),
    plant_cap_mw: meta.plantCapMw != null ? Number(meta.plantCapMw) : null,
  };
}

function _formatLocalTs(ts) {
  try {
    const d = new Date(Number(ts));
    if (!Number.isFinite(d.getTime())) return "";
    const pad2 = (n) => String(n).padStart(2, "0");
    return (
      `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
      `T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
    );
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Public: captureDayAheadSnapshot
// ---------------------------------------------------------------------------

/**
 * Capture and freeze the day-ahead forecast for `forecastDay` into
 * `solcast_dayahead_locked`. First-write-wins — if already locked, returns
 * `{ ok: true, reason: 'already_locked', inserted: 0, existing }`.
 *
 * @param {string} forecastDay   YYYY-MM-DD of the target day to lock
 * @param {string} reason        Capture reason: 'scheduled_0600' | 'scheduled_0955' | 'manual'
 * @param {object} options       { plantCapMw: number }  — required for spread_pct_cap
 * @returns {Promise<{ok: boolean, reason?: string, inserted?: number, ...}>}
 */
async function captureDayAheadSnapshot(forecastDay, reason, options = {}) {
  const day = String(forecastDay || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return { ok: false, error: "invalid_forecast_day" };
  }
  // T2.8 fix (Phase 5): if another caller is mid-capture for this day,
  // wait for it and report back the same result so we never report a
  // false "inserted" count when DB-level INSERT OR IGNORE silently
  // dropped our rows.
  const inflight = _captureLocks.get(day);
  if (inflight) {
    try {
      const prior = await inflight;
      return {
        ok: true,
        reason: "already_in_progress",
        inserted: 0,
        existing: countDayAheadLockedForDay(day),
        forecast_day: day,
        capture_reason: String(reason || "manual").trim() || "manual",
        joined_with: prior?.capture_reason || null,
      };
    } catch {
      // prior capture failed — fall through and try ourselves.
    }
  }

  const promise = _doCapture(day, reason, options);
  _captureLocks.set(day, promise);
  try {
    return await promise;
  } finally {
    _captureLocks.delete(day);
  }
}

async function _doCapture(day, reason, options) {
  const captureReason = String(reason || "manual").trim() || "manual";
  const plantCapMw = _toNumOrNull(options?.plantCapMw);

  // Short-circuit: already locked?
  const existing = countDayAheadLockedForDay(day);
  if (existing > 0) {
    return {
      ok: true,
      reason: "already_locked",
      inserted: 0,
      existing,
      forecast_day: day,
      capture_reason: captureReason,
    };
  }

  // Read source snapshot rows from solcast_snapshots
  const srcRows = getSolcastSnapshotForDay(day);
  if (!srcRows || srcRows.length === 0) {
    return {
      ok: false,
      reason: "no_snapshot_rows",
      forecast_day: day,
      capture_reason: captureReason,
    };
  }

  // Filter out rows without P50 — past-day rows where forecast_mw was erased.
  // We only lock actual forecasts (P50 present). Rows with only est_actual_mw
  // are not valid day-ahead snapshots.
  const forecastable = srcRows.filter((r) => r.forecast_mw != null);
  if (forecastable.length === 0) {
    return {
      ok: false,
      reason: "no_forecast_rows",
      forecast_day: day,
      capture_reason: captureReason,
      src_rows: srcRows.length,
    };
  }

  // Build capture meta (timestamps shared across all slots)
  const now = Date.now();
  const meta = {
    capturedTs: now,
    capturedLocal: _formatLocalTs(now),
    captureReason,
    plantCapMw,
    defaultSource: forecastable[0]?.source || "toolkit",
  };

  const rowsToInsert = forecastable.map((r) => _buildLockedRowFromSnapshot(r, meta));

  let inserted = 0;
  try {
    inserted = bulkInsertDayAheadLocked(rowsToInsert);
  } catch (err) {
    return {
      ok: false,
      reason: "insert_failed",
      error: err?.message || String(err),
      forecast_day: day,
      capture_reason: captureReason,
    };
  }

  // Compute a quick spread summary for logging/audit
  const spreadSamples = rowsToInsert
    .map((r) => r.spread_pct_cap)
    .filter((v) => v != null && Number.isFinite(v));
  const spreadAvg =
    spreadSamples.length > 0
      ? spreadSamples.reduce((a, b) => a + b, 0) / spreadSamples.length
      : null;
  const spreadMax =
    spreadSamples.length > 0 ? Math.max(...spreadSamples) : null;

  return {
    ok: true,
    reason: "captured",
    inserted,
    forecast_day: day,
    capture_reason: captureReason,
    captured_ts: now,
    captured_local: meta.capturedLocal,
    src_rows: srcRows.length,
    forecastable_rows: forecastable.length,
    plant_cap_mw: plantCapMw,
    spread_pct_cap_avg: spreadAvg,
    spread_pct_cap_max: spreadMax,
    source: meta.defaultSource,
  };
}

module.exports = {
  captureDayAheadSnapshot,
  // Exposed for unit testing / direct callers
  _computeSpreadPctCap,
  _buildLockedRowFromSnapshot,
};
