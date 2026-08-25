"use strict";

/**
 * server/alarmsDiagnostic.js — Slice F of v2.10.0.
 *
 * On every alarm-bit transition `raiseActiveAlarm` (in alarms.js) calls our
 * registered hook.  We schedule a fire-and-forget StopReason capture against
 * the Python engine ~500 ms after the transition (giving the inverter DSP
 * time to settle the snapshot buffer), persist the result with the
 * poller-stamped `event_at_ms` and the `alarm_id`, and update
 * `alarms.stop_reason_id` so the drilldown can resolve the snapshot
 * inline.
 *
 * Constraints honoured:
 *   • Never block the poller batch — the hook returns synchronously, the
 *     fetch happens via setTimeout.
 *   • Per-inverter cooldown so a flapping bit can't hammer the bus.
 *   • Operator can disable via setting `stopReasonAutoCaptureEnabled`.
 *   • All errors logged to audit_log; never thrown back to alarms.js.
 */

const TRANSITION_FETCH_DELAY_MS = 500;
const TRANSITION_FETCH_DEDUPE_MS = 30_000;
const FETCH_TIMEOUT_MS = 8_000;
const NODE_MAX_SUPPORTED = 3;

function _hex(v) {
  const n = Number(v) || 0;
  return `0x${n.toString(16).padStart(4, "0").toUpperCase()}`;
}

/**
 * Build the auto-capture function injected into alarms.js.  All deps are
 * passed in explicitly so this module is independently testable.
 *
 * @param {object} ctx
 *   @param {Database} ctx.db                  — better-sqlite3 instance
 *   @param {object}   ctx.stopReasons         — server/stopReasons module
 *   @param {string}   ctx.engineUrl           — base URL for Python (no trailing slash)
 *   @param {function} ctx.getSetting          — (key, default) → string
 *   @param {function} ctx.resolveInverterIp   — (inverter:int) → string|null
 *   @param {function} ctx.resolveSlave        — (inverter:int) → int (defaults to 1)
 *   @param {function} ctx.currentBulkAuthKey  — () → string (adsiMM)
 *   @param {function} [ctx.logControlAction]  — audit_log writer
 *   @param {function} [ctx.broadcastUpdate]   — WS broadcaster (optional)
 *   @param {function} [ctx.isRemoteMode]      — () → bool
 */
