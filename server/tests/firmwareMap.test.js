"use strict";

// Source-of-truth test for per-inverter firmware homogeneity
// (server/firmwareMap.js). The authoritative firmware identity is
// `model_code` ONLY (the AAV1003xx inverter firmware) — verified
// 2026-05-19 against ISM's decompiled FC11 parser
// (IngeconModbusSlaveID_Freescale::SetData reads serial + ONE Firmware
// code; it never populates FirmwareDisplay for our hardware family).
// `firmware_main`/`firmware_aux` (the AAS… strings) are unverified
// diagnostics and MUST NOT affect the comparison — these invariants are
// non-negotiable because a silent model drift = an un-audited board swap,
// while aux noise must never raise a false alarm:
//   • Canonical = modal model_code, deterministic tie-break, pinned
//     override wins outright; aux strings ignored entirely.
//   • Per-node ok/bad/unknown and per-inverter uniform/split/partial/none.
//   • diffForPersist emits drift ONLY on a real model_code change of a
//     previously-seen node — never on first sighting, unknown reads, or
//     an aux-only change.
//   • Persistence helpers coerce types and tolerate nulls.
//
// Pure static — does NOT load better-sqlite3, so it runs under both the
// Node-ABI and Electron-ABI native builds (mirrors serialBulkMap).

const assert = require("assert");
const {
  fwTuple,
  parseExpectedTuple,
  computeCanonical,
  classifyFleet,
  diffForPersist,
  upsertFirmwareState,
  logFirmwareDrift,
  getFirmwareStateAll,
  getFirmwareDriftLog,
  pruneFirmwareDriftLog,
} = require("../firmwareMap");

