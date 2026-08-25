/**
 * server/firmwareMap.js — per-node firmware-version homogeneity.
 *
 * The operator invariant: EVERY inverter node runs the SAME firmware.
 * This is the mirror image of the serial-number feature — serials must be
 * UNIQUE per node; firmware must be UNIFORM across nodes.
 *
 * Architecture notes (carried from serialNumber.js):
 *   • Firmware strings (model_code / firmware_main / firmware_aux) ride the
 *     SAME FC11 Report-Slave-ID payload the serial scan already reads. This
 *     module NEVER drives Modbus — it consumes serialNumber.fleetScan()
 *     rows. One scan, two views; no extra RS-485 traffic.
 *   • Python is read-only for SQLite — Node owns firmware_drift_log /
 *     inverter_firmware_state writes.
 *   • Classification (computeCanonical / classifyFleet / diffForPersist) is
 *     PURE — no I/O — so server/tests/firmwareMap.test.js can exercise it
 *     without the better-sqlite3 Electron/Node ABI dependency.
 */

"use strict";

// ─── Tuple helpers ────────────────────────────────────────────────────────

function _norm(s) {
  return String(s == null ? "" : s).trim().toUpperCase();
}

/**
 * The authoritative firmware identity of a node = `model_code` ONLY.
 *
 * Verified 2026-05-19 against ISM's own decompiled FC11 parser
 * (`IngeconModbusSlaveID_Freescale::SetData`): for our Freescale/Motorola
 * fleet ISM extracts exactly TWO strings from the slave-ID payload —
 * the serial and ONE `Firmware` code (the `AAV1003xx` inverter firmware,
 * which we surface as `model_code`). ISM never populates `FirmwareDisplay`
 * for this hardware family. The extra ASCII at our [70:79]/[86:95]
 * (`firmware_main`/`firmware_aux`, the `AAS…` strings) are NOT a firmware
 * version ISM trusts — they are unverified auxiliary identifiers, kept for
 * diagnostics only and deliberately EXCLUDED from the comparison so blank/
 * variant aux bytes can't falsely flag a node whose real firmware matches.
 */
function fwTuple(row) {
  if (!row) return "";
  return _norm(row.model_code);
}

function _tupleIsEmpty(t) {
  return t == null || t === "";
}

/**
 * Parse a pinned-expected setting value into a firmware code, or null if
 * the operator has not pinned one. Accepts a plain string (the model code,
 * e.g. "AAV1003BC") or an object/JSON carrying `model_code`.
 */
function parseExpectedTuple(raw) {
  if (raw == null || raw === "") return null;
  if (typeof raw === "string") {
    const s = raw.trim();
    // Try JSON object first; otherwise treat the string itself as the code.
    if (s.startsWith("{")) {
      try {
        const obj = JSON.parse(s);
        const t = fwTuple(obj);
        return _tupleIsEmpty(t) ? null : t;
      } catch { return null; }
    }
    const t = _norm(s);
    return _tupleIsEmpty(t) ? null : t;
  }
  if (typeof raw === "object") {
    const t = fwTuple(raw);
    return _tupleIsEmpty(t) ? null : t;
  }
  return null;
}

// ─── Canonical computation ────────────────────────────────────────────────

/**
 * Determine the fleet-canonical firmware tuple.
 *
 * If `expected` (a tuple string) is supplied the operator has PINNED the
 * canonical — it wins outright (defends against a fleet uniformly stuck on
 * an old build reading all-green). Otherwise the modal tuple across all
 * OK-and-non-empty scan rows is used; ties broken by lexical order so the
 * result is deterministic (test-locked).
 *
 * @returns { canonical: string|null, counts: {tuple:count}, pinned: bool }
 */
function computeCanonical(rows, expected = null) {
  const counts = {};
  for (const r of rows || []) {
    if (!r || !r.ok) continue;
    const t = fwTuple(r);
    if (_tupleIsEmpty(t)) continue;
    counts[t] = (counts[t] || 0) + 1;
  }
  if (expected) return { canonical: expected, counts, pinned: true };

  let best = null;
  let bestN = -1;
  for (const t of Object.keys(counts).sort()) {
    if (counts[t] > bestN) { best = t; bestN = counts[t]; }
  }
  return { canonical: best, counts, pinned: false };
}

