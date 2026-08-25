"use strict";

/**
 * backupHealthRegistry.js — Persistent health tracker for all backup paths.
 *
 * Goal: make Tier 1 / Tier 3 / scheduled-.adsibak silent failures observable.
 * State is persisted to a small JSON file alongside the SQLite DB so the admin
 * panel can render "Last success: …" badges and consecutive-failure alerts on
 * page load without polling. Live updates are pushed via the WS broadcaster.
 *
 * NOT used for audit_log because backup events have no inverter/node — they are
 * system-level events. logControlAction() rejects inverter=0 so a separate JSON
 * store is the correct boundary.
 */

const fs = require("fs");
const path = require("path");

const KNOWN_TYPES = ["tier1", "tier3", "portableScheduled", "portableManual"];
const RECENT_EVENTS_CAP = 50;

function blankEntry() {
  return {
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
    consecutiveFailures: 0,
    nextScheduledAt: null,
    destination: null,
    lastSizeBytes: null,
    lastDurationMs: null,
  };
}

function blankState() {
  const state = { recentEvents: [] };
  for (const t of KNOWN_TYPES) state[t] = blankEntry();
  return state;
}

class BackupHealthRegistry {
  /**
   * @param {object} opts
   * @param {string} opts.stateFilePath  Absolute path to backupHealth.json
   * @param {function} [opts.broadcast]  Optional WS broadcast(payload) — called on every record
   */
  constructor(opts = {}) {
    if (!opts.stateFilePath) {
      throw new Error("BackupHealthRegistry: stateFilePath required");
    }
    this.stateFilePath = opts.stateFilePath;
    this.broadcast = typeof opts.broadcast === "function" ? opts.broadcast : null;
    this.state = this._load();
  }

  _load() {
    if (!fs.existsSync(this.stateFilePath)) return blankState();
    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFilePath, "utf8"));
      const merged = blankState();
      for (const t of KNOWN_TYPES) {
        if (parsed && parsed[t] && typeof parsed[t] === "object") {
          merged[t] = { ...merged[t], ...parsed[t] };
        }
      }
      if (Array.isArray(parsed?.recentEvents)) {
        merged.recentEvents = parsed.recentEvents.slice(-RECENT_EVENTS_CAP);
      }
      return merged;
    } catch (err) {
      console.warn("[BackupHealth] state file unreadable, starting fresh:", err.message);
      return blankState();
    }
  }

  _save() {
    try {
      const dir = path.dirname(this.stateFilePath);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${this.stateFilePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
      fs.renameSync(tmp, this.stateFilePath);
    } catch (err) {
      console.error("[BackupHealth] save failed:", err.message);
    }
  }

  _emit() {
    if (!this.broadcast) return;
    try {
      this.broadcast({ type: "backup_health", payload: this.getSnapshot() });
    } catch (_) {
      // broadcast failures are not fatal
    }
  }

  /**
   * Record a backup attempt's outcome.
   * @param {string} type  one of KNOWN_TYPES
   * @param {boolean} ok
   * @param {object} [details]
   * @param {string} [details.error]       Error message (used when ok=false)
   * @param {string} [details.destination] Where the backup was written
   * @param {number} [details.sizeBytes]   Total size of the backup
   * @param {number} [details.durationMs]  How long the operation took
   */
  recordAttempt(type, ok, details = {}) {
    if (!KNOWN_TYPES.includes(type)) {
      console.warn(`[BackupHealth] unknown backup type: ${type}`);
      return;
    }
    const entry = this.state[type] || blankEntry();
    const now = Date.now();
    entry.lastAttemptAt = now;
    if (ok) {
      entry.lastSuccessAt = now;
      entry.lastError = null;
      entry.consecutiveFailures = 0;
    } else {
      entry.lastError = String(details.error || "unknown error");
      entry.consecutiveFailures = (Number(entry.consecutiveFailures) || 0) + 1;
    }
    if (details.destination !== undefined) entry.destination = details.destination;
    if (details.sizeBytes !== undefined) entry.lastSizeBytes = Number(details.sizeBytes) || null;
    if (details.durationMs !== undefined) entry.lastDurationMs = Number(details.durationMs) || null;
    this.state[type] = entry;

    const event = {
      type,
      ok,
      at: now,
      error: ok ? null : (details.error || null),
      sizeBytes: details.sizeBytes != null ? Number(details.sizeBytes) : null,
      destination: details.destination || null,
    };
    const events = Array.isArray(this.state.recentEvents) ? this.state.recentEvents : [];
    this.state.recentEvents = [...events.slice(-(RECENT_EVENTS_CAP - 1)), event];

    this._save();
    this._emit();
  }

  /**
   * Set the next scheduled time for a backup type (cron tick).
   * @param {string} type
   * @param {number|null} ts  Unix ms or null to clear
   */
  setNextScheduled(type, ts) {
    if (!KNOWN_TYPES.includes(type)) return;
    const entry = this.state[type] || blankEntry();
    entry.nextScheduledAt = ts == null ? null : Number(ts);
    this.state[type] = entry;
    this._save();
    this._emit();
  }

  /**
   * Update destination metadata (used when user reconfigures).
   * @param {string} type
   * @param {string|null} destination
   */
  setDestination(type, destination) {
    if (!KNOWN_TYPES.includes(type)) return;
    const entry = this.state[type] || blankEntry();
    entry.destination = destination || null;
    this.state[type] = entry;
    this._save();
    this._emit();
  }

  /**
   * Snapshot for HTTP / WS consumption.
   */
  getSnapshot() {
    const out = { recentEvents: [...(this.state.recentEvents || [])] };
    for (const t of KNOWN_TYPES) {
      const entry = this.state[t] || blankEntry();
      out[t] = {
        ...entry,
        status:
          (entry.consecutiveFailures || 0) >= 3
            ? "alert"
            : entry.lastSuccessAt
              ? "ok"
              : "unknown",
      };
    }
    out.summaryStatus = KNOWN_TYPES.some(
      (t) => (out[t].consecutiveFailures || 0) >= 3,
    )
      ? "alert"
      : "ok";
    return out;
  }
}

module.exports = { BackupHealthRegistry, KNOWN_TYPES };
