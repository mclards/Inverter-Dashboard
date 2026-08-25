"use strict";

/**
 * server/stopReasons.js — Slice B of v2.10.0.
 *
 * Owns SQLite persistence for the StopReason snapshots that Python's
 * `POST /stop-reasons/{inverter}/{slave}` endpoint returns. Used both by
 * the operator-facing `POST /api/stop-reasons/:inverter/refresh` route
 * and by Slice F's auto-capture hook in `server/alarms.js`.
 *
 * Architecture decision: Python is read-only (parses + serializes); Node
 * owns all SQLite writes. Mirrors the v2.9.0 counter-recovery pattern.
 */

const { lookupMotiveLabel, lookupMotiveDescription } = require("./motiveLabels");

const NODE_MAX_SUPPORTED = 3; // v2.10.0 cap

function _safeInt(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function _safeReal(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Insert (or skip via UNIQUE) one decoded StopReason record.
 * Returns the row id, or null if the UNIQUE constraint deduped this read.
 */
function persistStopReasonRow(db, {
  inverterId, inverterIp, slave, node,
  readAtMs, eventAtMs, triggerSource, alarmId,
  record,        // services/stop_reason.StopReasonRecord serialized as dict
  rawHex,
  fingerprint,
}) {
  const motparoLabel = lookupMotiveLabel(_safeInt(record?.motparo, -1));
  try {
    const r = db.prepare(`
      INSERT INTO inverter_stop_reasons
        (inverter_id, inverter_ip, slave, node,
         read_at_ms, event_at_ms, trigger_source, alarm_id,
         pot_ac, vpv,
         vac1, vac2, vac3, iac1, iac2,
         frec1, frec2, frec3, cos, temp,
         alarma, motparo, motparo_label,
         alarmas1, alarmas2, flags,
         ref1, pos1, ref2, pos2,
         timeout_band, debug_desc,
         struct_month, struct_day, struct_hour, struct_min,
         raw_hex, fingerprint, updated_ts)
      VALUES (?, ?, ?, ?,
              ?, ?, ?, ?,
              ?, ?,
              ?, ?, ?, ?, ?,
              ?, ?, ?, ?, ?,
              ?, ?, ?,
              ?, ?, ?,
              ?, ?, ?, ?,
              ?, ?,
              ?, ?, ?, ?,
              ?, ?, ?)
    `).run(
      _safeInt(inverterId, 0), String(inverterIp), _safeInt(slave, 0), _safeInt(node, 0),
      _safeInt(readAtMs, Date.now()), _safeInt(eventAtMs), String(triggerSource || "manual"), _safeInt(alarmId),
      _safeReal(record?.pot_ac), _safeReal(record?.vpv),
      _safeReal(record?.vac1), _safeReal(record?.vac2), _safeReal(record?.vac3),
      _safeReal(record?.iac1), _safeReal(record?.iac2),
      _safeReal(record?.frec1), _safeReal(record?.frec2), _safeReal(record?.frec3),
      _safeReal(record?.cos), _safeInt(record?.temp),
      _safeInt(record?.alarma, 0), _safeInt(record?.motparo, 0), motparoLabel,
      _safeInt(record?.alarmas1), _safeInt(record?.alarmas2), _safeInt(record?.flags),
      _safeInt(record?.ref1), _safeInt(record?.pos1),
      _safeInt(record?.ref2), _safeInt(record?.pos2),
      _safeInt(record?.timeout_band), _safeInt(record?.debug_desc, 0),
      _safeInt(record?.mes_dia_month), _safeInt(record?.mes_dia_day),
      _safeInt(record?.hora_min_hour), _safeInt(record?.hora_min_min),
      String(rawHex || ""), String(fingerprint || ""), Date.now(),
    );
    return Number(r.lastInsertRowid);
  } catch (err) {
    if (/UNIQUE/i.test(String(err?.message || ""))) {
      // Dedup — return the existing row's id so the caller can still
      // FK-link the new alarm to the prior snapshot.  Without this, a
      // re-fired identical fault leaves alarms.stop_reason_id NULL even
      // though a perfectly good snapshot row exists.
      try {
        const existing = db.prepare(`
          SELECT id FROM inverter_stop_reasons
          WHERE inverter_ip = ? AND slave = ? AND node = ? AND fingerprint = ?
        `).get(String(inverterIp), Number(slave) || 0, Number(node) || 0, String(fingerprint || ""));
        return existing?.id ? Number(existing.id) : null;
      } catch (_) {
        return null;
      }
    }
    throw err;
  }
}

/**
 * Insert one ARRAYHISTMOTPARO snapshot row.
 */
function persistHistogramRow(db, {
  inverterId, inverterIp, slave,
  readAtMs, totalCount, counters, rawHex,
}) {
  const r = db.prepare(`
    INSERT INTO inverter_stop_histogram
      (inverter_id, inverter_ip, slave, read_at_ms,
       total_count, counters_json, raw_hex, updated_ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    _safeInt(inverterId, 0), String(inverterIp), _safeInt(slave, 0),
    _safeInt(readAtMs, Date.now()),
    _safeInt(totalCount, 0),
    JSON.stringify(Array.isArray(counters) ? counters : []),
    String(rawHex || ""),
    Date.now(),
  );
  return Number(r.lastInsertRowid);
}

/**
 * Take one Python `/stop-reasons/{inverter}/{slave}` response and persist
 * everything in a single SQLite transaction.
 *
 * Returns:
 *   {
 *     persisted: [ { node, eventId, deduped: false }, ... ],
 *     histogramId: number | null,
 *   }
 */
function persistEngineResponse(db, payload, {
  inverterId, inverterIp, slave,
  triggerSource = "manual", eventAtMs = null, alarmId = null,
} = {}) {
  if (!payload || !Array.isArray(payload.nodes)) {
    return { persisted: [], histogramId: null };
  }
  const readAtMs = _safeInt(payload.read_at_ms, Date.now());
  const out = { persisted: [], histogramId: null };

  db.transaction(() => {
    for (const node of payload.nodes) {
      if (!node?.ok || !node?.record) {
        out.persisted.push({
          node: _safeInt(node?.node, 0),
          eventId: null,
          deduped: false,
          error: String(node?.error || "no_record"),
        });
        continue;
      }
      try {
        // The first call may return either a brand-new id OR (after the
        // 2026-04-27 fix) the existing row's id when UNIQUE dedup fired.
        // Detect the dedup case by checking whether the resolved id was
        // freshly inserted: lastInsertRowid would equal eventId.  Since
        // persistStopReasonRow no longer raises on UNIQUE, the simpler
        // signal is "did our INSERT execute?" — we infer from a sentinel
        // row count BEFORE insertion vs the returned id.
        const beforeMaxRow = db.prepare(
          `SELECT COALESCE(MAX(id), 0) AS m FROM inverter_stop_reasons`,
        ).get()?.m || 0;
        const eventId = persistStopReasonRow(db, {
          inverterId, inverterIp, slave,
          node: _safeInt(node.node, 0),
          readAtMs,
          eventAtMs,
          triggerSource,
          alarmId,
          record: node.record,
          rawHex: String(node.raw_hex || ""),
          fingerprint: String(node.fingerprint || ""),
        });
        const wasInserted = eventId != null && eventId > beforeMaxRow;
        out.persisted.push({
          node: _safeInt(node.node, 0),
          eventId,                         // resolved id (new or existing)
          deduped: !wasInserted && eventId != null,
          inserted: wasInserted,
        });
      } catch (err) {
        out.persisted.push({
          node: _safeInt(node.node, 0),
          eventId: null,
          deduped: false,
          error: String(err?.message || err),
        });
      }
    }
    if (payload.histogram?.ok && Array.isArray(payload.histogram.counters)) {
      try {
        out.histogramId = persistHistogramRow(db, {
          inverterId, inverterIp, slave,
          readAtMs,
          totalCount: _safeInt(payload.histogram.total, 0),
          counters: payload.histogram.counters,
          rawHex: String(payload.histogram.raw_hex || ""),
        });
      } catch (err) {
        out.histogramError = String(err?.message || err);
      }
    }
  })();

  return out;
}

/**
 * Read recent StopReason rows for one inverter (all nodes).
 * `limit` defaults to 50, hard-capped at 500.
 */
function getRecentForInverter(db, inverterId, limit = 50) {
  const cap = Math.max(1, Math.min(500, _safeInt(limit, 50)));
  const rows = db.prepare(`
    SELECT id, inverter_id, inverter_ip, slave, node,
           read_at_ms, event_at_ms, trigger_source, alarm_id,
           pot_ac, vpv, vac1, vac2, vac3, iac1, iac2,
           frec1, frec2, frec3, cos, temp,
           alarma, motparo, motparo_label,
           alarmas1, alarmas2, flags,
           ref1, pos1, ref2, pos2,
           timeout_band, debug_desc,
           struct_month, struct_day, struct_hour, struct_min,
           raw_hex, fingerprint, updated_ts
    FROM inverter_stop_reasons
    WHERE inverter_id = ?
    ORDER BY read_at_ms DESC
    LIMIT ?
  `).all(_safeInt(inverterId, 0), cap);
  return rows.map(_decorateRow);
}

// v2.11.1-beta.1 — both lookups accept an optional `archiveLookup` function
// that's tried after the hot SELECT returns null. The endpoint wires the
// archive-aware finder from server/db.js (findStopReasonByIdArchiveAware /
// findStopReasonByAlarmIdArchiveAware). _decorateRow is applied to the
// raw archive row so the renderer never has to know whether the row came
// from hot or an archived shard.
function getEventById(db, eventId, { archiveLookup = null } = {}) {
  const id = _safeInt(eventId, 0);
  if (!id) return null;
  let row = db.prepare(`
    SELECT * FROM inverter_stop_reasons WHERE id = ?
  `).get(id);
  if (!row && typeof archiveLookup === "function") {
    try { row = archiveLookup(id); } catch (_) { row = null; }
  }
  return row ? _decorateRow(row) : null;
}

function getEventByAlarmId(db, alarmId, { archiveLookup = null } = {}) {
  const id = _safeInt(alarmId, 0);
  if (!id) return null;
  let row = db.prepare(`
    SELECT * FROM inverter_stop_reasons WHERE alarm_id = ?
    ORDER BY read_at_ms DESC LIMIT 1
  `).get(id);
  if (!row && typeof archiveLookup === "function") {
    try { row = archiveLookup(id); } catch (_) { row = null; }
  }
  return row ? _decorateRow(row) : null;
}

function getLatestHistogramForInverter(db, inverterId) {
  const row = db.prepare(`
    SELECT id, inverter_id, inverter_ip, slave, read_at_ms,
           total_count, counters_json, raw_hex, updated_ts
    FROM inverter_stop_histogram
    WHERE inverter_id = ?
    ORDER BY read_at_ms DESC LIMIT 1
  `).get(_safeInt(inverterId, 0));
  if (!row) return null;
  let counters = [];
  try { counters = JSON.parse(row.counters_json || "[]"); } catch (_) { /* noop */ }
  return {
    id: row.id,
    inverter_id: row.inverter_id,
    inverter_ip: row.inverter_ip,
    slave: row.slave,
    read_at_ms: row.read_at_ms,
    total_count: row.total_count,
    counters,
    raw_hex: row.raw_hex,
    updated_ts: row.updated_ts,
  };
}

function _decorateRow(row) {
  return {
    id: row.id,
    inverter_id: row.inverter_id,
    inverter_ip: row.inverter_ip,
    slave: row.slave,
    node: row.node,
    read_at_ms: row.read_at_ms,
    event_at_ms: row.event_at_ms,
    trigger_source: row.trigger_source,
    alarm_id: row.alarm_id,
    pot_ac: row.pot_ac,
    vpv: row.vpv,
    vac: [row.vac1, row.vac2, row.vac3],
    iac: [row.iac1, row.iac2],
    frec: [row.frec1, row.frec2, row.frec3],
    cos: row.cos,
    temp: row.temp,
    alarma: row.alarma,
    motparo: row.motparo,
    motparo_label: row.motparo_label,
    // v2.10.4 — plain-English description so the drilldown can render
    // "12 — MOTIVO_PARO_FRAMA3 (Frame error 3)" instead of just the
    // Spanish vendor code.
    motparo_english: lookupMotiveDescription(Number(row.motparo)),
    alarmas1: row.alarmas1,
    alarmas2: row.alarmas2,
    flags: row.flags,
    debug_desc: row.debug_desc,
    debug_desc_hex: `0x${Number(row.debug_desc || 0).toString(16).padStart(4, "0").toUpperCase()}`,
    struct_when_dd_mm: row.struct_day != null && row.struct_month != null
      ? `${String(row.struct_day).padStart(2, "0")}/${String(row.struct_month).padStart(2, "0")}`
      : null,
    struct_when_hh_mm: row.struct_hour != null && row.struct_min != null
      ? `${String(row.struct_hour).padStart(2, "0")}:${String(row.struct_min).padStart(2, "0")}`
      : null,
    raw_hex: row.raw_hex,
    fingerprint: row.fingerprint,
  };
}

/**
 * Apply the configured retention window. Default 365 days for
 * inverter_stop_reasons, 90 days for inverter_stop_histogram.
 *
 * v2.11.1-beta.1 — `inverter_stop_reasons` MIGRATES to monthly archive
 * shards via archiveStopReasonsBeforeCutoff. Same close-of-data-loss-gap
 * pattern as the v2.11.0-beta.10 alarms fix: an alarm whose row migrates
 * to its archive shard (after `retainDays`) joins back to its captured
 * StopReason snapshot via findStopReasonByIdArchiveAware so the drilldown
 * panel stays populated indefinitely.
 *
 * v2.11.2 — `inverter_stop_histogram` ALSO MIGRATES (was DELETE-only) via
 * the injected universal archive helper. The histogram is a per-pull
 * snapshot of the inverter's lifetime stop-counter tally; even though it's
 * "regenerable on demand", a regenerated read only captures the current
 * tally and CANNOT reconstruct intermediate values, so DELETE-on-retention
 * permanently lost the time series the analytics panel uses.
 *
 * Returns { reasons: migrated_count, histogram: migrated_count } so the
 * cron log entry still reports activity. Callers that previously read the
 * "deleted" semantics now see migration counts under the same key.
 */
async function pruneOldRows(db, {
  reasonsRetainDays = 365,
  histogramRetainDays = 90,
  archiveStopReasonsBeforeCutoff = null,
  archiveTableBeforeCutoff = null,
} = {}) {
  const now = Date.now();
  const reasonsCutoff = now - Math.max(1, reasonsRetainDays) * 86_400_000;
  const histogramCutoff = now - Math.max(1, histogramRetainDays) * 86_400_000;
  // Migrate (not delete) old stop_reasons rows. `archiveStopReasonsBeforeCutoff`
  // is injected by the cron caller (server/index.js) to keep this module's
  // ./db dependency surface narrow — same DI shape as the rest of stopReasons.
  let reasonsCount = 0;
  if (typeof archiveStopReasonsBeforeCutoff === "function") {
    try {
      reasonsCount = await archiveStopReasonsBeforeCutoff(reasonsCutoff);
    } catch (err) {
      // Surface as a warning but don't sink the histogram prune below.
      console.warn(
        "[stop-reasons] archiveStopReasonsBeforeCutoff failed:",
        err?.message || err,
      );
    }
  } else {
    // Defensive fallback (caller forgot to inject): keep the legacy DELETE
    // so a misconfigured deployment still bounds the table. Logged so the
    // operator notices.
    console.warn(
      "[stop-reasons] archive injector missing — falling back to DELETE (data loss for cleared snapshots > retainDays).",
    );
    const r1 = db
      .prepare(`DELETE FROM inverter_stop_reasons WHERE read_at_ms < ?`)
      .run(reasonsCutoff);
    reasonsCount = Number(r1.changes || 0);
  }
  let histogramCount = 0;
  if (typeof archiveTableBeforeCutoff === "function") {
    try {
      histogramCount = await archiveTableBeforeCutoff({
        tableName: "inverter_stop_histogram",
        cutoffColumn: "read_at_ms",
        cutoffValue: histogramCutoff,
        monthKeyColumn: "read_at_ms",
        monthKeyKind: "ms",
      });
    } catch (err) {
      console.warn(
        "[stop-reasons] archive histogram failed:",
        err?.message || err,
      );
    }
  } else {
    console.warn(
      "[stop-reasons] archive injector missing — falling back to DELETE for histogram.",
    );
    const r2 = db.prepare(`DELETE FROM inverter_stop_histogram WHERE read_at_ms < ?`).run(histogramCutoff);
    histogramCount = Number(r2.changes || 0);
  }
  return { reasons: reasonsCount, histogram: histogramCount };
}

module.exports = {
  NODE_MAX_SUPPORTED,
  persistStopReasonRow,
  persistHistogramRow,
  persistEngineResponse,
  getRecentForInverter,
  getEventById,
  getEventByAlarmId,
  getLatestHistogramForInverter,
  pruneOldRows,
};
