"use strict";

// Regression test for the slim /api/alarms row contract.
//
// 2026-05-22: A 683-row query for May 21 returned 7.4 MB because
// enrichAlarmRow was spreading the full v2.9.3 ALARM_BITS entry
// (safetyPrep, actionSteps, expectedReadings, escalateWhen, schematicNote,
// debugDesc, trinPM, physicalDevices, description, action, altLabel,
// variantWarning, note, stopReasonSubcodes) into each decoded[] entry on
// every row. That tripped the 20 s /api/alarms remote-proxy timeout AND
// stalled the gateway browser's own render. The fix slims each decoded
// entry to { bit, hex, label, severity } — the only fields the alarm-log
// table (renderAlarmTable) and notification panel (refreshNotifPanel)
// actually read. The drilldown modal (openAlarmDetail) gets the rich
// per-bit data from the cached /api/alarms/reference response, so the
// novice-expansion fields are still available on click.
//
// This test parses server/index.js as TEXT to lock the slim contract
// without bringing up the full DB stack (works under both Node-ABI and
// Electron-ABI native builds, same pattern as alarmReferenceShape.test.js).

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const indexSrc = fs.readFileSync(
  path.join(__dirname, "..", "index.js"),
  "utf8",
);

function loadEnrichBlock() {
  const m = indexSrc.match(
    /function enrichAlarmRow\(row, nowTs = Date\.now\(\)\) \{[\s\S]*?\n  return \{[\s\S]*?\n  \};\n\}/,
  );
  if (!m) throw new Error("could not locate enrichAlarmRow in server/index.js");
  return m[0];
}

function testSlimDecodedProjection() {
  const block = loadEnrichBlock();

  // Must NOT spread decodeAlarm() directly into `decoded` (that's the bug).
  assert.ok(
    !/decoded:\s*decodeAlarm\s*\(/.test(block),
    "REGRESSION: enrichAlarmRow.decoded must NOT be the raw decodeAlarm() output — that re-inlines v2.9.3 novice-expansion fields and bloats /api/alarms responses to ~12 KB/row. Project to {bit,hex,label,severity} instead.",
  );

  // Must contain the slim projection: a .map() that returns an object
  // with exactly bit/hex/label/severity (no spread).
  assert.ok(
    /decodedFull\.map\(/.test(block) || /decodeAlarm\([^)]*\)\.map\(/.test(block),
    "enrichAlarmRow must project decodeAlarm() through .map() into a slim object shape",
  );

  // Each slim projection MUST include label (the only field the table
  // renderer + notification panel actually read).
  assert.ok(/label:\s*b\.label/.test(block), "slim projection missing `label: b.label`");
  assert.ok(/bit:\s*b\.bit/.test(block),     "slim projection missing `bit: b.bit`");
  assert.ok(/hex:\s*b\.hex/.test(block),     "slim projection missing `hex: b.hex`");
  assert.ok(/severity:\s*b\.severity/.test(block), "slim projection missing `severity: b.severity`");

  // Must NOT pull the heavy novice-expansion fields into the per-row
  // projection — these belong on /api/alarms/reference (cached client-side).
  const heavyFields = [
    "safetyPrep",
    "actionSteps",
    "expectedReadings",
    "escalateWhen",
    "schematicNote",
    "debugDesc",
    "trinPM",
    "physicalDevices",
  ];
  for (const f of heavyFields) {
    assert.ok(
      !new RegExp(`${f}:\\s*b\\.${f}`).test(block),
      `REGRESSION: enrichAlarmRow re-inlines b.${f} into the per-row payload — these belong on /api/alarms/reference only.`,
    );
  }
}

function testSlimSizeBudget() {
  // Reload ALARM_BITS via the same eval trick used in alarmReferenceShape.test.js
  const alarmsSrc = fs.readFileSync(
    path.join(__dirname, "..", "alarms.js"),
    "utf8",
  );
  const m = alarmsSrc.match(/const ALARM_BITS = (\[[\s\S]*?\n\]);/);
  if (!m) throw new Error("could not locate ALARM_BITS literal in alarms.js");
  // eslint-disable-next-line no-eval
  const ALARM_BITS = eval(m[1]);

  // Simulate the slim projection on a fatal (every bit set) row — the
  // worst case the table ever ships.
  const decoded = ALARM_BITS.map((b) => ({
    bit: b.bit,
    hex: b.hex,
    label: b.label,
    severity: b.severity,
  }));
  const row = {
    id: 1,
    ts: 1779357620735,
    inverter: 4,
    unit: 2,
    alarm_code: "7FFFH",
    alarm_value: 0x7fff,
    severity: "critical",
    cleared_ts: 1779357625655,
    acknowledged: 1,
    updated_ts: 1779409868369,
    stop_reason_id: null,
    decoded,
    alarm_hex: "7FFFH",
    occurred_ts: 1779357620735,
    end_ts: 1779357625655,
    status: "CLEARED",
    duration_ms: 4920,
    duration_sec: 4,
    duration_min: 0.08,
    duration_text: "00:00:04",
  };
  const bytes = JSON.stringify(row).length;
  // Worst-case fatal row (15 bits set) must stay under 2 KB. Pre-fix this
  // was ~12 KB per typical row and far more for fatals.
  assert.ok(
    bytes < 2048,
    `slim worst-case alarm row is ${bytes} bytes — must stay under 2 KB to keep /api/alarms responses within the 20 s remote-proxy timeout on Tailscale`,
  );
}

testSlimDecodedProjection();
testSlimSizeBudget();
console.log(
  "alarmRowSlimShape.test.js: PASS (slim projection locked + worst-case <2 KB)",
);
