"use strict";

/**
 * server/serialNumber.js — Slice C of v2.10.0.
 *
 * Operator-driven Read / Edit / Send pipeline mirroring ISM's
 * `frmSetSerial` form.  Backed by Python's `/serial/{inv}/{slave}`
 * endpoints (FC11 read + FC16 unlock+write+verify).
 *
 * Architecture decisions (carried over from Slice B):
 *   • Python is read-only for SQLite — Node owns serial_change_log writes.
 *   • Python serializes Modbus per-IP via thread_locks[ip]; Node must NOT
 *     issue parallel /serial calls for the same inverter (the server
 *     guarantees this by sequencing inside _proxy*).
 *   • "Must Read before Send" gate enforced via a short-lived session
 *     token minted by Read and required by Send.
 *
 * The fleet uniqueness scan lives entirely in Node (cache + topology
 * traversal + concurrency cap).  Python only sees one (inv, slave) per
 * call.
 */

const crypto = require("crypto");
const { lookupMotiveLabel } = require("./motiveLabels");
const { bindingsFromReq } = require("./bulkControlAuth");
const {
  FIXED_SERIAL_MAP,
  FIXED_SERIAL_FMT,
  WRITABLE_NODES,
  lookupSerialOrigin,
} = require("./serialFixedMap");

// Session token TTL — operator must issue Send within this window.
const SESSION_TTL_MS = 5 * 60 * 1000;

// Fleet-uniqueness cache TTL — re-scans freshen entries older than this.
const FLEET_CACHE_TTL_MS = 5 * 60 * 1000;

// Concurrency cap for fleet uniqueness sweeps.  Python serializes per-IP
// internally, but the comm board / EKI gateway shares a single RS485 bus
// across 4 daisy-chained inverters — slamming 8 parallel TCP requests at
// 27 inverters hammers those gateways, which then return Modbus
// exception 0x0B (gateway target failed to respond).  Conservative
// concurrency = 3 keeps the bus quiet enough for FC11 to land cleanly.
const FLEET_SCAN_CONCURRENCY = 3;

// Per-target retry policy for transient soft errors during a fleet scan.
// We re-read on classic "bus was busy" symptoms (FC11 exception 0x0B,
// timed out, broken pipe, etc.) — these are routinely cleared by waiting
// 600 ms and trying again.  Bounded so a genuinely-dead inverter doesn't
// stall the whole sweep.
const FLEET_SCAN_RETRY_LIMIT = 2;
const FLEET_SCAN_RETRY_BACKOFF_MS = 600;
function _isTransientSerialError(msg) {
  const s = String(msg || "").toLowerCase();
  return (
    s.includes("code=0x0b") ||           // gateway target failed to respond
    s.includes("0x0b") ||
    s.includes("gateway target") ||
    s.includes("timed out") ||
    s.includes("timeout") ||
    s.includes("connection reset") ||
    s.includes("broken pipe") ||
    s.includes("recv failed") ||
    s.includes("engine unreachable")
  );
}
function _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ─── Session-token store ──────────────────────────────────────────────────
// Keyed by token; value = { inverterIp, slave, oldSerial, fmt, mintedAt }.
// In-memory by design — restarts invalidate every pending Send, which is
// the safe behaviour (operator must Read again).
const _sessions = new Map();

function _purgeExpiredSessions() {
  const now = Date.now();
  for (const [tok, sess] of _sessions.entries()) {
    if (now - sess.mintedAt > SESSION_TTL_MS) _sessions.delete(tok);
  }
}

function mintSession({ inverterIp, slave, oldSerial, fmt, actedBy, req }) {
  _purgeExpiredSessions();
  const token = crypto.randomBytes(16).toString("hex");
  // SEC-H-004 — bind the session to the requesting client (IP + UA hash) so
  // captured tokens cannot be replayed from a different network segment.
  // Mirrors the binding pattern used by issuePlantWideAuthSession.
  const bindings = req ? bindingsFromReq(req) : null;
  _sessions.set(token, {
    inverterIp: String(inverterIp),
    slave: Number(slave),
    oldSerial: String(oldSerial || ""),
    fmt: String(fmt || "auto"),
    actedBy: String(actedBy || ""),
    mintedAt: Date.now(),
    bindings,
  });
  return { token, expiresAt: Date.now() + SESSION_TTL_MS, bound: !!bindings };
}

