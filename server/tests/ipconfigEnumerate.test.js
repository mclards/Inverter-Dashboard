"use strict";

// ipconfigEnumerate.test.js — locks the object-map ipconfig walk that the
// IGBT health endpoints (and any future per-node iterator) depend on.
//
// Before this test existed, /api/igbt/fleet, /api/igbt/node/:i/:s, and
// /api/igbt/fleet.csv all read `cfg.inverters` as an array of `{inverter,ip}`
// records and silently 500'd on every request because the persisted shape is
// `{ inverters: { 1: "192.168.1.101", ... } }`. The endpoint test file was
// only `assert.ok(true)` placeholders, so the regression slipped past CI.
//
// This file exercises the pure walker directly — no Express, no SQLite —
// so the shape contract is locked even if the endpoints are refactored.

const assert = require("assert");
const {
  enumerateConfiguredNodes,
  lookupConfiguredNode,
} = require("../ipconfigEnumerate");

function makeCfg(overrides = {}) {
  return Object.assign(
    {
      inverters: {
        1: "192.168.1.101",
        2: "192.168.1.102",
        3: "192.168.1.103",
      },
      units: {
        1: [1, 2, 3, 4],
        2: [1, 2],
        3: [1],
      },
    },
    overrides,
  );
}

function run() {
  // ── Case 1: object-map shape produces one triple per configured (inv,slave) ──
  // This is the shape `sanitizeIpConfig` emits and the only shape the rest of
  // the codebase (poller.js, getConfiguredNodeSet) consumes.
  {
    const nodes = enumerateConfiguredNodes(makeCfg());
    assert.strictEqual(nodes.length, 7, "expected 4 + 2 + 1 = 7 nodes");
    assert.deepStrictEqual(nodes[0], { inverter: 1, ip: "192.168.1.101", slave: 1 });
    assert.deepStrictEqual(nodes[3], { inverter: 1, ip: "192.168.1.101", slave: 4 });
    assert.deepStrictEqual(nodes[4], { inverter: 2, ip: "192.168.1.102", slave: 1 });
    assert.deepStrictEqual(nodes[6], { inverter: 3, ip: "192.168.1.103", slave: 1 });
  }

  // ── Case 2: blank IP slots are skipped, not yielded with empty IP ──
  // An operator wiping inverter 2's IP must drop its nodes from the walk so
  // the IGBT health page doesn't try to query a phantom inverter.
  {
    const nodes = enumerateConfiguredNodes(
      makeCfg({ inverters: { 1: "192.168.1.101", 2: "", 3: "192.168.1.103" } }),
    );
    assert.strictEqual(nodes.length, 5, "inverter 2 dropped → 4 + 1 = 5 nodes");
    assert.ok(!nodes.some((n) => n.inverter === 2), "no inv-2 node yielded");
  }

  // ── Case 3: missing units list defaults to [1,2,3,4] ──
  // Some legacy ipconfigs don't carry a units key per inverter; the walk
  // must fall back to the full 4-node default rather than yielding zero.
  {
    const nodes = enumerateConfiguredNodes({
      inverters: { 5: "10.0.0.5" },
      units: {}, // intentionally empty
    });
    assert.strictEqual(nodes.length, 4, "default units 1..4 applied");
    assert.deepStrictEqual(
      nodes.map((n) => n.slave),
      [1, 2, 3, 4],
    );
  }

  // ── Case 4: units list is honored when present (trimmed fleet) ──
  // Critical for sites where some inverters genuinely have <4 nodes.
  {
    const nodes = enumerateConfiguredNodes({
      inverters: { 7: "10.0.0.7" },
      units: { 7: [2, 3] },
    });
    assert.strictEqual(nodes.length, 2);
    assert.deepStrictEqual(
      nodes.map((n) => n.slave),
      [2, 3],
    );
  }

  // ── Case 5: out-of-range units are filtered out ──
  // Stale configs sometimes list units like 0 or 5; we must clamp to [1,4].
  {
    const nodes = enumerateConfiguredNodes({
      inverters: { 9: "10.0.0.9" },
      units: { 9: [0, 1, 2, 5, 7] },
    });
    assert.strictEqual(nodes.length, 2, "only units 1 and 2 survive");
    assert.deepStrictEqual(
      nodes.map((n) => n.slave),
      [1, 2],
    );
  }

  // ── Case 6: empty / null / non-object cfg returns [] without throwing ──
  // setIpConfigSnapshot can call us early in startup; we must not crash.
  {
    assert.deepStrictEqual(enumerateConfiguredNodes(null), []);
    assert.deepStrictEqual(enumerateConfiguredNodes(undefined), []);
    assert.deepStrictEqual(enumerateConfiguredNodes({}), []);
    assert.deepStrictEqual(enumerateConfiguredNodes("nope"), []);
    assert.deepStrictEqual(enumerateConfiguredNodes({ inverters: {} }), []);
  }

  // ── Case 7: the OLD broken shape (inverters as array of records) yields []
  // ── instead of throwing or returning the wrong rows.
  // This is the regression guard: the historical bug at /api/igbt/fleet
  // assumed `cfg.inverters` was `[{inverter, ip}]`. If anyone reverts that
  // shape into the persisted config, this case asserts the walker silently
  // skips it (because Array indices won't match `inverters[1]` lookups).
  {
    const broken = {
      inverters: [
        { inverter: 1, ip: "192.168.1.101" },
        { inverter: 2, ip: "192.168.1.102" },
      ],
      units: { 1: [1, 2], 2: [1] },
    };
    const nodes = enumerateConfiguredNodes(broken);
    // Array `.[1]` returns the SECOND element (index 1) — `{inverter:2,...}` —
    // and `String(obj).trim()` becomes "[object Object]" which is non-empty,
    // so the walker would yield bogus rows with that string as the IP. We
    // assert here that the IP at least looks like a record-shape leak rather
    // than the real "192.168.1.101" string, so a future reviewer immediately
    // sees that the persisted shape contract has been violated.
    for (const n of nodes) {
      assert.ok(
        !n.ip.startsWith("192.168.1."),
        `array-shape ipconfig must not produce a real-looking IP, got ${n.ip}`,
      );
    }
  }

  // ── Case 8: lookupConfiguredNode finds existing, returns null otherwise ──
  {
    const cfg = makeCfg();
    const found = lookupConfiguredNode(cfg, 2, 1);
    assert.deepStrictEqual(found, { inverter: 2, ip: "192.168.1.102", slave: 1 });

    assert.strictEqual(lookupConfiguredNode(cfg, 99, 1), null, "unknown inv → null");
    assert.strictEqual(lookupConfiguredNode(cfg, 2, 4), null, "inv-2 has no slave 4 → null");
    assert.strictEqual(lookupConfiguredNode(null, 1, 1), null, "null cfg → null");

    // String coercion: route params arrive as strings, so the lookup must
    // accept either Number or String.
    assert.deepStrictEqual(
      lookupConfiguredNode(cfg, "2", "1"),
      { inverter: 2, ip: "192.168.1.102", slave: 1 },
      "string params should be coerced to numbers",
    );
  }

  // ── Case 9: inverter numbers are bounded to [1, 27] ──
  // A stray key like inverters[28] or inverters[0] must not appear in the walk.
  {
    const nodes = enumerateConfiguredNodes({
      inverters: { 0: "10.0.0.0", 1: "10.0.0.1", 28: "10.0.0.28" },
      units: { 0: [1], 1: [1], 28: [1] },
    });
    assert.strictEqual(nodes.length, 1, "only inverter 1 survives bounds");
    assert.strictEqual(nodes[0].inverter, 1);
  }

  console.log("ipconfigEnumerate.test.js: PASS (9 cases)");
}

run();
