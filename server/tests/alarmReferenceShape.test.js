"use strict";

// Source-of-truth test for the alarm-drilldown reference data shipped via
// /api/alarms/reference. Purely static — does NOT load the SQLite DB.
// Locks the schema so future edits to ALARM_BITS cannot silently strip the
// novice-friendly fields the operator depends on (safetyPrep, expectedReadings,
// schematicNote, escalateWhen) or break TrinPM video coverage.

const assert = require("assert");
const path = require("path");
const fs = require("fs");

// Parse alarms.js as text — avoids transitively loading better-sqlite3 so this
// test runs under both Node-ABI and Electron-ABI native builds.
const alarmsSrc = fs.readFileSync(
  path.join(__dirname, "..", "alarms.js"),
  "utf8",
);

// Pull the ALARM_BITS array literal out of the source and `eval` it in
// isolation. The literal contains only data (no function calls), so this is
// safe and far cheaper than spinning up the full module graph.
function loadAlarmBits() {
  const m = alarmsSrc.match(/const ALARM_BITS = (\[[\s\S]*?\n\]);/);
  if (!m) throw new Error("could not locate ALARM_BITS literal in alarms.js");
  // eslint-disable-next-line no-eval
  return eval(m[1]);
}

const ALARM_BITS = loadAlarmBits();

function testCount() {
  assert.equal(
    ALARM_BITS.length,
    16,
    "ALARM_BITS must define exactly 16 bits (0–15)",
  );
  const bitsSeen = new Set(ALARM_BITS.map((b) => b.bit));
  for (let i = 0; i < 16; i++) {
    assert.ok(bitsSeen.has(i), `bit ${i} missing from ALARM_BITS`);
  }
}

function testCoreFields() {
  for (const b of ALARM_BITS) {
    const tag = `bit ${b.bit} (0x${b.hex})`;
    assert.equal(typeof b.bit, "number", `${tag}: bit must be number`);
    assert.match(b.hex, /^[0-9A-F]{4}$/, `${tag}: hex must be 4 hex digits`);
    assert.equal(typeof b.label, "string", `${tag}: label`);
    assert.ok(
      ["info", "warning", "fault", "critical"].includes(b.severity),
      `${tag}: severity must be info/warning/fault/critical (was ${b.severity})`,
    );
    assert.ok(b.description && b.description.length, `${tag}: description`);
    assert.ok(b.action && b.action.length, `${tag}: action`);
    assert.equal(b.bit, Math.log2(parseInt(b.hex, 16)), `${tag}: hex/bit mismatch`);
  }
}

function testNoviceFields() {
  // Every bit must carry the four novice-friendly sections.
  for (const b of ALARM_BITS) {
    const tag = `bit ${b.bit} (0x${b.hex})`;
    assert.ok(
      Array.isArray(b.safetyPrep) && b.safetyPrep.length >= 2,
      `${tag}: safetyPrep must be an array with ≥ 2 entries`,
    );
    assert.ok(
      Array.isArray(b.actionSteps) && b.actionSteps.length >= 4,
      `${tag}: actionSteps must be an array with ≥ 4 entries`,
    );
    assert.ok(
      Array.isArray(b.expectedReadings) && b.expectedReadings.length >= 2,
      `${tag}: expectedReadings must be an array with ≥ 2 entries`,
    );
    assert.ok(
      Array.isArray(b.escalateWhen) && b.escalateWhen.length >= 1,
      `${tag}: escalateWhen must be an array with ≥ 1 entry`,
    );
    assert.equal(
      typeof b.schematicNote,
      "string",
      `${tag}: schematicNote must be a string (use a brief sentence even when schematicPage is null)`,
    );
    for (const arr of [b.safetyPrep, b.actionSteps, b.expectedReadings, b.escalateWhen]) {
      for (const item of arr) {
        assert.equal(typeof item, "string", `${tag}: list items must be strings`);
        assert.ok(item.length > 0, `${tag}: list items must be non-empty`);
      }
    }
  }
}

function testPhysicalDevicesHaveDescriptors() {
  // Physical-device entries should be more than a bare device name — they
  // should describe WHERE the device lives. Heuristic: contains an em-dash or
  // ≥ 5 words. Bit 13 (firmware-only) is exempt.
  for (const b of ALARM_BITS) {
    if (b.bit === 13) continue;
    const tag = `bit ${b.bit} (0x${b.hex})`;
    assert.ok(
      Array.isArray(b.physicalDevices) && b.physicalDevices.length >= 1,
      `${tag}: physicalDevices must be a non-empty array`,
    );
    for (const d of b.physicalDevices) {
      const wordCount = d.split(/\s+/).length;
      assert.ok(
        d.includes("—") || wordCount >= 5,
        `${tag}: physicalDevices entry should describe location ("—" or ≥ 5 words): "${d}"`,
      );
    }
  }
}