function _bindingsMatch(a, b) {
  if (!a) return true; // unbound session — backward compatible
  if (!b) return false;
  if (a.ip) {
    const ba = Buffer.from(a.ip);
    const bb = Buffer.from(b.ip);
    if (ba.length !== bb.length || !crypto.timingSafeEqual(ba, bb)) return false;
  }
  if (a.uaHash) {
    const ba = Buffer.from(a.uaHash);
    const bb = Buffer.from(b.uaHash);
    if (ba.length !== bb.length || !crypto.timingSafeEqual(ba, bb)) return false;
  }
  return true;
}

function consumeSession(token, { inverterIp, slave, req }) {
  _purgeExpiredSessions();
  const sess = _sessions.get(String(token || ""));
  if (!sess) return { ok: false, error: "session_not_found" };
  if (sess.inverterIp !== String(inverterIp) || sess.slave !== Number(slave)) {
    return { ok: false, error: "session_target_mismatch" };
  }
  if (Date.now() - sess.mintedAt > SESSION_TTL_MS) {
    _sessions.delete(String(token));
    return { ok: false, error: "session_expired" };
  }
  // SEC-H-004 — verify the caller fingerprint matches what minted the token.
  if (sess.bindings) {
    const callerBindings = req ? bindingsFromReq(req) : null;
    if (!_bindingsMatch(sess.bindings, callerBindings)) {
      _sessions.delete(String(token));
      return { ok: false, error: "session_binding_mismatch" };
    }
  }
  // One-shot: token consumed on Send so it can't be replayed.
  _sessions.delete(String(token));
  return { ok: true, session: sess };
}

// ─── Fleet uniqueness cache ───────────────────────────────────────────────
// (inverterIp + "|" + slave) → { serial, scannedAt, error }
const _fleetCache = new Map();

function _cacheKey(ip, slave) { return `${ip}|${slave}`; }

function getCachedSerial(ip, slave) {
  const v = _fleetCache.get(_cacheKey(ip, slave));
  if (!v) return null;
  if (Date.now() - v.scannedAt > FLEET_CACHE_TTL_MS) return null;
  return v;
}

function setCachedSerial(ip, slave, serial, error = null) {
  _fleetCache.set(_cacheKey(ip, slave), {
    serial: String(serial || ""),
    scannedAt: Date.now(),
    error: error ? String(error) : null,
  });
}

function invalidateCachedSerial(ip, slave) {
  _fleetCache.delete(_cacheKey(ip, slave));
}

function getFleetCacheSnapshot() {
  const out = [];
  for (const [k, v] of _fleetCache.entries()) {
    const [ip, slave] = k.split("|");
    out.push({
      inverter_ip: ip,
      slave: Number(slave),
      serial: v.serial,
      scanned_at_ms: v.scannedAt,
      ttl_remaining_ms: Math.max(0, FLEET_CACHE_TTL_MS - (Date.now() - v.scannedAt)),
      error: v.error,
    });
  }
  return out;
}

// ─── Persistence ──────────────────────────────────────────────────────────

