"use strict";

// Source-of-truth test for the locked factory serial map
// (server/serialFixedMap.js, generated 1:1 from the authoritative
// docs/Fixed_Inverter_SerialNumbers.xlsx) and the bulk re-serialize diff
// (buildBulkPlan) including the auto-detected module relocation guard.
//
// The map drives IRREVERSIBLE hardware writes, so these invariants are
// non-negotiable:
//   • 27 inverters, each with T + nodes 1..4 (135 entries).
//   • Every serial is exactly 12 ASCII printable chars (Motorola).
//   • All 135 serials are globally unique — the numbering is locked even
//     when a physical node is absent, so a serial is never reused (this is
//     what makes the reverse origin index unambiguous).
//   • Inverter 2 and Inverter 14 (the formerly-mistyped rows) are now clean
//     12-char serials in the family pattern.
//   • lookupSerialOrigin resolves any live serial to its factory slot, and
//     buildBulkPlan flags a serial belonging to a DIFFERENT slot as a
//     relocated module needing acknowledgement.
//
// Pure static — does NOT load better-sqlite3, so it runs under both the
// Node-ABI and Electron-ABI native builds (mirrors alarmReferenceShape).

const assert = require("assert");
const {
  FIXED_SERIAL_MAP,
  FIXED_SERIAL_FMT,
  WRITABLE_NODES,
  getTargetSerial,
  lookupSerialOrigin,
} = require("../serialFixedMap");
const {
  buildBulkPlan, logSerialChange, getModuleMigrationHistory,
} = require("../serialNumber");