// ─── Fleet classification ─────────────────────────────────────────────────

/**
 * Classify a scan by firmware code (model_code — the authoritative
 * `AAV1003xx` inverter firmware; see fwTuple()).
 *
 * Per-node status:
 *   ok      — firmware == canonical
 *   bad     — firmware != canonical
 *   unknown — node did not answer / carried no firmware code
 *
 * Per-inverter verdict (over its readable nodes):
 *   uniform — all readable nodes share one firmware code
 *   split   — readable nodes disagree (post-board-swap signature)
 *   partial — at least one node unknown (and the rest uniform)
 *   none    — no node readable
 *
 * (The UI judges each inverter only against ITS OWN nodes; the
 * fleet-wide canonical/summary here is retained but UI-unused.)
 */
function classifyFleet(rows, expected = null) {
  const list = Array.isArray(rows) ? rows : [];
  const { canonical, counts, pinned } = computeCanonical(list, expected);

  const perNode = list.map((r) => {
    const ok = Boolean(r && r.ok);
    const tuple = ok ? fwTuple(r) : null;
    let status;
    if (!ok || _tupleIsEmpty(tuple)) status = "unknown";
    else if (canonical && tuple === canonical) status = "ok";
    else status = "bad";
    return {
      inverter_id: r && r.inverter_id != null ? r.inverter_id : null,
      inverter_name: (r && r.inverter_name) || null,
      inverter_ip: (r && r.inverter_ip) || null,
      slave: r && r.slave != null ? r.slave : null,
      model_code: ok ? (r.model_code || null) : null,
      firmware_main: ok ? (r.firmware_main || null) : null,
      firmware_aux: ok ? (r.firmware_aux || null) : null,
      tuple: status === "unknown" ? null : tuple,
      status,
      error: (r && r.error) || null,
    };
  });

  // Group by inverter for the per-inverter verdict.
  const byInv = new Map();
  for (const n of perNode) {
    const key = n.inverter_ip || `id:${n.inverter_id}`;
    if (!byInv.has(key)) {
      byInv.set(key, {
        inverter_id: n.inverter_id,
        inverter_name: n.inverter_name,
        inverter_ip: n.inverter_ip,
        nodes: [],
      });
    }
    byInv.get(key).nodes.push(n);
  }

  const perInverter = [];
  for (const inv of byInv.values()) {
    const readable = inv.nodes.filter((n) => n.status !== "unknown");
    const distinct = new Set(readable.map((n) => n.tuple));
    let verdict;
    if (readable.length === 0) verdict = "none";
    else if (distinct.size > 1) verdict = "split";
    else if (readable.length < inv.nodes.length) verdict = "partial";
    else verdict = "uniform";
    const anyDrift = readable.some((n) => n.status === "bad");
    perInverter.push({
      inverter_id: inv.inverter_id,
      inverter_name: inv.inverter_name,
      inverter_ip: inv.inverter_ip,
      verdict,
      drifted: anyDrift,
      node_count: inv.nodes.length,
      readable_count: readable.length,
      tuples: Array.from(distinct),
      nodes: inv.nodes,
    });
  }
  // Stable IP-octet sort (mirrors _snbRenderFleetTable ordering).
  perInverter.sort((a, b) => _ipKey(a.inverter_ip) - _ipKey(b.inverter_ip));

  const okCount = perNode.filter((n) => n.status === "ok").length;
  const badCount = perNode.filter((n) => n.status === "bad").length;
  const unknownCount = perNode.filter((n) => n.status === "unknown").length;

  return {
    canonical,
    canonical_pinned: pinned,
    tuple_counts: counts,
    perNode,
    perInverter,
    summary: {
      total_nodes: perNode.length,
      ok: okCount,
      drift: badCount,
      unknown: unknownCount,
      homogeneous: badCount === 0 && okCount > 0,
      split_inverters: perInverter.filter((i) => i.verdict === "split").length,
    },
  };
}