function logSerialChange(db, {
  inverterId, inverterIp, slave, actedAtMs, actedBy,
  fmt, oldSerial, newSerial, verifyPassed, outcome, errorDetail,
  originNote = null, originInverter = null, originNode = null,
}) {
  // `acted_at_ms` is the true action instant (engine-reported when available,
  // else now); `updated_ts` is the row-write instant for replication. Keep
  // them distinct so history timestamps stay accurate. `origin_note` is the
  // human string; `origin_inverter`/`origin_node` are the structured pair
  // that powers the Power Module Migration History (no text parsing).
  const r = db.prepare(`
    INSERT INTO serial_change_log
      (inverter_id, inverter_ip, slave, acted_at_ms, acted_by,
       fmt, old_serial, new_serial, verify_passed, outcome, error_detail,
       origin_note, origin_inverter, origin_node, updated_ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    Number(inverterId) || 0,
    String(inverterIp),
    Number(slave) || 0,
    Number(actedAtMs) || Date.now(),
    String(actedBy || ""),
    String(fmt || ""),
    String(oldSerial || ""),
    String(newSerial || ""),
    verifyPassed ? 1 : 0,
    String(outcome || ""),
    errorDetail ? String(errorDetail) : null,
    originNote ? String(originNote) : null,
    (originInverter != null && Number.isFinite(Number(originInverter)))
      ? Number(originInverter) : null,
    (originNode != null && String(originNode) !== "") ? String(originNode) : null,
    Date.now(),
  );
  return Number(r.lastInsertRowid);
}

// ─── Power Module Migration History ───────────────────────────────────────
//
// Every relocation/nameplate detection writes a structured origin pair.
// This returns the chronological trail of physically-moved boards: each
// row says a module whose serial belonged to (origin_inverter,
// origin_node) was found at (inverter_id, slave) and re-serialized to
// new_serial, with the action instant + operator + outcome.  Pure read.
function getModuleMigrationHistory(db, { limit = 200, inverterIp = null } = {}) {
  const cap = Math.max(1, Math.min(5000, Number(limit) || 200));
  const where = ["origin_inverter IS NOT NULL"];
  const args = [];
  if (inverterIp) { where.push("inverter_ip = ?"); args.push(String(inverterIp)); }
  args.push(cap);
  return db.prepare(`
    SELECT id, inverter_id, inverter_ip, slave, acted_at_ms, acted_by,
           fmt, old_serial, new_serial, verify_passed, outcome, error_detail,
           origin_note, origin_inverter, origin_node
    FROM serial_change_log
    WHERE ${where.join(" AND ")}
    ORDER BY acted_at_ms DESC
    LIMIT ?
  `).all(...args);
}

function getRecentChangesForInverter(db, inverterIp, limit = 100) {
  const cap = Math.max(1, Math.min(1000, Number(limit) || 100));
  return db.prepare(`
    SELECT id, inverter_id, inverter_ip, slave, acted_at_ms, acted_by,
           fmt, old_serial, new_serial, verify_passed, outcome, error_detail,
           origin_note, origin_inverter, origin_node
    FROM serial_change_log
    WHERE inverter_ip = ?
    ORDER BY acted_at_ms DESC
    LIMIT ?
  `).all(String(inverterIp), cap);
}

function getRecentChangesAll(db, limit = 200) {
  const cap = Math.max(1, Math.min(2000, Number(limit) || 200));
  return db.prepare(`
    SELECT id, inverter_id, inverter_ip, slave, acted_at_ms, acted_by,
           fmt, old_serial, new_serial, verify_passed, outcome, error_detail,
           origin_note, origin_inverter, origin_node
    FROM serial_change_log
    ORDER BY acted_at_ms DESC
    LIMIT ?
  `).all(cap);
}

// ─── Fleet-wide uniqueness scan ───────────────────────────────────────────
//
// `topology` shape: [{ inverterId, inverterIp, slave }, ...]
// `readOne(inverterId, slave, opts)` is injected so this stays testable —
// in production it proxies to Python's /serial/{inv}/{slave}.

async function _runWithConcurrency(items, concurrency, worker) {
  const out = new Array(items.length);
  let next = 0;
  async function pump() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  }
  const runners = Array.from({ length: Math.max(1, concurrency) }, pump);
  await Promise.all(runners);
  return out;
}

async function fleetUniquenessCheck({
  candidateSerial, excludeSelf, topology, readOne,
  bypassCache = false, concurrency = FLEET_SCAN_CONCURRENCY,
}) {
  const targets = (topology || []).filter(
    (t) => !(t.inverterIp === excludeSelf?.inverterIp
              && Number(t.slave) === Number(excludeSelf?.slave)),
  );
  const candidate = String(candidateSerial || "").trim();

  const results = await _runWithConcurrency(targets, concurrency, async (t) => {
    const cached = bypassCache ? null : getCachedSerial(t.inverterIp, t.slave);
    if (cached) {
      return cached.error
        ? { kind: "unreachable", target: t, error: cached.error }
        : { kind: cached.serial === candidate ? "conflict" : "ok",
            target: t, existing_serial: cached.serial };
    }
    let info;
    try {
      info = await readOne(t.inverterId, t.slave, { fmt: "auto" });
    } catch (err) {
      setCachedSerial(t.inverterIp, t.slave, "", err?.message || String(err));
      return { kind: "unreachable", target: t, error: err?.message || String(err) };
    }
    if (!info?.ok) {
      setCachedSerial(t.inverterIp, t.slave, "", info?.error || "read_failed");
      return { kind: "unreachable", target: t, error: info?.error || "read_failed" };
    }
    setCachedSerial(t.inverterIp, t.slave, info.serial);
    return {
      kind: info.serial === candidate ? "conflict" : "ok",
      target: t,
      existing_serial: info.serial,
    };
  });

  const conflicts = results.filter((r) => r.kind === "conflict")
    .map((r) => ({
      inverter_id: r.target.inverterId,
      inverter_name: r.target.inverterName || `Inverter ${r.target.inverterId}`,
      inverter_ip: r.target.inverterIp,
      slave: r.target.slave,
      existing_serial: r.existing_serial,
    }));
  const unreachable = results.filter((r) => r.kind === "unreachable")
    .map((r) => ({
      inverter_id: r.target.inverterId,
      inverter_name: r.target.inverterName || `Inverter ${r.target.inverterId}`,
      inverter_ip: r.target.inverterIp,
      slave: r.target.slave,
      error: r.error,
    }));

  return {
    unique: conflicts.length === 0,
    candidate_serial: candidate,
    scanned: results.length - unreachable.length,
    total_targets: results.length,
    conflicts,
    unreachable,
  };
}

/**
 * Plain fleet scan — read every (inverter, slave) in `topology` via
 * `readOne(inverterId, slave, opts)`, populate the cache as a side effect,
 * return the assembled map.  No candidate comparison (use
 * `fleetUniquenessCheck` for that).
 *
 * Used by:
 *   • POST /api/serial/fleet/scan       — operator-driven Plant Serial Map
 *   • Stale-cache freshen on any Read   — caller passes bypassCache=false
 */
async function fleetScan({
  topology, readOne,
  bypassCache = false, concurrency = FLEET_SCAN_CONCURRENCY,
  retryLimit = FLEET_SCAN_RETRY_LIMIT,
  retryBackoffMs = FLEET_SCAN_RETRY_BACKOFF_MS,
}) {
  const targets = Array.isArray(topology) ? topology : [];
  const startedAt = Date.now();
  // Per-target read with bounded retry on transient soft errors.  Returns
  // the same row shape on success or terminal failure; never throws.
  async function readWithRetry(t) {
    let lastMsg = "unknown";
    for (let attempt = 0; attempt <= retryLimit; attempt++) {
      let info;
      try {
        info = await readOne(t.inverterId, t.slave, { fmt: "auto" });
      } catch (err) {
        lastMsg = err?.message || String(err);
        if (attempt < retryLimit && _isTransientSerialError(lastMsg)) {
          await _sleep(retryBackoffMs * (attempt + 1));
          continue;
        }
        setCachedSerial(t.inverterIp, t.slave, "", lastMsg);
        return { target: t, ok: false, error: lastMsg, scanned_at_ms: Date.now(), from_cache: false };
      }
      if (!info?.ok) {
        lastMsg = info?.error || "read_failed";
        if (attempt < retryLimit && _isTransientSerialError(lastMsg)) {
          await _sleep(retryBackoffMs * (attempt + 1));
          continue;
        }
        setCachedSerial(t.inverterIp, t.slave, "", lastMsg);
        return { target: t, ok: false, error: lastMsg, scanned_at_ms: Date.now(), from_cache: false };
      }
      setCachedSerial(t.inverterIp, t.slave, info.serial);
      return {
        target: t, ok: true,
        serial: info.serial,
        serial_format: info.serial_format,
        model_code: info.model_code,
        firmware_main: info.firmware_main,
        firmware_aux: info.firmware_aux,
        scanned_at_ms: Date.now(),
        from_cache: false,
      };
    }
    // Should not reach — defensive fallback.
    setCachedSerial(t.inverterIp, t.slave, "", lastMsg);
    return { target: t, ok: false, error: lastMsg, scanned_at_ms: Date.now(), from_cache: false };
  }
  const results = await _runWithConcurrency(targets, concurrency, async (t) => {
    const cached = bypassCache ? null : getCachedSerial(t.inverterIp, t.slave);
    if (cached) {
      return cached.error
        ? {
            target: t, ok: false,
            error: cached.error, scanned_at_ms: cached.scannedAt,
            from_cache: true,
          }
        : {
            target: t, ok: true,
            serial: cached.serial, scanned_at_ms: cached.scannedAt,
            from_cache: true,
          };
    }
    return readWithRetry(t);
  });
  return {
    started_at_ms: startedAt,
    finished_at_ms: Date.now(),
    total_targets: results.length,
    successful: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    rows: results.map((r) => ({
      inverter_id: r.target.inverterId,
      inverter_name: r.target.inverterName || `Inverter ${r.target.inverterId}`,
      inverter_ip: r.target.inverterIp,
      slave: r.target.slave,
      ok: Boolean(r.ok),
      serial: r.serial || null,
      serial_format: r.serial_format || null,
      model_code: r.model_code || null,
      firmware_main: r.firmware_main || null,
      firmware_aux: r.firmware_aux || null,
      from_cache: Boolean(r.from_cache),
      scanned_at_ms: r.scanned_at_ms || null,
      error: r.error || null,
    })),
  };
}

// ─── Bulk re-serialize plan (diff live fleet vs canonical map) ────────────
//
// Compares the current per-node serial (from a fleet scan) against the
// operator-authoritative FIXED_SERIAL_MAP and classifies every writable
// node.  Pure — no Modbus, no DB.  Only nodes 1..4 are considered ("T" is
// the inverter nameplate, never written).
//
// `scanRows` shape (subset of fleetScan() row output):
//   [{ inverter_id, inverter_ip, inverter_name, slave, ok, serial, error }]
// `topology` (optional) lets us emit `missing` rows for configured nodes
// the scan never returned (so the plan covers the whole fleet, not just
// whatever answered).
//
// Returned row `status`:
//   match       — live serial already equals the target (skip)
//   mismatch    — live serial differs (eligible to write)
//   unreachable — node answered the scan with an error (cannot write now)
//   missing     — node is configured but produced no scan row (absent unit)
//
// Each mismatch row also carries an `origin` classification derived from
// looking the LIVE serial up in the locked map's reverse index:
//   origin_kind = "relocated"  — the live serial belongs to a DIFFERENT
//        slot in the locked map → this physical module was physically moved
//        here from `origin: {inverter,node}`.  Re-serializing rewrites a
//        transplanted board, so it `needs_ack:true` and the origin is
//        captured in `origin_note` for the audit trail.
//   origin_kind = "unknown"    — the live serial is not in the map at all
//        (factory-default / never-serialized / foreign).  Normal write.
//   origin_kind = "nameplate"  — live serial matches a "T" nameplate slot
//        (shouldn't happen on a node; surfaced so the UI can explain it) —
//        treated like "relocated" for acknowledgement safety.
function _originNote(originKind, origin, liveSerial) {
  if (originKind === "relocated") {
    return `module from Inv ${origin.inverter} / Node ${origin.node} `
         + `(serial ${liveSerial})`;
  }
  if (originKind === "nameplate") {
    return `live serial ${liveSerial} is the nameplate of Inv `
         + `${origin.inverter} (unexpected on a node)`;
  }
  return `prior serial ${liveSerial} not in locked map `
       + `(factory-default / foreign)`;
}

function buildBulkPlan({ scanRows, topology = null }) {
  const byKey = new Map();
  for (const r of scanRows || []) {
    byKey.set(`${Number(r.inverter_id)}|${Number(r.slave)}`, r);
  }
  // The universe of writable targets is the canonical map (1..27 × 1..4),
  // optionally intersected with what topology actually configures.
  const topoKeys = topology
    ? new Set(topology.map((t) => `${Number(t.inverterId)}|${Number(t.slave)}`))
    : null;

  const rows = [];
  for (const invIdStr of Object.keys(FIXED_SERIAL_MAP)) {
    const invId = Number(invIdStr);
    for (const slave of WRITABLE_NODES) {
      if (topoKeys && !topoKeys.has(`${invId}|${slave}`)) continue;
      const target = FIXED_SERIAL_MAP[invId][String(slave)];
      const scan = byKey.get(`${invId}|${slave}`);
      let status;
      let current = null;
      let error = null;
      if (!scan) {
        status = "missing";
      } else if (!scan.ok) {
        status = "unreachable";
        error = scan.error || "read_failed";
      } else {
        current = scan.serial || "";
        status = current === target ? "match" : "mismatch";
      }
      // Origin / relocation classification (only meaningful for a real
      // mismatch — a match is, by definition, the board that belongs here).
      let originKind = null;
      let origin = null;
      let needsAck = false;
      let originNote = null;
      if (status === "mismatch") {
        const found = lookupSerialOrigin(current);
        if (!found) {
          originKind = "unknown";
        } else if (found.kind === "nameplate") {
          originKind = "nameplate";
          origin = found;
          needsAck = true;
        } else if (
          found.inverter === invId && Number(found.node) === Number(slave)
        ) {
          // Live serial is this very slot's locked serial — but `current
          // !== target` only happens here if the map target changed; treat
          // as a plain in-place correction (no relocation).
          originKind = "unknown";
        } else {
          originKind = "relocated";
          origin = { inverter: found.inverter, node: found.node };
          needsAck = true;
        }
        originNote = _originNote(originKind, origin, current);
      }
      rows.push({
        inverter_id: invId,
        inverter_name: scan?.inverter_name || `Inverter ${invId}`,
        inverter_ip: scan?.inverter_ip || null,
        slave,
        current_serial: current,
        target_serial: target,
        status,
        error,
        origin_kind: originKind,        // relocated | unknown | nameplate | null
        origin,                         // { inverter, node } when relocated
        needs_ack: needsAck,            // true ⇒ acknowledgement required
        origin_note: originNote,        // human string for the audit log
      });
    }
  }
  const count = (s) => rows.filter((r) => r.status === s).length;
  return {
    fmt: FIXED_SERIAL_FMT,
    total: rows.length,
    summary: {
      match: count("match"),
      mismatch: count("mismatch"),
      unreachable: count("unreachable"),
      missing: count("missing"),
      relocated: rows.filter((r) => r.origin_kind === "relocated").length,
      needs_ack: rows.filter((r) => r.needs_ack).length,
    },
    rows,
  };
}

module.exports = {
  // Session tokens
  SESSION_TTL_MS,
  mintSession,
  consumeSession,
  // Fleet cache
  FLEET_CACHE_TTL_MS,
  FLEET_SCAN_CONCURRENCY,
  getCachedSerial,
  setCachedSerial,
  invalidateCachedSerial,
  getFleetCacheSnapshot,
  // Persistence
  logSerialChange,
  getRecentChangesForInverter,
  getRecentChangesAll,
  getModuleMigrationHistory,
  // Uniqueness + fleet scan
  fleetUniquenessCheck,
  fleetScan,
  // Bulk re-serialize
  buildBulkPlan,
};
