"use strict";

// Hot-reload safety: when the operator saves a new ipconfig, setIpConfigSnapshot
// must drop per-key / per-inverter cache entries that no longer correspond to
// any configured (inv, unit) slot. Otherwise removed inverters or trimmed unit
// lists linger on the dashboard until the process restarts, which violates the
// "no restart required after save" contract.

const assert = require("assert");
const { pruneStateForConfig } = require("../poller");

function makeCfg(overrides = {}) {
  return Object.assign(
    {
      inverters: { 1: "192.168.1.101", 2: "192.168.1.102", 3: "192.168.1.103" },
      poll_interval: { 1: 0.05, 2: 0.05, 3: 0.05 },
      units: { 1: [1, 2, 3, 4], 2: [1, 2], 3: [1] },
      losses: { 1: 2.5, 2: 2.5, 3: 2.5 },
    },
    overrides,
  );
}

function run() {
  // ── Case 1: removing an inverter (slot 3) prunes its key + per-inv state ──
  {
    const liveData = { "1_1": {}, "2_1": {}, "3_1": {} };
    const pacTodayByInverter = { 1: 12.3, 2: 4.5, 3: 0.2 };
    const recentBucketIncByInv = { 1: [1, 2], 3: [9] };

    // Drop inverter 3 by emptying its IP.
    const cfg = makeCfg({
      inverters: { 1: "192.168.1.101", 2: "192.168.1.102", 3: "" },
    });

    const pruned = pruneStateForConfig(cfg, {
      perKey: [liveData],
      perInv: [pacTodayByInverter, recentBucketIncByInv],
    });

    assert.strictEqual(liveData["3_1"], undefined, "removed inverter key dropped");
    assert.ok(liveData["1_1"], "kept inverter key survives");
    assert.ok(liveData["2_1"], "kept inverter key survives");
    assert.strictEqual(pacTodayByInverter[3], undefined, "removed inverter PAC dropped");
    assert.strictEqual(pacTodayByInverter[1], 12.3, "kept inverter PAC survives");
    assert.strictEqual(recentBucketIncByInv[3], undefined, "removed inverter buckets dropped");
    assert.strictEqual(pruned, 3, "exactly 3 entries pruned (liveData + pac + buckets)");
  }

  // ── Case 2: trimming units prunes orphan unit keys but keeps survivors ──
  {
    const unreachableState = {
      "1_1": { missMs: 0 },
      "1_2": { missMs: 0 },
      "1_3": { missMs: 5 },
      "1_4": { missMs: 9 },
    };
    const lastPersistState = { "1_3": { ts: 1 }, "1_4": { ts: 2 } };

    // Inverter 1 trimmed from [1,2,3,4] to [1,2].
    const cfg = makeCfg({ units: { 1: [1, 2], 2: [1, 2], 3: [1] } });

    const pruned = pruneStateForConfig(cfg, {
      perKey: [unreachableState, lastPersistState],
      perInv: [],
    });

    assert.ok(unreachableState["1_1"], "unit 1 kept");
    assert.ok(unreachableState["1_2"], "unit 2 kept");
    assert.strictEqual(unreachableState["1_3"], undefined, "unit 3 dropped");
    assert.strictEqual(unreachableState["1_4"], undefined, "unit 4 dropped");
    assert.strictEqual(lastPersistState["1_3"], undefined, "persist state for orphan dropped");
    assert.strictEqual(pruned, 4, "4 orphan entries pruned across both caches");
  }

  // ── Case 3: pure IP swap (same inv/units) leaves all caches untouched ──
  {
    const liveData = { "1_1": { v: "alive" }, "2_1": { v: "alive" } };
    const pacIntegratorState = { "1_1": { ts: 1 }, "2_1": { ts: 2 } };
    const pacTodayByInverter = { 1: 10, 2: 20 };

    // Renumber IPs but keep same inverter slots + same unit lists.
    const cfg = makeCfg({
      inverters: { 1: "10.0.0.1", 2: "10.0.0.2", 3: "10.0.0.3" },
    });

    const pruned = pruneStateForConfig(cfg, {
      perKey: [liveData, pacIntegratorState],
      perInv: [pacTodayByInverter],
    });

    assert.strictEqual(pruned, 0, "no entries pruned on pure IP swap");
    assert.deepStrictEqual(Object.keys(liveData).sort(), ["1_1", "2_1"]);
    assert.deepStrictEqual(Object.keys(pacIntegratorState).sort(), ["1_1", "2_1"]);
    assert.deepStrictEqual(Object.keys(pacTodayByInverter).sort(), ["1", "2"]);
  }

  // ── Case 4: empty config (all slots cleared) prunes every cache entry ──
  // Operator wiping the IP config is a legitimate state and the caches must
  // follow — otherwise the dashboard keeps showing tiles for slots the
  // operator just emptied.
  {
    const liveData = { "1_1": {}, "2_3": {} };
    const pacTodayByInverter = { 1: 5, 2: 6 };
    const pruned = pruneStateForConfig(
      { inverters: {}, units: {} },
      { perKey: [liveData], perInv: [pacTodayByInverter] },
    );
    assert.strictEqual(Object.keys(liveData).length, 0, "all keys pruned on empty cfg");
    assert.strictEqual(Object.keys(pacTodayByInverter).length, 0, "all per-inv pruned");
    assert.strictEqual(pruned, 4);
  }

  // ── Case 5: Map-backed caches are pruned alongside plain-object caches ──
  // _nominalPowerLastWarnAt and todayEnergyBaseline*ByInv are Map instances;
  // the pruner must handle both shapes or those caches leak forever.
  {
    const warnMap = new Map([
      ["1_1", 1000],
      ["1_2", 1001],
      ["3_1", 1002], // orphan after dropping inv 3
    ]);
    const baselineByInv = new Map([
      [1, 12.0],
      [2, 8.0],
      [3, 0.4], // orphan after dropping inv 3
    ]);

    const cfg = makeCfg({
      inverters: { 1: "192.168.1.101", 2: "192.168.1.102", 3: "" },
    });

    const pruned = pruneStateForConfig(cfg, {
      perKey: [warnMap],
      perInv: [baselineByInv],
    });

    assert.ok(warnMap.has("1_1"), "kept-inverter Map key survives");
    assert.ok(warnMap.has("1_2"), "kept-unit Map key survives");
    assert.strictEqual(warnMap.has("3_1"), false, "orphan Map key dropped");
    assert.ok(baselineByInv.has(1), "kept per-inv Map entry survives");
    assert.ok(baselineByInv.has(2), "kept per-inv Map entry survives");
    assert.strictEqual(baselineByInv.has(3), false, "orphan per-inv Map entry dropped");
    assert.strictEqual(pruned, 2, "exactly 2 Map entries pruned");
  }

  // ── Case 6: null/undefined caches are tolerated (no throw) ──
  // setIpConfigSnapshot may be invoked early in startup before all caches
  // have been allocated; the pruner must degrade silently rather than crash.
  {
    const cfg = makeCfg();
    const pruned = pruneStateForConfig(cfg, {
      perKey: [null, undefined, { "1_1": {} }],
      perInv: [null, { 1: 1 }],
    });
    assert.strictEqual(pruned, 0, "no orphans in present caches; nulls ignored");
  }

  console.log("pollerIpConfigPrune.test.js: PASS (6 cases)");
}

run();