function createStopReasonAutoCapture(ctx) {
  const {
    db,
    stopReasons,
    engineUrl,
    getSetting,
    resolveInverterIp,
    resolveSlave,
    currentBulkAuthKey,
    logControlAction,
    broadcastUpdate,
    isRemoteMode,
  } = ctx || {};

  if (!db) throw new Error("alarmsDiagnostic: db required");
  if (!stopReasons) throw new Error("alarmsDiagnostic: stopReasons module required");
  if (!engineUrl) throw new Error("alarmsDiagnostic: engineUrl required");

  const recentlyFetched = new Map(); // inverter (int) → last fetch ms

  function isEnabled() {
    if (typeof getSetting !== "function") return true;
    const raw = String(getSetting("stopReasonAutoCaptureEnabled", "1") || "1").trim();
    return raw === "1" || raw.toLowerCase() === "true" || raw.toLowerCase() === "yes";
  }

  function shouldCapture(inverter, now) {
    if (!isEnabled()) return false;
    if (typeof isRemoteMode === "function" && isRemoteMode()) return false;
    const last = recentlyFetched.get(inverter) || 0;
    if (now - last < TRANSITION_FETCH_DEDUPE_MS) return false;
    recentlyFetched.set(inverter, now);
    return true;
  }

  function _audit(payload) {
    if (typeof logControlAction !== "function") return;
    try { logControlAction(payload); } catch (_) { /* non-fatal */ }
  }

  function _attachStopReasonToAlarm(alarmId, eventId) {
    if (!alarmId || !eventId) return;
    try {
      db.prepare(`UPDATE alarms SET stop_reason_id = ? WHERE id = ? AND stop_reason_id IS NULL`)
        .run(Number(eventId), Number(alarmId));
    } catch (err) {
      console.warn("[stop-reason-capture] alarms FK update failed:", err.message);
    }
  }

  async function _runCapture({ alarmId, inverter, unit, alarmValue, eventAtMs }) {
    const ip = typeof resolveInverterIp === "function" ? resolveInverterIp(inverter) : null;
    if (!ip) {
      _audit({
        operator: "SYSTEM", inverter, node: unit,
        action: "stop_reason_capture", scope: "auto", result: "fail",
        ip: "", reason: "no IP configured",
      });
      return;
    }
    const slave = typeof resolveSlave === "function"
      ? resolveSlave(inverter)
      : Math.max(1, Math.min(NODE_MAX_SUPPORTED, Number(unit) || 1));

    // Read only the alarming node (faster, less bus traffic). If `unit`
    // doesn't map cleanly to 1..NODE_MAX_SUPPORTED, fall back to the
    // full sweep so the operator at least gets _something_.
    const nodeRequest = Number.isFinite(Number(unit)) && unit >= 1 && unit <= NODE_MAX_SUPPORTED
      ? [Number(unit)]
      : null;

    const url = new URL(`${engineUrl}/stop-reasons/${inverter}/${slave}`);
    if (nodeRequest) url.searchParams.set("nodes", nodeRequest.join(","));
    // Histograms move slowly (lifetime counters) — skip on the hot path.
    url.searchParams.set("include_histogram", "0");

    const headers = {
      "content-type": "application/json",
      "x-bulk-auth": typeof currentBulkAuthKey === "function" ? currentBulkAuthKey() : "",
    };

    let upstream = null;
    let httpStatus = 0;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      try {
        const r = await fetch(url.toString(), {
          method: "POST",
          headers,
          body: JSON.stringify({}),
          signal: ctrl.signal,
        });
        httpStatus = r.status;
        upstream = await r.json().catch(() => null);
        if (!r.ok || !upstream?.ok) {
          throw new Error(upstream?.detail || upstream?.error || `engine HTTP ${r.status}`);
        }
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      _audit({
        operator: "SYSTEM", inverter, node: unit,
        action: "stop_reason_capture", scope: "auto", result: "fail",
        ip, reason: `fetch ${httpStatus || "?"}: ${err.message}`,
      });
      return;
    }

    let persisted;
    try {
      persisted = stopReasons.persistEngineResponse(db, upstream, {
        inverterId: inverter,
        inverterIp: ip,
        slave,
        triggerSource: "alarm_transition",
        eventAtMs,
        alarmId,
      });
    } catch (err) {
      _audit({
        operator: "SYSTEM", inverter, node: unit,
        action: "stop_reason_capture", scope: "auto", result: "fail",
        ip, reason: `persist: ${err.message}`,
      });
      return;
    }

    // Find the snapshot row for THIS alarming node and stamp it on the
    // alarm row. Prefer the entry matching `unit`; fall back to the
    // first inserted row if the per-node match fails.
    const matching = persisted.persisted.find(
      (p) => p.node === Number(unit) && p.eventId,
    );
    const fallback = persisted.persisted.find((p) => p.eventId);
    const snapshotId = matching?.eventId || fallback?.eventId || null;
    if (snapshotId) _attachStopReasonToAlarm(alarmId, snapshotId);

    _audit({
      operator: "SYSTEM", inverter, node: unit,
      action: "stop_reason_capture",
      scope: "auto",
      result: snapshotId ? "ok" : "noop",
      ip,
      reason: `alarm=${_hex(alarmValue)} alarm_id=${alarmId} snapshot_id=${snapshotId || "-"} `
            + persisted.persisted
                .filter((p) => p.error)
                .map((p) => `node${p.node}_err=${p.error.split(":")[0]}`)
                .join(" "),
    });

    if (typeof broadcastUpdate === "function" && snapshotId) {
      try {
        broadcastUpdate({
          type: "stopReasonCaptured",
          alarmId,
          stopReasonId: snapshotId,
          inverter,
          unit,
          eventAtMs,
        });
      } catch (_) { /* non-fatal */ }
    }
  }

  return function autoCapture({ alarmId, inverter, unit, alarmValue, eventAtMs }) {
    const now = Number(eventAtMs) || Date.now();
    if (!shouldCapture(inverter, now)) return;
    setTimeout(() => {
      _runCapture({ alarmId, inverter, unit, alarmValue, eventAtMs: now })
        .catch((err) => {
          _audit({
            operator: "SYSTEM", inverter, node: unit,
            action: "stop_reason_capture", scope: "auto", result: "fail",
            ip: "", reason: `unhandled: ${err.message}`,
          });
        });
    }, TRANSITION_FETCH_DELAY_MS);
  };
}

module.exports = {
  createStopReasonAutoCapture,
  TRANSITION_FETCH_DELAY_MS,
  TRANSITION_FETCH_DEDUPE_MS,
  FETCH_TIMEOUT_MS,
};