function testSchematicPageBounds() {
  // The schematic PDF is 22 pages — references must fall within that range or
  // be null (firmware-only alarms).
  for (const b of ALARM_BITS) {
    const tag = `bit ${b.bit} (0x${b.hex})`;
    if (b.schematicPage !== null && b.schematicPage !== undefined) {
      assert.ok(
        Number.isInteger(b.schematicPage) &&
          b.schematicPage >= 1 &&
          b.schematicPage <= 22,
        `${tag}: schematicPage must be 1-22 or null (was ${b.schematicPage})`,
      );
    }
    if (b.schematicPageExtra !== undefined) {
      assert.ok(
        Number.isInteger(b.schematicPageExtra) &&
          b.schematicPageExtra >= 1 &&
          b.schematicPageExtra <= 22,
        `${tag}: schematicPageExtra must be 1-22 (was ${b.schematicPageExtra})`,
      );
    }
  }
}

function testTrinPmCoverage() {
  // Every TrinPM code referenced in alarms.js must have a video in the
  // renderer's TRINPM_VIDEOS map (otherwise the chip silently falls back to
  // the index page). Extract and cross-check by parsing app.js as text.
  const referenced = new Set();
  for (const b of ALARM_BITS) {
    for (const t of b.trinPM || []) referenced.add(t);
  }
  const appSrc = fs.readFileSync(
    path.join(__dirname, "..", "..", "public", "js", "app.js"),
    "utf8",
  );
  const m = appSrc.match(/const TRINPM_VIDEOS = \{([\s\S]*?)\n\};/);
  assert.ok(m, "TRINPM_VIDEOS not found in public/js/app.js");
  const mapped = new Set();
  for (const k of m[1].matchAll(/(TrinPM\d+)\s*:/g)) mapped.add(k[1]);
  // TrinPM22 has no video on the source training site — confirm we never
  // reference it from alarms.js.
  assert.ok(
    !referenced.has("TrinPM22"),
    "TrinPM22 has no published video — do not reference from alarms.js",
  );
  for (const code of referenced) {
    assert.ok(
      mapped.has(code),
      `TrinPM code referenced in alarms.js but missing from TRINPM_VIDEOS: ${code}`,
    );
  }
}

function testJsonSerializable() {
  // The /api/alarms/reference endpoint serializes ALARM_BITS via res.json().
  // Make sure every value round-trips cleanly (no functions, no cycles).
  const json = JSON.stringify(ALARM_BITS);
  const round = JSON.parse(json);
  assert.equal(round.length, ALARM_BITS.length);
  // Spot-check that the heavy fields survive the round-trip.
  for (const b of round) {
    assert.ok(Array.isArray(b.safetyPrep));
    assert.ok(Array.isArray(b.actionSteps));
    assert.ok(Array.isArray(b.expectedReadings));
    assert.ok(Array.isArray(b.escalateWhen));
    assert.equal(typeof b.schematicNote, "string");
  }
}

function testWarnStepConvention() {
  // Steps that start with "⚠" render in red via the alarm-detail-step-warn
  // class. Make sure the marker is the first character (no leading whitespace)
  // so the renderer's startsWith check fires.
  for (const b of ALARM_BITS) {
    for (const step of b.actionSteps) {
      if (step.includes("⚠")) {
        assert.ok(
          step.indexOf("⚠") === 0,
          `bit ${b.bit}: ⚠ marker must be first character to trigger warn styling. Got: "${step.slice(0, 40)}…"`,
        );
      }
    }
  }
}

function testLevelRefsPointToShippedPdfs() {
  // level1Ref / level2Ref strings include the PDF filename. The actual PDFs
  // ship under docs/. Verify each referenced filename exists.
  const docsDir = path.join(__dirname, "..", "..", "docs");
  for (const b of ALARM_BITS) {
    for (const ref of [b.level1Ref, b.level2Ref]) {
      const file = ref.split("#")[0];
      assert.ok(
        fs.existsSync(path.join(docsDir, file)),
        `bit ${b.bit}: ${file} not found under docs/`,
      );
    }
  }
}

function run() {
  testCount();
  testCoreFields();
  testNoviceFields();
  testPhysicalDevicesHaveDescriptors();
  testSchematicPageBounds();
  testTrinPmCoverage();
  testJsonSerializable();
  testWarnStepConvention();
  testLevelRefsPointToShippedPdfs();
  console.log("alarmReferenceShape.test.js: PASS (" + ALARM_BITS.length + " bits validated)");
}

run();
