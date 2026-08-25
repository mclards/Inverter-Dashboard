"use strict";

// ABI-agnostic shape test for the "insert-on-change" composition
// tracking added on 2026-05-22 (v2.11.0-beta.10). Parses
// server/alarms.js as text — works under both Electron-ABI and
// Node-ABI builds. Companion to alarmPerCompositionRowCore.test.js
// which exercises the actual write flow.
//
// Locks the contract: updateActiveAlarmValue MUST close the active
// row and re-raise via raiseActiveAlarm so each composition gets its
// own faithful snapshot row. MUST NOT OR-accumulate (operator
// rejected that — fictional supersets). MUST NOT call
// stmts.updateActiveAlarm.run (the in-place UPDATE path is the bug).

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "alarms.js"), "utf8");

function loadFn(name) {
  const re = new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`, "m");
  const m = src.match(re);
  if (!m) throw new Error(`could not locate function ${name} in alarms.js`);
  return m[0];
}

function test(name, fn) {
  try {
    fn();
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (err) {
    process.stdout.write(`  ✗ ${name}\n    ${err.message}\n`);
    process.exitCode = 1;
    throw err;
  }
}

test("close-and-reopen wrapped in db.transaction (atomic — no race window)", () => {
  // The close (clearAlarm.run) and the reopen (raiseActiveAlarm INSERT)
  // MUST run inside a single SQLite transaction so a concurrent
  // /api/alarms/active query cannot observe the brief gap where the
  // unit has neither the old nor the new active alarm row.
  assert.ok(
    /const\s+_closeAndReopenAlarmTx\s*=\s*db\.transaction\(/.test(src),
    "must declare a db.transaction wrapper (`_closeAndReopenAlarmTx = db.transaction(...)`) that bundles the close and the reopen so they are atomic to readers",
  );
  // Inside the transaction body: clearAlarm THEN raiseActiveAlarm
  const txBody = src.match(/_closeAndReopenAlarmTx\s*=\s*db\.transaction\(\([\s\S]*?\}\);/);
  assert.ok(txBody, "could not locate the transaction body");
  assert.ok(
    /stmts\.clearAlarm\.run\(/.test(txBody[0]) &&
      /raiseActiveAlarm\(/.test(txBody[0]) &&
      /silentSink|silent\s*=\s*\[\]/.test(txBody[0]),
    "transaction body must close (clearAlarm), short-circuit on cur===0, then re-raise with a silent sink",
  );
});

test("updateActiveAlarmValue delegates to the atomic transaction wrapper", () => {
  const fn = loadFn("updateActiveAlarmValue");
  assert.ok(
    /_closeAndReopenAlarmTx\(row,\s*newCur,\s*evTsNum\)/.test(fn),
    "updateActiveAlarmValue must call the _closeAndReopenAlarmTx wrapper — no direct clearAlarm/raiseActiveAlarm so the close+reopen stays atomic",
  );
});

test("REGRESSION: must NOT OR-accumulate (no `prevValue | cur` pattern)", () => {
  const fn = loadFn("updateActiveAlarmValue");
  const txMatch = src.match(/_closeAndReopenAlarmTx\s*=[\s\S]*?\}\);/);
  const tx = txMatch ? txMatch[0] : "";
  const all = fn + "\n" + tx;
  assert.ok(
    !/prevValue\s*\|\s*\(?\s*Number\(cur\)/.test(all) &&
      !/\(prevValue\s*\|\s*[^)]+cur/.test(all) &&
      !/accumulated\s*=\s*\(prevValue\s*\|/.test(all),
    "REGRESSION: operator rejected OR-accumulation as 'awkward and not right' — must NOT compute prevValue | cur",
  );
});

test("REGRESSION: must NOT call stmts.updateActiveAlarm.run (in-place UPDATE = original bug)", () => {
  const fn = loadFn("updateActiveAlarmValue");
  const txMatch = src.match(/_closeAndReopenAlarmTx\s*=[\s\S]*?\}\);/);
  const tx = txMatch ? txMatch[0] : "";
  assert.ok(
    !/stmts\.updateActiveAlarm\.run/.test(fn) &&
      !/stmts\.updateActiveAlarm\.run/.test(tx),
    "REGRESSION: stmts.updateActiveAlarm.run is the pre-fix in-place UPDATE path that clobbered transient bits. Must not be called from either the wrapper or the public function.",
  );
});

test("pure-clear short-circuit: newCur === 0 returns inside the transaction", () => {
  const txMatch = src.match(/_closeAndReopenAlarmTx\s*=[\s\S]*?\}\);/);
  assert.ok(txMatch, "transaction wrapper missing");
  assert.ok(
    /if\s*\(\s*newCur\s*===\s*0\s*\)\s*return/.test(txMatch[0]),
    "when newCur === 0, must return inside the transaction so we don't re-raise an empty alarm",
  );
});

test("raiseActiveAlarm still writes initial bitmask as-is", () => {
  const fn = loadFn("raiseActiveAlarm");
  assert.ok(
    /alarm_value:\s*cur\b/.test(fn),
    "raiseActiveAlarm should record cur as the alarm_value (works for both initial raise and re-raise from updateActiveAlarmValue)",
  );
});

test("checkAlarms isolates per-row errors so a malformed frame can't abort the batch", () => {
  const fn = loadFn("checkAlarms");
  // The for-of loop body must be wrapped in try/catch. We check for the
  // catch block + a console.error so operators see the bad row but the
  // rest of the batch still processes.
  assert.ok(
    /for\s*\(\s*const\s+row\s+of\s+batch\s*\)\s*\{[\s\S]*?try\s*\{/.test(fn),
    "checkAlarms's per-row loop body must open with `try {` so each row is isolated",
  );
  assert.ok(
    /\}\s*catch\s*\(\s*err\s*\)\s*\{[\s\S]*?console\.error\([^)]*alarms[^)]*checkAlarms[^)]*row/.test(fn),
    "per-row catch must log a contextual error including 'checkAlarms' and 'row' identifiers so operators can locate the bad frame",
  );
});

console.log(
  "alarmPerCompositionRowShape.test.js: PASS (insert-on-change contract locked; OR-accumulate explicitly forbidden)",
);
