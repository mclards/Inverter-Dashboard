// Calibration Session — owns the "dashboard is in calibration lockdown"
// flag.  Phase 1 left this as a stub; Phase 2 fully implements the
// lifecycle: begin / heartbeat / end / watchdog timeout / abortAll.
//
// Plan: plans/2026-05-12-inverter-calibration-tool.md §2.4a
//
// API contract (consumer-stable):
//   isActive()                              → bool
//   currentTarget()                         → null | { inverter, slave }
//   currentSession()                        → null | full session snapshot
//   isTargetUnderCalibration(inv, slave)    → bool
//   subscribe(fn)                           → unsubscribe()    // session lifecycle events
//
// Lifecycle (used by server/calibrationRoutes.js only):
//   begin({inverter, slave, operator, session_id?, idle_timeout_ms?, hard_ceiling_ms?})
//   heartbeat(session_id)                   → { ok, age_ms } | { ok:false }
//   end(session_id, reason)                 → { ended, duration_ms, ...counters }
//   incrementWrite()                         → bumps write_count
//   incrementConsign()                       → bumps consign_writes
//   abortAll(reason)                         → emergency end (used by guards)
//
// Background watchdog: every 5 s checks heartbeat age and absolute lifetime;
// auto-ends with reason="timeout" or "hard_ceiling".

"use strict";

const crypto = require("crypto");

const DEFAULT_IDLE_TIMEOUT_MS  = 30_000;   // 30 s without heartbeat → auto-end
const DEFAULT_HARD_CEILING_MS  = 30 * 60 * 1000;  // 30 min absolute max
const WATCHDOG_TICK_MS         = 5_000;

let _session = null;
const _listeners = new Set();
let _watchdog = null;

function _emit(event) {
  for (const fn of _listeners) {
    try { fn(event); } catch (_) {}
  }
}

function _startWatchdog() {
  if (_watchdog) return;
  _watchdog = setInterval(() => {
    if (!_session) { _stopWatchdog(); return; }
    const now = Date.now();
    if (now - _session.last_heartbeat_ms > _session.idle_timeout_ms) {
      console.warn(`[calibration-session] idle timeout (${(now - _session.last_heartbeat_ms)/1000|0}s) — auto-ending session ${_session.session_id}`);
      const ended = _endInternal("timeout");
      _emit({ kind: "auto_end", reason: "timeout", session: ended });
      return;
    }
    if (now - _session.started_at_ms > _session.hard_ceiling_ms) {
      console.warn(`[calibration-session] hard ceiling reached (${_session.hard_ceiling_ms/60000} min) — auto-ending session ${_session.session_id}`);
      const ended = _endInternal("hard_ceiling");
      _emit({ kind: "auto_end", reason: "hard_ceiling", session: ended });
      return;
    }
  }, WATCHDOG_TICK_MS);
  if (typeof _watchdog.unref === "function") _watchdog.unref();
}

function _stopWatchdog() {
  if (_watchdog) {
    clearInterval(_watchdog);
    _watchdog = null;
  }
}

function _endInternal(reason) {
  if (!_session) return null;
  const ended = {
    session_id:        _session.session_id,
    inverter:          _session.inverter,
    slave:             _session.slave,
    operator:          _session.operator,
    started_at_ms:     _session.started_at_ms,
    ended_at_ms:       Date.now(),
    duration_ms:       Date.now() - _session.started_at_ms,
    write_count:       _session.write_count,
    consign_writes:    _session.consign_writes,
    end_reason:        String(reason || "unknown"),
  };
  _session = null;
  _stopWatchdog();
  return ended;
}

// ── Public surface ──────────────────────────────────────────────────────

function isActive() {
  return _session !== null;
}

function currentTarget() {
  if (!_session) return null;
  return { inverter: _session.inverter, slave: _session.slave };
}

function currentSession() {
  if (!_session) return null;
  return {
    session_id:        _session.session_id,
    inverter:          _session.inverter,
    slave:             _session.slave,
    operator:          _session.operator,
    started_at_ms:     _session.started_at_ms,
    last_heartbeat_ms: _session.last_heartbeat_ms,
    write_count:       _session.write_count,
    consign_writes:    _session.consign_writes,
    idle_timeout_ms:   _session.idle_timeout_ms,
    hard_ceiling_ms:   _session.hard_ceiling_ms,
    age_ms:            Date.now() - _session.started_at_ms,
    idle_ms:           Date.now() - _session.last_heartbeat_ms,
  };
}

