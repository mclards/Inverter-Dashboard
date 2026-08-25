"use strict";

// settingsSectionRegistry.test.js — locks the settings-panel section contract.
//
// Regression origin: the "RS485 Bus" menu button was added with
// data-settings-section="rs485BusSection" and a matching <div id="rs485BusSection">
// in index.html, but the id was never registered in SETTINGS_SECTION_IDS /
// SETTINGS_SECTION_META in app.js. normalizeSettingsSectionId() falls back to
// DEFAULT_SETTINGS_SECTION_ID for any unregistered id, so clicking the button
// silently showed the Plant section. Syntax checks, brace/div balance, unit
// tests and smoke ALL passed — a registration omission produces no detectable
// signal except by clicking. This test makes that gap fail in CI instead.
//
// Pure text extraction (no browser/app.js execution) — same idiom as the
// Python text-extract tests. Locks four invariants:
//   1. every menu data-settings-section ∈ SETTINGS_SECTION_IDS
//   2. every menu data-settings-section has a matching element id in index.html
//   3. SETTINGS_SECTION_IDS ⇔ SETTINGS_SECTION_META keys (bijection)
//   4. DEFAULT_SETTINGS_SECTION_ID ∈ SETTINGS_SECTION_IDS

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const HTML = fs.readFileSync(
  path.join(ROOT, "public", "index.html"),
  "utf8",
);
const APP = fs.readFileSync(
  path.join(ROOT, "public", "js", "app.js"),
  "utf8",
);

function menuSectionIds() {
  const out = new Set();
  const re = /data-settings-section="([^"]+)"/g;
  let m;
  while ((m = re.exec(HTML)) !== null) out.add(m[1]);
  return out;
}

function elementIds() {
  const out = new Set();
  const re = /\bid="([^"]+)"/g;
  let m;
  while ((m = re.exec(HTML)) !== null) out.add(m[1]);
  return out;
}

function arrayLiteral(name) {
  const start = APP.indexOf(`const ${name} = [`);
  assert.ok(start >= 0, `could not find const ${name} = [`);
  const end = APP.indexOf("];", start);
  assert.ok(end > start, `could not find end of ${name}`);
  const body = APP.slice(start, end);
  const out = new Set();
  const re = /"([^"]+)"/g;
  let m;
  while ((m = re.exec(body)) !== null) out.add(m[1]);
  return out;
}

function metaKeys() {
  const start = APP.indexOf("const SETTINGS_SECTION_META = {");
  assert.ok(start >= 0, "could not find SETTINGS_SECTION_META");
  // First top-level "};" after the declaration closes the object literal.
  const end = APP.indexOf("\n};", start);
  assert.ok(end > start, "could not find end of SETTINGS_SECTION_META");
  const body = APP.slice(start, end);
  const out = new Set();
  // Top-level keys are indented exactly two spaces: `  someName: {`
  const re = /^ {2}([A-Za-z0-9_]+):\s*\{/gm;
  let m;
  while ((m = re.exec(body)) !== null) out.add(m[1]);
  return out;
}

function defaultId() {
  const m = APP.match(/const DEFAULT_SETTINGS_SECTION_ID = "([^"]+)"/);
  assert.ok(m, "could not find DEFAULT_SETTINGS_SECTION_ID");
  return m[1];
}

function run() {
  const menu = menuSectionIds();
  const ids = arrayLiteral("SETTINGS_SECTION_IDS");
  const meta = metaKeys();
  const elems = elementIds();
  const def = defaultId();

  assert.ok(menu.size >= 10, `expected ≥10 settings menu buttons, got ${menu.size}`);
  assert.ok(ids.size >= 10, `expected ≥10 SETTINGS_SECTION_IDS, got ${ids.size}`);

  // 1 + 2: every menu button maps to a registered AND existing section.
  for (const sec of menu) {
    assert.ok(
      ids.has(sec),
      `menu data-settings-section="${sec}" is NOT in SETTINGS_SECTION_IDS — ` +
        `clicking it falls back to "${def}" (the original RS485→Plant bug)`,
    );
    assert.ok(
      meta.has(sec),
      `menu section "${sec}" is missing from SETTINGS_SECTION_META — ` +
        `its header/subtitle would render the default section's meta`,
    );
    assert.ok(
      elems.has(sec),
      `menu section "${sec}" has no matching element id="${sec}" in index.html`,
    );
  }

  // 3: SETTINGS_SECTION_IDS and SETTINGS_SECTION_META must be a bijection.
  for (const id of ids) {
    assert.ok(
      meta.has(id),
      `SETTINGS_SECTION_IDS has "${id}" but SETTINGS_SECTION_META does not`,
    );
    assert.ok(
      elems.has(id),
      `SETTINGS_SECTION_IDS has "${id}" but index.html has no id="${id}"`,
    );
  }
  for (const k of meta) {
    assert.ok(
      ids.has(k),
      `SETTINGS_SECTION_META has "${k}" but SETTINGS_SECTION_IDS does not`,
    );
  }

  // 4: the fallback target must itself be a registered section.
  assert.ok(
    ids.has(def),
    `DEFAULT_SETTINGS_SECTION_ID "${def}" is not in SETTINGS_SECTION_IDS`,
  );

  // NOTE: the original regression that motivated this test was the
  // "RS485 Bus" (rs485BusSection) menu button being added without a matching
  // SETTINGS_SECTION_IDS/META entry. That section was REMOVED in v2.11.x
  // (field calibration moved to the standalone Inverter Calibration Tool),
  // so the old hardcoded `rs485BusSection must exist` assertion was retired.
  // The general bijection invariants above (menu ⇔ elements ⇔ IDS ⇔ META)
  // are the durable guard and would still catch the original class of bug
  // for ANY section, not just this one.

  console.log(
    `settingsSectionRegistry.test.js: PASS ` +
      `(${menu.size} menu, ${ids.size} ids, ${meta.size} meta — all consistent)`,
  );
}

run();
