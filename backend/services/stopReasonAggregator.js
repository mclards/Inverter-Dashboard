"use strict";

/**
 * server/stopReasonAggregator.js
 *
 * IGBT and AC-contactor health endpoints originally counted stop events
 * from `inverter_stop_reasons_std` alone. That table is populated only
 * when the operator clicks "Refresh" on the Stop Reasons page — for
 * fleets where no operator ever opens that page, every motive count
 * stays at 0 and the IGBT/Contactor dashboards look empty.
 *
 * Slice F (server/alarmsDiagnostic.js) auto-captures vendor-SCOPE stop
 * reasons on every alarm transition and writes them to
 * `inverter_stop_reasons` (column `motparo`). That data IS routinely
 * present but was invisible to the IGBT/Contactor scores because the
 * queries only hit the `_std` table.
 *
 * This module unifies the two sources so the IGBT/Contactor dashboards
 * surface every captured event regardless of which capture path filled
 * it in:
 *   • `inverter_stop_reasons_std`  — motive_code,   read_at_ms (manual refresh / std fanout)
 *   • `inverter_stop_reasons`      — motparo,       read_at_ms (auto-capture on alarm transition, also manual)
 *
 * Both tables use IP + slave keys, both store `read_at_ms` as the moment
 * the snapshot was read, and both use the same MOTIVO_PARO_* code system.
 *
 * Counting strategy:
 *   We UNION distinct event rows from both tables keyed by
 *   `(motive_code, read_at_ms_bucket_5min)`. The 5-minute bucket on
 *   read_at_ms collapses near-simultaneous re-reads of the same physical
 *   event (e.g. auto-capture at T0 + 500 ms and an operator refresh at
 *   T0 + 60 s). Cross-table dedup is best-effort — different read paths
 *   can stamp read_at_ms minutes apart, so an event captured by both
 *   tables hours apart counts twice. Acceptable for a health-score
 *   heuristic where the ranking matters more than the absolute count.
 */

const READAT_DEDUP_BUCKET_MS = 5 * 60 * 1000;

function _placeholders(arr) {
  return arr.map(() => "?").join(", ");
}

function _normaliseCodes(motiveCodes) {
  if (!Array.isArray(motiveCodes)) return [];
  const out = [];
  for (const c of motiveCodes) {
    const n = Math.trunc(Number(c));
    if (Number.isFinite(n) && n >= 0) out.push(n);
  }
  return [...new Set(out)];
}

/**
 * Count distinct stop events matching the given motive codes for one
 * (inverter_ip, slave) in the rolling window. Combines both tables.
 *
 * @param {Database} db
 * @param {string} ip
 * @param {number} slave
 * @param {number} cutoffMs    Inclusive lower bound on read_at_ms
 * @param {number[]} motiveCodes
 * @returns {number}
 */
function countMotivesCombined(db, ip, slave, cutoffMs, motiveCodes) {
  const codes = _normaliseCodes(motiveCodes);
  if (!ip || !codes.length) return 0;

  const placeholdersA = _placeholders(codes);
  const placeholdersB = _placeholders(codes);
  const sql = `
    SELECT COUNT(*) AS cnt FROM (
      SELECT motive_code AS code,
             (read_at_ms / ${READAT_DEDUP_BUCKET_MS}) AS bucket
        FROM inverter_stop_reasons_std
       WHERE inverter_ip = ? AND slave = ? AND read_at_ms > ?
             AND motive_code IN (${placeholdersA})
      UNION
      SELECT motparo AS code,
             (read_at_ms / ${READAT_DEDUP_BUCKET_MS}) AS bucket
        FROM inverter_stop_reasons
       WHERE inverter_ip = ? AND slave = ? AND read_at_ms > ?
             AND motparo IN (${placeholdersB})
    ) AS u
  `;
  const params = [
    ip, Number(slave), Number(cutoffMs), ...codes,
    ip, Number(slave), Number(cutoffMs), ...codes,
  ];
  try {
    const row = db.prepare(sql).get(...params);
    return Number(row?.cnt || 0);
  } catch (err) {
    // Tables may not exist on fresh installs / minimal test DBs — degrade
    // to single-table count so the endpoint still responds.
    try {
      const fallback = db.prepare(`
        SELECT COUNT(*) AS cnt FROM inverter_stop_reasons_std
         WHERE inverter_ip = ? AND slave = ? AND read_at_ms > ?
               AND motive_code IN (${placeholdersA})
      `).get(ip, Number(slave), Number(cutoffMs), ...codes);
      return Number(fallback?.cnt || 0);
    } catch (_) {
      return 0;
    }
  }
}

/**
 * Most recent stop event across both tables for one (ip, slave).
 *
 * Returns `{ motive_code, read_at_ms, source }` or `null` when nothing
 * matches. `motiveCodes` is optional — when omitted, returns the latest
 * stop event of ANY motive.
 *
 * @returns {{ motive_code: number, read_at_ms: number, source: "std"|"vendor" } | null}
 */