// Tiny in-memory stand-in for the better-sqlite3 handle so this test stays
// ABI-agnostic (no native module). Captures INSERTed rows and answers the
// migration-history SELECT by applying its WHERE semantics in JS.
function makeFakeDb() {
  const rows = [];
  return {
    rows,
    prepare(sql) {
      const s = String(sql);
      return {
        run(...args) {
          if (/^\s*INSERT INTO serial_change_log/i.test(s)) {
            // Column order mirrors logSerialChange's INSERT list.
            const [
              inverter_id, inverter_ip, slave, acted_at_ms, acted_by, fmt,
              old_serial, new_serial, verify_passed, outcome, error_detail,
              origin_note, origin_inverter, origin_node, updated_ts,
            ] = args;
            rows.push({
              id: rows.length + 1, inverter_id, inverter_ip, slave,
              acted_at_ms, acted_by, fmt, old_serial, new_serial,
              verify_passed, outcome, error_detail, origin_note,
              origin_inverter, origin_node, updated_ts,
            });
            return { lastInsertRowid: rows.length };
          }
          return { lastInsertRowid: 0 };
        },
        all(...args) {
          // getModuleMigrationHistory: WHERE origin_inverter IS NOT NULL
          // [AND inverter_ip = ?] ORDER BY acted_at_ms DESC LIMIT ?
          const cap = args[args.length - 1];
          const ipFilter = args.length === 2 ? args[0] : null;
          return rows
            .filter((r) => r.origin_inverter != null)
            .filter((r) => (ipFilter ? r.inverter_ip === ipFilter : true))
            .sort((a, b) => b.acted_at_ms - a.acted_at_ms)
            .slice(0, cap);
        },
      };
    },
  };
}

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}: ${err.message}`);
    process.exitCode = 1;
  }
}

check("format is motorola and writable nodes are 1..4", () => {
  assert.strictEqual(FIXED_SERIAL_FMT, "motorola");
  assert.deepStrictEqual(WRITABLE_NODES, [1, 2, 3, 4]);
});

check("27 inverters, each with T + nodes 1..4 as serial strings", () => {
  const ids = Object.keys(FIXED_SERIAL_MAP).map(Number).sort((a, b) => a - b);
  assert.deepStrictEqual(ids, Array.from({ length: 27 }, (_, i) => i + 1));
  for (const id of ids) {
    for (const k of ["T", "1", "2", "3", "4"]) {
      const s = FIXED_SERIAL_MAP[id][k];
      assert.ok(typeof s === "string" && s.length,
        `inverter ${id} node ${k} missing serial`);
    }
  }
});

check("every serial is 12 ASCII printable chars", () => {
  for (const id of Object.keys(FIXED_SERIAL_MAP)) {
    for (const k of ["T", "1", "2", "3", "4"]) {
      const s = FIXED_SERIAL_MAP[id][k];
      assert.ok(/^[\x20-\x7E]{12}$/.test(s),
        `inverter ${id} node ${k} = '${s}' (${s.length}) not 12 ASCII printable`);
    }
  }
});

check("all 135 serials are globally unique", () => {
  const seen = new Map();
  for (const id of Object.keys(FIXED_SERIAL_MAP)) {
    for (const k of ["T", "1", "2", "3", "4"]) {
      const s = FIXED_SERIAL_MAP[id][k];
      assert.ok(!seen.has(s),
        `duplicate serial '${s}' at inv ${id} node ${k} (also ${seen.get(s)})`);
      seen.set(s, `inv ${id} node ${k}`);
    }
  }
  assert.strictEqual(seen.size, 135);
});

check("Inverter 2 / Inverter 14 are the corrected 12-char serials", () => {
  assert.deepStrictEqual(FIXED_SERIAL_MAP[2], {
    T: "400152A18R00", 1: "400152A18R01", 2: "400152A18R02",
    3: "400152A18R03", 4: "400152A18R04",
  });
  assert.deepStrictEqual(FIXED_SERIAL_MAP[14], {
    T: "400152A17R30", 1: "400152A17R31", 2: "400152A17R32",
    3: "400152A17R33", 4: "400152A17R34",
  });
});

check("getTargetSerial resolves nodes and rejects unknowns", () => {
  assert.strictEqual(getTargetSerial(1, 1), "400152914R91");
  assert.strictEqual(getTargetSerial(4, 1), "400152915R41");
  assert.strictEqual(getTargetSerial(99, 1), null);
  assert.strictEqual(getTargetSerial(1, 9), null);
});

check("lookupSerialOrigin resolves slot, kind, and misses", () => {
  assert.deepStrictEqual(lookupSerialOrigin("400152915R41"),
    { inverter: 4, node: 1, kind: "node" });
  assert.deepStrictEqual(lookupSerialOrigin("400152914R90"),
    { inverter: 1, node: "T", kind: "nameplate" });
  assert.strictEqual(lookupSerialOrigin("NOTAREALSER1"), null);
  assert.strictEqual(lookupSerialOrigin(""), null);
});

check("buildBulkPlan classifies match / mismatch / unreachable / missing", () => {
  const plan = buildBulkPlan({
    scanRows: [
      { inverter_id: 1, slave: 1, ok: true, serial: "FACTORYDEF01" }, // mismatch/unknown
      { inverter_id: 1, slave: 2, ok: true, serial: getTargetSerial(1, 2) }, // match
      { inverter_id: 1, slave: 3, ok: false, error: "timed out" }, // unreachable
      // inv1 slave4 + everything else absent -> missing
    ],
  });
  assert.strictEqual(plan.fmt, "motorola");
  assert.strictEqual(plan.total, 108); // 27 * 4 writable nodes
  const get = (i, s) => plan.rows.find((r) => r.inverter_id === i && r.slave === s);
  assert.strictEqual(get(1, 1).status, "mismatch");
  assert.strictEqual(get(1, 1).origin_kind, "unknown");
  assert.strictEqual(get(1, 1).needs_ack, false);
  assert.strictEqual(get(1, 2).status, "match");
  assert.strictEqual(get(1, 3).status, "unreachable");
  assert.strictEqual(get(1, 4).status, "missing");
  assert.strictEqual(plan.summary.match, 1);
  assert.strictEqual(plan.summary.mismatch, 1);
  assert.strictEqual(plan.summary.unreachable, 1);
  assert.strictEqual(plan.summary.missing, 105);
});

check("buildBulkPlan flags a physically relocated module", () => {
  // Operator moved Inverter 4 / Node 1's board to Inverter 27 / Node 2.
  // Node 2 now reports Inv4/Node1's locked serial.
  const movedSerial = getTargetSerial(4, 1); // 400152915R41
  const plan = buildBulkPlan({
    scanRows: [
      { inverter_id: 27, slave: 2, ok: true, serial: movedSerial },
    ],
  });
  const r = plan.rows.find((x) => x.inverter_id === 27 && x.slave === 2);
  assert.strictEqual(r.status, "mismatch");
  assert.strictEqual(r.origin_kind, "relocated");
  assert.strictEqual(r.needs_ack, true);
  assert.deepStrictEqual(r.origin, { inverter: 4, node: 1 });
  assert.ok(/module from Inv 4 \/ Node 1/.test(r.origin_note),
    `origin_note='${r.origin_note}'`);
  assert.strictEqual(r.target_serial, getTargetSerial(27, 2));
  assert.strictEqual(plan.summary.relocated, 1);
  assert.strictEqual(plan.summary.needs_ack, 1);
});

check("buildBulkPlan treats a nameplate serial on a node as needs_ack", () => {
  const plan = buildBulkPlan({
    scanRows: [
      { inverter_id: 5, slave: 1, ok: true, serial: getTargetSerial(9, "T") },
    ],
  });
  const r = plan.rows.find((x) => x.inverter_id === 5 && x.slave === 1);
  assert.strictEqual(r.origin_kind, "nameplate");
  assert.strictEqual(r.needs_ack, true);
});

check("buildBulkPlan honours topology filter", () => {
  const topology = [{ inverterId: 5, slave: 1 }, { inverterId: 5, slave: 2 }];
  const plan = buildBulkPlan({ scanRows: [], topology });
  assert.strictEqual(plan.total, 2);
  assert.ok(plan.rows.every((r) => r.inverter_id === 5 && [1, 2].includes(r.slave)));
});

check("logSerialChange persists structured origin + migration history filters it", () => {
  const db = makeFakeDb();
  // A plain in-place correction (no origin) — must NOT appear in history.
  logSerialChange(db, {
    inverterId: 1, inverterIp: "10.0.0.1", slave: 1, actedAtMs: 1000,
    actedBy: "OP", fmt: "motorola", oldSerial: "FACTORYDEF01",
    newSerial: getTargetSerial(1, 1), verifyPassed: true,
    outcome: "bulk_success",
  });
  // A relocated module: board from Inv 4 / Node 1 found at Inv 27 / Node 2.
  logSerialChange(db, {
    inverterId: 27, inverterIp: "10.0.0.27", slave: 2, actedAtMs: 2000,
    actedBy: "OP", fmt: "motorola", oldSerial: getTargetSerial(4, 1),
    newSerial: getTargetSerial(27, 2), verifyPassed: true,
    outcome: "bulk_success",
    originNote: "module from Inv 4 / Node 1 (serial 400152915R41)",
    originInverter: 4, originNode: 1,
  });
  const last = db.rows[db.rows.length - 1];
  assert.strictEqual(last.origin_inverter, 4);
  assert.strictEqual(last.origin_node, "1"); // stored as TEXT
  assert.strictEqual(db.rows[0].origin_inverter, null);

  const hist = getModuleMigrationHistory(db, { limit: 50 });
  assert.strictEqual(hist.length, 1, "only the relocation row");
  assert.strictEqual(hist[0].inverter_id, 27);
  assert.strictEqual(hist[0].slave, 2);
  assert.strictEqual(hist[0].origin_inverter, 4);
  assert.strictEqual(hist[0].origin_node, "1");
  assert.strictEqual(hist[0].new_serial, getTargetSerial(27, 2));

  // inverter_ip filter narrows correctly.
  assert.strictEqual(
    getModuleMigrationHistory(db, { limit: 50, inverterIp: "10.0.0.99" }).length,
    0,
  );
  assert.strictEqual(
    getModuleMigrationHistory(db, { limit: 50, inverterIp: "10.0.0.27" }).length,
    1,
  );
});

check("logSerialChange coerces origin types and tolerates nulls", () => {
  const db = makeFakeDb();
  logSerialChange(db, {
    inverterId: 5, inverterIp: "10.0.0.5", slave: 1, actedAtMs: 10,
    actedBy: "OP", fmt: "motorola", oldSerial: "x", newSerial: "y",
    verifyPassed: false, outcome: "bulk_needs_ack",
    originNote: "n", originInverter: "9", originNode: "T",
  });
  const row = db.rows[0];
  assert.strictEqual(row.origin_inverter, 9);   // "9" -> 9
  assert.strictEqual(row.origin_node, "T");
  // No origin args -> nulls (excluded from history).
  logSerialChange(db, {
    inverterId: 6, inverterIp: "10.0.0.6", slave: 2, actedAtMs: 11,
    actedBy: "OP", fmt: "motorola", oldSerial: "x", newSerial: "y",
    verifyPassed: true, outcome: "bulk_success",
  });
  assert.strictEqual(db.rows[1].origin_inverter, null);
  assert.strictEqual(db.rows[1].origin_node, null);
  assert.strictEqual(getModuleMigrationHistory(db, {}).length, 1);
});

if (process.exitCode) {
  console.error(`\nserialBulkMap: FAILED (${passed} passed)`);
} else {
  console.log(`\nserialBulkMap: all ${passed} checks passed`);
}
