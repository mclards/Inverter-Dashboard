"use strict";

// T4.4 fix (Phase 2, 2026-04-14):
// Node-side advisory lock for day-ahead generation.  Mirrors the file-lock
// convention used by services/forecast_engine.py (_dayahead_gen_lock_*) so
// Node and Python mutually exclude each other on the same target_date,
// preventing duplicate forecast_run_audit rows.
//
// Convention:
//   lock dir  : <DATA_DIR>/locks
//   lock path : dayahead_<YYYY-MM-DD>.lock
//   body     : "<owner> pid=<pid> ts=<epoch>"
//   max age  : 300 s (covers Node's 180 s Python→Node delegation timeout + slack)
//
// Behaviour matches Python:
//   - acquire(): succeeds if no lock OR prior lock is stale (> MAX_AGE_SEC)
//   - release(): best-effort unlink, never throws
//   - filesystem errors during acquire -> proceed without lock (same "fail
//     open" behaviour as Python, so a broken lock dir cannot block generation)

const fs = require("fs");
const path = require("path");

const MAX_AGE_SEC = 300;

function lockDir(dataDir) {
  const d = path.join(dataDir, "locks");
  try {
    fs.mkdirSync(d, { recursive: true });
  } catch {
    /* best-effort; acquire() will fail-open if dir missing */
  }
  return d;
}

function lockPath(dataDir, targetDate) {
  return path.join(lockDir(dataDir), `dayahead_${targetDate}.lock`);
}

function acquire(dataDir, targetDate, owner) {
  const p = lockPath(dataDir, targetDate);
  try {
    if (fs.existsSync(p)) {
      const st = fs.statSync(p);
      const ageSec = (Date.now() - st.mtimeMs) / 1000;
      if (ageSec < MAX_AGE_SEC) {
        let prior = "<unreadable>";
        try { prior = fs.readFileSync(p, "utf8").trim(); } catch { /* ignore */ }
        console.warn(
          `[forecast-lock] BUSY target=${targetDate} prior="${prior}" ` +
          `age=${ageSec.toFixed(0)}s caller=${owner} — skipping.`,
        );
        return false;
      }
      console.warn(
        `[forecast-lock] STALE target=${targetDate} age=${ageSec.toFixed(0)}s — ` +
        `force-acquiring for ${owner}.`,
      );
    }
    fs.writeFileSync(p, `${owner} pid=${process.pid} ts=${Math.floor(Date.now() / 1000)}`, "utf8");
    return true;
  } catch (e) {
    console.warn(
      `[forecast-lock] could not acquire target=${targetDate} (${e.message}) — ` +
      `proceeding without lock.`,
    );
    return true; // fail-open, matches Python
  }
}

function release(dataDir, targetDate) {
  try {
    fs.unlinkSync(lockPath(dataDir, targetDate));
  } catch {
    /* already gone or never created — fine */
  }
}

module.exports = { acquire, release, MAX_AGE_SEC, lockPath };