function findLastStopEvent(db, ip, slave, motiveCodes = null) {
  if (!ip) return null;
  const codes = motiveCodes ? _normaliseCodes(motiveCodes) : null;
  if (motiveCodes && (!codes || codes.length === 0)) return null;

  const whereCodesStd = codes ? `AND motive_code IN (${_placeholders(codes)})` : "";
  const whereCodesVdr = codes ? `AND motparo IN (${_placeholders(codes)})` : "";

  let stdRow = null;
  let vdrRow = null;
  try {
    stdRow = db.prepare(`
      SELECT motive_code AS code, read_at_ms FROM inverter_stop_reasons_std
       WHERE inverter_ip = ? AND slave = ? ${whereCodesStd}
       ORDER BY read_at_ms DESC LIMIT 1
    `).get(ip, Number(slave), ...(codes || []));
  } catch (_) { /* table may not exist */ }
  try {
    vdrRow = db.prepare(`
      SELECT motparo AS code, read_at_ms FROM inverter_stop_reasons
       WHERE inverter_ip = ? AND slave = ? ${whereCodesVdr}
       ORDER BY read_at_ms DESC LIMIT 1
    `).get(ip, Number(slave), ...(codes || []));
  } catch (_) { /* table may not exist */ }

  if (!stdRow && !vdrRow) return null;
  if (stdRow && !vdrRow) {
    return { motive_code: Number(stdRow.code), read_at_ms: Number(stdRow.read_at_ms), source: "std" };
  }
  if (vdrRow && !stdRow) {
    return { motive_code: Number(vdrRow.code), read_at_ms: Number(vdrRow.read_at_ms), source: "vendor" };
  }
  const pick = Number(stdRow.read_at_ms) >= Number(vdrRow.read_at_ms) ? stdRow : vdrRow;
  return {
    motive_code: Number(pick.code),
    read_at_ms: Number(pick.read_at_ms),
    source: pick === stdRow ? "std" : "vendor",
  };
}

/**
 * Fetch up to `limit` recent stop-event rows across both tables, ordered
 * most-recent first. Returns rows in a unified shape so the contactor
 * drilldown can render them without caring about the source table.
 *
 * @returns {Array<{ motive_code: number, read_at_ms: number, source: string, timestamp_iso?: string }>}
 */
function listRecentStopEvents(db, ip, slave, cutoffMs, motiveCodes, limit = 50) {
  const codes = _normaliseCodes(motiveCodes);
  if (!ip || !codes.length) return [];

  const lim = Math.max(1, Math.min(500, Math.trunc(Number(limit) || 50)));
  const out = [];
  try {
    const stdRows = db.prepare(`
      SELECT motive_code AS code, read_at_ms, timestamp_iso
        FROM inverter_stop_reasons_std
       WHERE inverter_ip = ? AND slave = ? AND read_at_ms > ?
             AND motive_code IN (${_placeholders(codes)})
       ORDER BY read_at_ms DESC LIMIT ?
    `).all(ip, Number(slave), Number(cutoffMs), ...codes, lim);
    for (const r of stdRows) {
      const readAt = Number(r.read_at_ms);
      out.push({
        motive_code: Number(r.code),
        read_at_ms: readAt,
        // `timestamp_iso` is the inverter's own event clock. Fall back to
        // `read_at_ms` so downstream consumers always have a renderable
        // timestamp — UI code does `new Date(e.timestamp_iso)`.
        timestamp_iso: r.timestamp_iso || new Date(readAt).toISOString(),
        source: "std",
      });
    }
  } catch (_) { /* table may not exist */ }
  try {
    const vdrRows = db.prepare(`
      SELECT motparo AS code, read_at_ms, event_at_ms
        FROM inverter_stop_reasons
       WHERE inverter_ip = ? AND slave = ? AND read_at_ms > ?
             AND motparo IN (${_placeholders(codes)})
       ORDER BY read_at_ms DESC LIMIT ?
    `).all(ip, Number(slave), Number(cutoffMs), ...codes, lim);
    for (const r of vdrRows) {
      const readAt = Number(r.read_at_ms);
      const eventAt = Number(r.event_at_ms);
      // Vendor SCOPE has no ISO column — synthesize one from event_at_ms
      // (preferred when populated) or read_at_ms.
      const tsForIso = Number.isFinite(eventAt) && eventAt > 0 ? eventAt : readAt;
      out.push({
        motive_code: Number(r.code),
        read_at_ms: readAt,
        timestamp_iso: new Date(tsForIso).toISOString(),
        source: "vendor",
      });
    }
  } catch (_) { /* table may not exist */ }

  out.sort((a, b) => b.read_at_ms - a.read_at_ms);
  return out.slice(0, lim);
}

module.exports = {
  countMotivesCombined,
  findLastStopEvent,
  listRecentStopEvents,
  READAT_DEDUP_BUCKET_MS,
};
