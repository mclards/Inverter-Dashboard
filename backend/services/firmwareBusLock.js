"use strict";

/**
 * server/firmwareBusLock.js — READ-ONLY view of the cross-process
 * firmware-flash claim marker written by the standalone calibrator
 * (services/firmware_buslock.py).
 *
 * While the calibrator flashes an inverter, the dashboard must (a) stop
 * the Modbus poller contending on that inverter's bus — enforced in the
 * Python engine — and (b) NOT treat the resulting telemetry gap as a
 * comms outage. This module is the Node side of (b): the poller asks
 * which inverter gateway IPs currently hold a flash claim and treats them
 * as planned maintenance (no offline alarm, not counted as downtime).
 *
 * Hard rule: this is the consumer side and is FAIL-OPEN. Any missing /
 * empty / corrupt / unreadable marker yields an EMPTY set so live polling
 * is never silenced by a bad file. The Python writer's TTL bounds a
 * crashed flash job; here we additionally honor expires_ms.
 *
 * `_parseClaims` is pure (no fs) so server/tests/firmwareBusLock.test.js
 * can exercise the filtering without the better-sqlite3 ABI dependency.
 */

const fs = require("fs");
const path = require("path");
const { getNewRoot } = require("./storagePaths");

const MARKER_FILE = "firmware-active.json";
// The 27 poll keys re-read this each tick; cap fs hits to ~1/s.
const READ_CACHE_MS = 1000;
// Oversized marker (corrupt/hostile %PROGRAMDATA% write) => fail-open
// rather than block the poll loop on a multi-MB JSON.parse.
const MAX_MARKER_BYTES = 100_000;

function _markerPath() {
  return path.join(getNewRoot(), MARKER_FILE);
}

/**
 * PURE. Given the raw parsed marker object (or anything) and `nowMs`,
 * return the array of still-active claim objects. Never throws.
 */
function _parseClaims(raw, nowMs) {
  if (!raw || typeof raw !== "object") return [];
  const claims = raw.claims;
  if (!Array.isArray(claims)) return [];
  const out = [];
  for (const c of claims) {
    if (!c || typeof c !== "object") continue;
    const ip = String(c.inverter_ip || "").trim();
    const exp = Number(c.expires_ms || 0);
    if (ip && Number.isFinite(exp) && exp > nowMs) {
      out.push({
        inverter_ip: ip,
        node: Number(c.node || 0) || 0,
        slave: Number(c.slave || 0) || 0,
        job_id: String(c.job_id || ""),
        expires_ms: exp,
      });
    }
  }
  return out;
}

// Cache the RAW parsed marker, never the filtered result, so expiry
// filtering through _parseClaims is non-optional for every caller (a
// future consumer can't accidentally read stale expired claims).
let _cache = { atMs: 0, raw: null };

function _activeClaims(nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  if (now - _cache.atMs < READ_CACHE_MS) {
    // Re-parse cached raw against the live clock so a claim still
    // expires precisely even within the fs-read cache window.
    return _parseClaims(_cache.raw, now);
  }
  let raw = null;
  try {
    const p = _markerPath();
    if (fs.statSync(p).size <= MAX_MARKER_BYTES) {
      raw = JSON.parse(fs.readFileSync(p, "utf8"));
    }
  } catch {
    raw = null; // missing / empty / corrupt / oversized -> fail-open
  }
  _cache = { atMs: now, raw };
  return _parseClaims(raw, now);
}

/** Set of inverter gateway IPs with a live firmware-flash claim. */
function activeInverterIps(nowMs) {
  try {
    return new Set(_activeClaims(nowMs).map((c) => c.inverter_ip));
  } catch {
    return new Set(); // fail-open
  }
}

module.exports = {
  _parseClaims,
  activeInverterIps,
  _markerPath,
};