// In-memory better-sqlite3 stand-in (ABI-agnostic). Models the three SQL
// shapes firmwareMap.js issues: state upsert (ON CONFLICT), drift insert,
// state/drift selects, and the prune DELETE.
function makeFakeDb() {
  const state = new Map(); // "ip|slave" -> row
  const drift = [];
  return {
    state, drift,
    transaction(fn) { return (arg) => fn(arg); },
    prepare(sql) {
      const s = String(sql);
      return {
        run(arg, ...rest) {
          if (/INSERT INTO inverter_firmware_state/i.test(s)) {
            const k = `${arg.inverter_ip}|${arg.slave}`;
            const ex = state.get(k);
            state.set(k, {
              ...arg,
              first_seen_ms: ex ? ex.first_seen_ms : arg.first_seen_ms,
            });
            return { changes: 1 };
          }
          if (/INSERT INTO firmware_drift_log/i.test(s)) {
            const [
              inverter_id, inverter_ip, slave, old_tuple, new_tuple,
              detected_at_ms, scan_by, note,
            ] = [arg, ...rest];
            drift.push({
              id: drift.length + 1, inverter_id, inverter_ip, slave,
              old_tuple, new_tuple, detected_at_ms, scan_by, note,
            });
            return { lastInsertRowid: drift.length };
          }
          if (/DELETE FROM firmware_drift_log/i.test(s)) {
            const cutoff = arg;
            const before = drift.length;
            for (let i = drift.length - 1; i >= 0; i--) {
              if (drift[i].detected_at_ms < cutoff) drift.splice(i, 1);
            }
            return { changes: before - drift.length };
          }
          return { changes: 0 };
        },
        all(...args) {
          if (/FROM inverter_firmware_state/i.test(s)) {
            return Array.from(state.values())
              .sort((a, b) => (a.inverter_ip + a.slave).localeCompare(b.inverter_ip + b.slave));
          }
          if (/FROM firmware_drift_log/i.test(s)) {
            const ipFilter = /inverter_ip = \?/.test(s) ? args[0] : null;
            const cap = args[args.length - 1];
            return drift
              .filter((r) => (ipFilter ? r.inverter_ip === ipFilter : true))
              .sort((a, b) => b.detected_at_ms - a.detected_at_ms)
              .slice(0, cap);
          }
          return [];
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

// N(ip, slave, model, aux1, aux2, ok?, extra?) — model is the ONLY
// comparison key; aux1/aux2 are diagnostics that must never affect a verdict.
const N = (ip, slave, m, f1, f2, ok = true, extra = {}) => ({
  inverter_id: Number(ip.split(".")[3]), inverter_ip: ip, inverter_name: `Inv ${ip}`,
  slave, ok, model_code: m, firmware_main: f1, firmware_aux: f2, ...extra,
});

check("fwTuple = model_code only (normalised); aux strings ignored", () => {
  assert.strictEqual(
    fwTuple({ model_code: " aav1003bc ", firmware_main: "AAS1091AA", firmware_aux: "AAS1092_F" }),
    "AAV1003BC");
  // Same model, wildly different aux → identical tuple (the screenshot bug fix).
  assert.strictEqual(
    fwTuple({ model_code: "AAV1003BC", firmware_main: "", firmware_aux: "" }),
    fwTuple({ model_code: "AAV1003BC", firmware_main: "AAS1091AA", firmware_aux: "AAS1092_F" }));
  assert.strictEqual(fwTuple({ model_code: null }), "");
  assert.strictEqual(fwTuple(null), "");
});

check("parseExpectedTuple accepts plain code, JSON object, rejects garbage", () => {
  assert.strictEqual(parseExpectedTuple(null), null);
  assert.strictEqual(parseExpectedTuple(""), null);
  assert.strictEqual(parseExpectedTuple("{not json"), null);
  assert.strictEqual(parseExpectedTuple({ model_code: "" }), null);
  assert.strictEqual(parseExpectedTuple("aav1003bc"), "AAV1003BC");      // plain string
  assert.strictEqual(parseExpectedTuple({ model_code: "AAV1003BC" }), "AAV1003BC");
  assert.strictEqual(
    parseExpectedTuple('{"model_code":"AAV1003BC","firmware_main":"X"}'), "AAV1003BC");
});

check("computeCanonical = modal model_code, ignores failed/empty-model rows", () => {
  const rows = [
    N("10.0.0.1", 1, "AAV1003BC", "AAS1091AA", "AAS1092_F"),
    N("10.0.0.1", 2, "AAV1003BC", "", ""),                 // aux blank — still counts
    N("10.0.0.2", 1, "AAV1003BA", "AAS1091AA", "AAS1092_F"),
    N("10.0.0.2", 2, "", "", "", false, { error: "timeout" }),
  ];
  const { canonical, pinned } = computeCanonical(rows);
  assert.strictEqual(canonical, "AAV1003BC");   // 2× BC vs 1× BA
  assert.strictEqual(pinned, false);
});

check("computeCanonical tie-break is deterministic (lexical lowest)", () => {
  const rows = [N("10.0.0.1", 1, "BBB"), N("10.0.0.2", 1, "AAA")];
  assert.strictEqual(computeCanonical(rows).canonical, "AAA");
});

check("pinned-expected (string code) overrides modal even if fleet uniformly old", () => {
  const rows = [
    N("10.0.0.1", 1, "AAV1003OLD"),
    N("10.0.0.1", 2, "AAV1003OLD"),
    N("10.0.0.2", 1, "AAV1003OLD"),
  ];
  const expected = parseExpectedTuple("AAV1003NEW");
  const r = classifyFleet(rows, expected);
  assert.strictEqual(r.canonical, "AAV1003NEW");
  assert.strictEqual(r.canonical_pinned, true);
  assert.strictEqual(r.summary.drift, 3);
  assert.strictEqual(r.summary.homogeneous, false);
});

check("classifyFleet: same model + differing aux is STILL all ok", () => {
  // The exact screenshot scenario: identical AAV1003BC, blank/variant AAS.
  const rows = [
    N("192.168.1.115", 1, "AAV1003BC", "", ""),
    N("192.168.1.115", 2, "AAV1003BC", "", ""),
    N("192.168.1.115", 3, "AAV1003BC", "AAS1091AA", "AAS1092_F"),
    N("192.168.1.115", 4, "AAV1003BC", "", ""),
    N("192.168.1.116", 1, "AAV1003BC", "", ""),
  ];
  const r = classifyFleet(rows);
  assert.strictEqual(r.summary.homogeneous, true);
  assert.strictEqual(r.summary.drift, 0);
  assert.strictEqual(r.summary.split_inverters, 0);
  assert.strictEqual(r.perInverter.every((i) => i.verdict === "uniform"), true);
});

check("classifyFleet: intra-inverter split is driven by model_code only", () => {
  const rows = [
    N("10.0.0.1", 1, "AAV1003BC", "X", "Y"),
    N("10.0.0.1", 2, "AAV1003BC", "Z", "W"),               // aux differs — NOT a split
    N("10.0.0.5", 1, "AAV1003BC", "X", "Y"),
    N("10.0.0.5", 2, "AAV1003BA", "X", "Y"),               // MODEL differs — split
  ];
  const r = classifyFleet(rows);
  const inv1 = r.perInverter.find((i) => i.inverter_ip === "10.0.0.1");
  const inv5 = r.perInverter.find((i) => i.inverter_ip === "10.0.0.5");
  assert.strictEqual(inv1.verdict, "uniform");   // aux-only diff is NOT a split
  assert.strictEqual(inv5.verdict, "split");
  assert.strictEqual(r.summary.split_inverters, 1);
});

check("classifyFleet: unknown node -> partial, snapshot not clobbered", () => {
  const rows = [
    N("10.0.0.3", 1, "AAV1003BC"),
    N("10.0.0.3", 2, "", "", "", false, { error: "0x0b gateway target" }),
  ];
  const r = classifyFleet(rows);
  assert.strictEqual(r.perInverter[0].verdict, "partial");
  assert.strictEqual(r.summary.unknown, 1);
  assert.strictEqual(r.perNode.find((n) => n.slave === 2).status, "unknown");
});

check("classifyFleet: IP-octet sort orders inverters numerically", () => {
  const rows = [
    N("10.0.0.10", 1, "M"), N("10.0.0.2", 1, "M"), N("10.0.0.1", 1, "M"),
  ];
  assert.deepStrictEqual(
    classifyFleet(rows).perInverter.map((i) => i.inverter_ip),
    ["10.0.0.1", "10.0.0.2", "10.0.0.10"]);
});

check("diffForPersist: first sighting upserts but logs NO drift", () => {
  const cls = classifyFleet([N("10.0.0.1", 1, "AAV1003BC", "X", "Y")]);
  const { upserts, driftEvents } = diffForPersist([], cls, 1000);
  assert.strictEqual(upserts.length, 1);
  assert.strictEqual(upserts[0].first_seen_ms, 1000);
  assert.strictEqual(upserts[0].firmware_main, "X");   // aux still stored for display
  assert.strictEqual(driftEvents.length, 0);
});

check("diffForPersist: real model_code change logs exactly one drift event", () => {
  const prev = [{ inverter_ip: "10.0.0.1", slave: 1, model_code: "AAV1003BA", firmware_main: "X", firmware_aux: "Y", first_seen_ms: 500 }];
  const cls = classifyFleet([N("10.0.0.1", 1, "AAV1003BC", "X", "Y")]);
  const { upserts, driftEvents } = diffForPersist(prev, cls, 2000);
  assert.strictEqual(driftEvents.length, 1);
  assert.strictEqual(driftEvents[0].old_tuple, "AAV1003BA");
  assert.strictEqual(driftEvents[0].new_tuple, "AAV1003BC");
  assert.strictEqual(upserts[0].first_seen_ms, 500);
  assert.strictEqual(upserts[0].last_seen_ms, 2000);
});

check("diffForPersist: aux-only change is NOT drift (the verified correction)", () => {
  const prev = [{ inverter_ip: "10.0.0.1", slave: 1, model_code: "AAV1003BC", firmware_main: "AAS1091AA", firmware_aux: "AAS1092_F", first_seen_ms: 500 }];
  const cls = classifyFleet([N("10.0.0.1", 1, "AAV1003BC", "", "")]);  // aux vanished
  const { upserts, driftEvents } = diffForPersist(prev, cls, 2000);
  assert.strictEqual(driftEvents.length, 0);            // model unchanged → no drift
  assert.strictEqual(upserts.length, 1);                // snapshot still refreshed
});

check("diffForPersist: unknown read never clobbers and never logs drift", () => {
  const prev = [{ inverter_ip: "10.0.0.1", slave: 1, model_code: "AAV1003BC", first_seen_ms: 500 }];
  const cls = classifyFleet([N("10.0.0.1", 1, "", "", "", false, { error: "timeout" })]);
  const { upserts, driftEvents } = diffForPersist(prev, cls, 3000);
  assert.strictEqual(upserts.length, 0);
  assert.strictEqual(driftEvents.length, 0);
});

check("persistence: upsert preserves first_seen, drift log + prune + filters", () => {
  const db = makeFakeDb();
  upsertFirmwareState(db, [
    { inverter_ip: "10.0.0.1", slave: 1, inverter_id: 1, model_code: "AAV1003BC", firmware_main: "F1", firmware_aux: "F2", canonical_match: 1, first_seen_ms: 100, last_seen_ms: 100 },
  ]);
  upsertFirmwareState(db, [
    { inverter_ip: "10.0.0.1", slave: 1, inverter_id: 1, model_code: "AAV1003BA", firmware_main: "F9", firmware_aux: "F2", canonical_match: 0, first_seen_ms: 999, last_seen_ms: 200 },
  ]);
  const st = getFirmwareStateAll(db);
  assert.strictEqual(st.length, 1);
  assert.strictEqual(st[0].first_seen_ms, 100);   // ON CONFLICT preserved
  assert.strictEqual(st[0].model_code, "AAV1003BA");
  assert.strictEqual(st[0].canonical_match, 0);

  logFirmwareDrift(db, { inverter_id: 1, inverter_ip: "10.0.0.1", slave: 1, old_tuple: "AAV1003BA", new_tuple: "AAV1003BC", detected_at_ms: 50, note: "n" });
  logFirmwareDrift(db, { inverter_id: 2, inverter_ip: "10.0.0.2", slave: 1, old_tuple: "A", new_tuple: "B", detected_at_ms: 9_000_000_000_000, note: "recent" });
  assert.strictEqual(getFirmwareDriftLog(db, {}).length, 2);
  assert.strictEqual(getFirmwareDriftLog(db, { inverterIp: "10.0.0.2" }).length, 1);
  assert.strictEqual(pruneFirmwareDriftLog(db, 365), 1);   // drops the ancient row
  assert.strictEqual(getFirmwareDriftLog(db, {}).length, 1);
});

check("empty / all-unknown scan is safe (no canonical, not homogeneous)", () => {
  assert.strictEqual(classifyFleet([]).canonical, null);
  const allBad = classifyFleet([N("10.0.0.1", 1, "", "", "", false, { error: "x" })]);
  assert.strictEqual(allBad.canonical, null);
  assert.strictEqual(allBad.summary.homogeneous, false);
  assert.strictEqual(allBad.perInverter[0].verdict, "none");
});

if (process.exitCode) {
  console.error(`\nfirmwareMap: FAILED (${passed} passed)`);
} else {
  console.log(`\nfirmwareMap: all ${passed} checks passed`);
}