function _ipKey(ip) {
  if (!ip) return Number.MAX_SAFE_INTEGER;
  const parts = String(ip).split(".").map((x) => parseInt(x, 10));
  if (parts.length !== 4 || parts.some((p) => !Number.isFinite(p))) {
    return Number.MAX_SAFE_INTEGER - 1;
  }
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

// ─── Persistence diff (pure) ──────────────────────────────────────────────

/**
 * Diff the previous persisted state against a fresh classified scan.
 *
 * @param prevStateRows rows from getFirmwareStateAll() (DB shape)
 * @param classified    output of classifyFleet()
 * @param nowMs          injected clock (testable)
 * @returns { upserts:[stateRow], driftEvents:[logRow] }
 *
 * A drift event is emitted ONLY when a node that was previously seen with a
 * non-empty firmware code (model_code) now reports a DIFFERENT non-empty
 * code. First-ever sightings and unknown reads never log drift; changes in
 * the unverified aux strings alone are NOT drift (model_code is the only
 * authoritative firmware identity — see fwTuple()).
 */
function diffForPersist(prevStateRows, classified, nowMs = Date.now()) {
  const prev = new Map();
  for (const p of prevStateRows || []) {
    prev.set(`${p.inverter_ip}|${p.slave}`, p);
  }
  const upserts = [];
  const driftEvents = [];

  for (const n of classified.perNode) {
    if (n.status === "unknown") continue; // don't clobber a good snapshot
    const key = `${n.inverter_ip}|${n.slave}`;
    const before = prev.get(key);
    const newTuple = n.tuple;
    upserts.push({
      inverter_ip: n.inverter_ip,
      slave: n.slave,
      inverter_id: n.inverter_id || 0,
      model_code: n.model_code,
      firmware_main: n.firmware_main,
      firmware_aux: n.firmware_aux,
      canonical_match: n.status === "ok" ? 1 : 0,
      first_seen_ms: before && before.first_seen_ms ? before.first_seen_ms : nowMs,
      last_seen_ms: nowMs,
    });
    if (before) {
      const oldTuple = _norm(before.model_code);
      if (!_tupleIsEmpty(oldTuple) && oldTuple !== newTuple) {
        driftEvents.push({
          inverter_id: n.inverter_id || 0,
          inverter_ip: n.inverter_ip,
          slave: n.slave,
          old_tuple: oldTuple,
          new_tuple: newTuple,
          detected_at_ms: nowMs,
          note: `firmware changed ${oldTuple} -> ${newTuple}`,
        });
      }
    }
  }
  return { upserts, driftEvents };
}

// ─── Persistence helpers (db handle injected — same shape as serialNumber.js)

function upsertFirmwareState(db, rows) {
  if (!rows || !rows.length) return 0;
  const stmt = db.prepare(`
    INSERT INTO inverter_firmware_state
      (inverter_ip, slave, inverter_id, model_code, firmware_main,
       firmware_aux, canonical_match, first_seen_ms, last_seen_ms)
    VALUES (@inverter_ip, @slave, @inverter_id, @model_code, @firmware_main,
            @firmware_aux, @canonical_match, @first_seen_ms, @last_seen_ms)
    ON CONFLICT(inverter_ip, slave) DO UPDATE SET
      inverter_id     = excluded.inverter_id,
      model_code      = excluded.model_code,
      firmware_main   = excluded.firmware_main,
      firmware_aux    = excluded.firmware_aux,
      canonical_match = excluded.canonical_match,
      last_seen_ms    = excluded.last_seen_ms
  `);
  const tx = db.transaction((list) => {
    for (const r of list) {
      stmt.run({
        inverter_ip: String(r.inverter_ip),
        slave: Number(r.slave) || 0,
        inverter_id: Number(r.inverter_id) || 0,
        model_code: r.model_code == null ? null : String(r.model_code),
        firmware_main: r.firmware_main == null ? null : String(r.firmware_main),
        firmware_aux: r.firmware_aux == null ? null : String(r.firmware_aux),
        canonical_match:
          r.canonical_match == null ? null : (r.canonical_match ? 1 : 0),
        first_seen_ms: Number(r.first_seen_ms) || Date.now(),
        last_seen_ms: Number(r.last_seen_ms) || Date.now(),
      });
    }
  });
  tx(rows);
  return rows.length;
}

function logFirmwareDrift(db, ev, scanBy = "system:firmware-scan") {
  const r = db.prepare(`
    INSERT INTO firmware_drift_log
      (inverter_id, inverter_ip, slave, old_tuple, new_tuple,
       detected_at_ms, scan_by, note, updated_ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    Number(ev.inverter_id) || 0,
    String(ev.inverter_ip),
    Number(ev.slave) || 0,
    ev.old_tuple == null ? null : String(ev.old_tuple),
    ev.new_tuple == null ? null : String(ev.new_tuple),
    Number(ev.detected_at_ms) || Date.now(),
    String(scanBy || ""),
    ev.note == null ? null : String(ev.note),
    Date.now(),
  );
  return Number(r.lastInsertRowid);
}

function getFirmwareStateAll(db) {
  return db.prepare(`
    SELECT inverter_ip, slave, inverter_id, model_code, firmware_main,
           firmware_aux, canonical_match, first_seen_ms, last_seen_ms
    FROM inverter_firmware_state
    ORDER BY inverter_ip, slave
  `).all();
}

function getFirmwareDriftLog(db, { limit = 200, inverterIp = null } = {}) {
  const cap = Math.max(1, Math.min(5000, Number(limit) || 200));
  const where = [];
  const args = [];
  if (inverterIp) { where.push("inverter_ip = ?"); args.push(String(inverterIp)); }
  args.push(cap);
  return db.prepare(`
    SELECT id, inverter_id, inverter_ip, slave, old_tuple, new_tuple,
           detected_at_ms, scan_by, note
    FROM firmware_drift_log
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY detected_at_ms DESC
    LIMIT ?
  `).all(...args);
}

// v2.11.2 — archive-then-delete via the injected `archiveTableBeforeCutoff`
// worker (db.js). The drift log is the only auditable record of fleet
// firmware-tuple changes detected by scans; permanently DELETE'ing it on
// retention used to silently lose that history.
//
// Returns:
//   - Promise<number> (rows migrated) when archiveTableBeforeCutoff is
//     provided (production path — server/index.js wires it in).
//   - number (rows deleted) on the sync fallback path (used only by the
//     ABI-agnostic in-memory test in tests/firmwareMap.test.js, where the
//     archive shard machinery isn't loaded).
function pruneFirmwareDriftLog(db, retainDays = 365, archiveTableBeforeCutoff = null) {
  const days = Math.max(1, Math.min(3650, Number(retainDays) || 365));
  const cutoff = Date.now() - days * 86400000;
  if (typeof archiveTableBeforeCutoff === "function") {
    return archiveTableBeforeCutoff({
      tableName: "firmware_drift_log",
      cutoffColumn: "detected_at_ms",
      cutoffValue: cutoff,
      monthKeyColumn: "detected_at_ms",
      monthKeyKind: "ms",
    });
  }
  // Defensive fallback: callers must inject the archive helper. Keeping the
  // legacy DELETE so a misconfigured deployment still bounds the table —
  // logged so the operator notices.
  console.warn(
    "[firmwareMap] archiveTableBeforeCutoff missing — falling back to DELETE (drift log data loss).",
  );
  const r = db.prepare(
    `DELETE FROM firmware_drift_log WHERE detected_at_ms < ?`
  ).run(cutoff);
  return Number(r.changes) || 0;
}

module.exports = {
  // pure
  fwTuple,
  parseExpectedTuple,
  computeCanonical,
  classifyFleet,
  diffForPersist,
  // persistence (db handle injected)
  upsertFirmwareState,
  logFirmwareDrift,
  getFirmwareStateAll,
  getFirmwareDriftLog,
  pruneFirmwareDriftLog,
};