function isTargetUnderCalibration(inverter, slave) {
  if (!_session) return false;
  return Number(_session.inverter) === Number(inverter)
      && Number(_session.slave)    === Number(slave);
}

function isInverterUnderCalibration(inverter) {
  if (!_session) return false;
  return Number(_session.inverter) === Number(inverter);
}

function subscribe(fn) {
  if (typeof fn !== "function") return () => {};
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

// ── Lifecycle (called from calibrationRoutes.js only) ───────────────────

function begin({ inverter, slave, operator, session_id, idle_timeout_ms, hard_ceiling_ms } = {}) {
  if (_session) {
    const err = new Error(`calibration session ${_session.session_id} already active for inv ${_session.inverter}/${_session.slave}`);
    err.code = "SESSION_ACTIVE";
    err.active = currentSession();
    throw err;
  }
  if (!inverter || !slave) {
    throw new Error("inverter and slave required");
  }
  const sid = String(session_id || crypto.randomBytes(6).toString("hex"));
  const idleMs = Math.max(5_000, Math.min(5 * 60 * 1000, Number(idle_timeout_ms) || DEFAULT_IDLE_TIMEOUT_MS));
  const hardMs = Math.max(60_000, Math.min(2 * 60 * 60 * 1000, Number(hard_ceiling_ms) || DEFAULT_HARD_CEILING_MS));
  const now = Date.now();
  _session = {
    session_id:        sid,
    inverter:          Number(inverter),
    slave:             Number(slave),
    operator:          String(operator || "operator").slice(0, 64),
    started_at_ms:     now,
    last_heartbeat_ms: now,
    write_count:       0,
    consign_writes:    0,
    idle_timeout_ms:   idleMs,
    hard_ceiling_ms:   hardMs,
  };
  _startWatchdog();
  _emit({ kind: "begin", session: currentSession() });
  console.log(`[calibration-session] BEGIN ${sid} inv=${inverter}/${slave} op=${_session.operator}`);
  return { session_id: sid, idle_timeout_ms: idleMs, hard_ceiling_ms: hardMs };
}

function heartbeat(session_id) {
  if (!_session) return { ok: false, error: "no_active_session" };
  if (String(session_id) !== _session.session_id) {
    return { ok: false, error: "session_id_mismatch" };
  }
  const now = Date.now();
  const age_ms = now - _session.last_heartbeat_ms;
  _session.last_heartbeat_ms = now;
  return { ok: true, age_ms, session: currentSession() };
}

function end(session_id, reason) {
  if (!_session) return { ended: false, error: "no_active_session" };
  if (session_id != null && String(session_id) !== _session.session_id) {
    return { ended: false, error: "session_id_mismatch" };
  }
  const ended = _endInternal(reason || "operator");
  if (ended) {
    _emit({ kind: "end", reason: ended.end_reason, session: ended });
    console.log(`[calibration-session] END ${ended.session_id} reason=${ended.end_reason} writes=${ended.write_count} consign=${ended.consign_writes} dur=${(ended.duration_ms/1000)|0}s`);
  }
  return ended ? { ended: true, ...ended } : { ended: false };
}

function abortAll(reason) {
  if (!_session) return { aborted: false };
  const ended = _endInternal(reason || "guard_abort");
  if (ended) {
    _emit({ kind: "abort", reason: ended.end_reason, session: ended });
    console.warn(`[calibration-session] ABORT ${ended.session_id} reason=${ended.end_reason}`);
  }
  return ended ? { aborted: true, ...ended } : { aborted: false };
}

function incrementWrite() {
  if (_session) _session.write_count += 1;
}

function incrementConsign() {
  if (_session) _session.consign_writes += 1;
}

module.exports = {
  isActive,
  currentTarget,
  currentSession,
  isTargetUnderCalibration,
  isInverterUnderCalibration,
  subscribe,
  begin,
  heartbeat,
  end,
  abortAll,
  incrementWrite,
  incrementConsign,
  // Phase-1 stub aliases kept so any pre-existing imports don't break.
  _begin: begin,
  _heartbeat: heartbeat,
  _end: end,
  _abortAll: abortAll,
};
