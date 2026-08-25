"use strict";

const assert = require("assert");

delete require.cache[require.resolve("../criticalPatternEnforcer")];
const {
  RE_ENFORCEMENT_INTERVAL_MS,
  STOP_PER_SLAVE_DELAY_MS,
  decideBlockAction,
  summarizeBlockForApi,
  enforceOne,
} = require("../criticalPatternEnforcer");

function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      return r.then(
        () => console.log(`  ✓ ${name}`),
        (err) => { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; }
      );
    }
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}

async function run() {
  console.log("\n──────────────────────────────────────────────────────────");
  console.log("  criticalPatternEnforcerCore.test.js");
  console.log("──────────────────────────────────────────────────────────\n");

  test("RE_ENFORCEMENT_INTERVAL_MS = 5 minutes", () => {
    assert.strictEqual(RE_ENFORCEMENT_INTERVAL_MS, 5 * 60 * 1000);
  });

  test("STOP_PER_SLAVE_DELAY_MS = 1500 ms (graceful-stop default)", () => {
    assert.strictEqual(STOP_PER_SLAVE_DELAY_MS, 1500);
  });

  // ── decideBlockAction ──────────────────────────────────────────────────
  test("decide: no critical, no active block → noop", () => {
    const r = decideBlockAction({
      inverter: 3,
      slaves: [
        { slave: 1, patterns: [{ severity: "ok",    key: "DC_SUBSTRATE_BREACH", last_seen_ts: 0 }] },
        { slave: 2, patterns: [{ severity: "watch", key: "DC_SUBSTRATE_BREACH", last_seen_ts: 100 }] },
      ],
      activeBlock: null,
      now: 1000,
    });
    assert.strictEqual(r.kind, "noop");
    assert.strictEqual(r.reason, "no_critical_pattern");
  });

  test("decide: critical + no active block → open_block with worst pattern", () => {
    const r = decideBlockAction({
      inverter: 3,
      slaves: [
        { slave: 1, patterns: [{ severity: "critical", key: "DC_SUBSTRATE_BREACH", hex: "0x0240", label: "DC Substrate Breach", severity_rank: 2, count_in_window: 3, last_seen_ts: 500 }], unbalance: { sustained: true, max_pct: 24 } },
        { slave: 2, patterns: [{ severity: "critical", key: "DC_SUBSTRATE_BREACH", hex: "0x0240", label: "DC Substrate Breach", severity_rank: 2, count_in_window: 4, last_seen_ts: 800 }], unbalance: { sustained: true, max_pct: 27 } },
      ],
      activeBlock: null,
      inSolarWindow: false,
      now: 1000,
    });
    assert.strictEqual(r.kind, "open_block");
    // Same severity_rank, so freshness tiebreaker — slave 2 picked because
    // last_seen_ts is more recent (800 > 500).
    assert.strictEqual(r.triggering_slave, 2);
    assert.strictEqual(r.count_in_window, 4);
    assert.strictEqual(r.latest_episode_ts, 800);
    assert.strictEqual(r.pattern.key, "DC_SUBSTRATE_BREACH");
  });

  test("decide: 0x0240 outranks 0x0210 even when 0x0210 is fresher", () => {
    // Operator ruling (2026-05-12): catastrophic failure mode (substrate
    // breach + explosion) outranks degenerative one (bond-wire fatigue),
    // regardless of which episode is more recent.
    const r = decideBlockAction({
      inverter: 5,
      slaves: [
        { slave: 1, patterns: [
          // 0x0210 very recent
          { severity: "critical", key: "DC_FAULT_AC_OVERCURRENT", hex: "0x0210", label: "AC OC", severity_rank: 1, count_in_window: 5, last_seen_ts: 999_000 },
          // 0x0240 older but worse failure mode
          { severity: "critical", key: "DC_SUBSTRATE_BREACH",     hex: "0x0240", label: "Substrate Breach", severity_rank: 2, count_in_window: 2, last_seen_ts: 100_000 },
        ], unbalance: { sustained: true, max_pct: 25 } },
      ],
      activeBlock: null,
      inSolarWindow: false,
      now: 1_000_000,
    });
    assert.strictEqual(r.kind, "open_block");
    assert.strictEqual(r.pattern.key, "DC_SUBSTRATE_BREACH");
    assert.strictEqual(r.pattern.hex, "0x0240");
    assert.strictEqual(r.latest_episode_ts, 100_000);
  });

  test("decide: synthetic IGBT_HEALTH_EOL alone (rank 2) → open_block", () => {
    // Preventive trigger: no alarm pattern is critical, only the synthetic
    // health signal. Operator wants the inverter blocked BEFORE the alarm
    // pattern fires, so this is the most-common real-world block path.
    const r = decideBlockAction({
      inverter: 7,
      slaves: [
        { slave: 2, patterns: [
          { severity: "ok",       key: "DC_SUBSTRATE_BREACH",     hex: "0x0240", severity_rank: 3, count_in_window: 0, last_seen_ts: 0 },
          { severity: "ok",       key: "DC_FAULT_AC_OVERCURRENT", hex: "0x0210", severity_rank: 1, count_in_window: 0, last_seen_ts: 0 },
          { severity: "critical", key: "IGBT_HEALTH_EOL",         hex: "EOL",    severity_rank: 2, count_in_window: null, last_seen_ts: 999_999, health_score: 78 },
        ], unbalance: { sustained: true, max_pct: 22 } },
      ],
      activeBlock: null,
      inSolarWindow: false,
      now: 1_000_000,
    });
    assert.strictEqual(r.kind, "open_block");
    assert.strictEqual(r.pattern.key, "IGBT_HEALTH_EOL");
    assert.strictEqual(r.triggering_slave, 2);
  });

  test("decide: 0x0240 outranks IGBT_HEALTH_EOL outranks 0x0210", () => {
    // All three critical simultaneously. The catastrophic alarm pattern
    // must still win — EOL is preventive (rank 2), 0x0240 is active mode (3).
    const r = decideBlockAction({
      inverter: 7,
      slaves: [
        { slave: 1, patterns: [
          { severity: "critical", key: "DC_FAULT_AC_OVERCURRENT", hex: "0x0210", severity_rank: 1, count_in_window: 9, last_seen_ts: 999_900 },
          { severity: "critical", key: "IGBT_HEALTH_EOL",         hex: "EOL",    severity_rank: 2, last_seen_ts: 999_950 },
          { severity: "critical", key: "DC_SUBSTRATE_BREACH",     hex: "0x0240", severity_rank: 3, count_in_window: 2, last_seen_ts: 999_000 },
        ], unbalance: { sustained: true, max_pct: 30 } },
      ],
      activeBlock: null,
      inSolarWindow: false,
      now: 1_000_000,
    });
    assert.strictEqual(r.kind, "open_block");
    assert.strictEqual(r.pattern.key, "DC_SUBSTRATE_BREACH");
  });

  test("decide: active block on 0x0210 + IGBT_HEALTH_EOL also critical → promote_block", () => {
    // The lesser AC-OC pattern opened the block; preventive EOL signal
    // becomes critical. EOL (rank 2) > 0x0210 (rank 1) so we promote.
    const r = decideBlockAction({
      inverter: 7,
      slaves: [
        { slave: 1, patterns: [
          { severity: "critical", key: "DC_FAULT_AC_OVERCURRENT", hex: "0x0210", severity_rank: 1, count_in_window: 5, last_seen_ts: 999_900 },
          { severity: "critical", key: "IGBT_HEALTH_EOL",         hex: "EOL",    severity_rank: 2, last_seen_ts: 999_500 },
        ] },
      ],
      activeBlock: {
        id: 20, pattern_key: "DC_FAULT_AC_OVERCURRENT", pattern_hex: "0x0210",
        created_at_ms: 500_000, last_reenforced_ms: 999_500, stop_issued_at_ms: 500_000,
      },
      now: 1_000_000,
    });
    assert.strictEqual(r.kind, "promote_block");
    assert.strictEqual(r.pattern.key, "IGBT_HEALTH_EOL");
  });

  test("decide: only 0x0210 critical, no 0x0240 → 0x0210 wins (lone critical)", () => {
    const r = decideBlockAction({
      inverter: 5,
      slaves: [
        { slave: 2, patterns: [
          { severity: "critical", key: "DC_FAULT_AC_OVERCURRENT", hex: "0x0210", label: "AC OC", severity_rank: 1, count_in_window: 3, last_seen_ts: 500_000 },
          { severity: "ok",       key: "DC_SUBSTRATE_BREACH",     hex: "0x0240", label: "Substrate Breach", severity_rank: 2, count_in_window: 0, last_seen_ts: 0 },
        ], unbalance: { sustained: true, max_pct: 26 } },
      ],
      activeBlock: null,
      inSolarWindow: false,
      now: 1_000_000,
    });
    assert.strictEqual(r.kind, "open_block");
    assert.strictEqual(r.pattern.key, "DC_FAULT_AC_OVERCURRENT");
  });

  test("decide: active block on 0x0210 + 0x0240 newly critical → promote_block", () => {
    // Block was opened on the lesser pattern; the catastrophic one now
    // reaches critical. We must promote so the overlay shows the worse
    // failure mode immediately.
    const r = decideBlockAction({
      inverter: 5,
      slaves: [
        { slave: 1, patterns: [
          { severity: "critical", key: "DC_FAULT_AC_OVERCURRENT", hex: "0x0210", label: "AC OC", severity_rank: 1, count_in_window: 3, last_seen_ts: 900_000 },
          { severity: "critical", key: "DC_SUBSTRATE_BREACH",     hex: "0x0240", label: "Substrate Breach", severity_rank: 2, count_in_window: 2, last_seen_ts: 800_000 },
        ] },
      ],
      activeBlock: {
        id: 12,
        pattern_key: "DC_FAULT_AC_OVERCURRENT",
        pattern_hex: "0x0210",
        created_at_ms:     500_000,
        stop_issued_at_ms: 500_000,
        last_reenforced_ms: 999_000,  // very recent — would normally skip_reenforce
      },
      now: 1_000_000,
    });
    assert.strictEqual(r.kind, "promote_block");
    assert.strictEqual(r.pattern.key, "DC_SUBSTRATE_BREACH");
    assert.strictEqual(r.pattern.hex, "0x0240");
    // The reason field encodes the from→to transition for the audit log.
    assert.match(r.reason, /promoted_DC_FAULT_AC_OVERCURRENT_to_DC_SUBSTRATE_BREACH/);
  });

  test("decide: active block on 0x0240 + 0x0210 also critical → NO promote (already worst)", () => {
    // The active block carries the catastrophic pattern. Even though the
    // lesser pattern is also currently critical, we do NOT demote. This
    // tick falls through to the cooldown check / reenforce.
    const r = decideBlockAction({
      inverter: 5,
      slaves: [
        { slave: 1, patterns: [
          { severity: "critical", key: "DC_SUBSTRATE_BREACH",     hex: "0x0240", label: "Substrate Breach", severity_rank: 2, count_in_window: 3, last_seen_ts: 900_000 },
          { severity: "critical", key: "DC_FAULT_AC_OVERCURRENT", hex: "0x0210", label: "AC OC", severity_rank: 1, count_in_window: 5, last_seen_ts: 950_000 },
        ] },
      ],
      activeBlock: {
        id: 12,
        pattern_key: "DC_SUBSTRATE_BREACH",
        pattern_hex: "0x0240",
        created_at_ms:     500_000,
        stop_issued_at_ms: 500_000,
        last_reenforced_ms: 500_000,  // past cooldown
      },
      now: 1_000_000,
    });
    assert.strictEqual(r.kind, "reenforce");
    assert.strictEqual(r.pattern.key, "DC_SUBSTRATE_BREACH");
  });

  test("decide: critical + active block (recent re-enforce, same pattern) → skip_reenforce", () => {
    const now = 1_000_000;
    const r = decideBlockAction({
      inverter: 3,
      slaves: [
        { slave: 1, patterns: [{ severity: "critical", key: "DC_SUBSTRATE_BREACH", hex: "0x0240", severity_rank: 2, last_seen_ts: now - 1000 }] },
      ],
      activeBlock: {
        id: 7, inverter: 3,
        pattern_key: "DC_SUBSTRATE_BREACH",  // same pattern → no promotion
        pattern_hex: "0x0240",
        created_at_ms: now - 1000,
        last_reenforced_ms: now - 60_000, // 1 min ago — within 5-min cooldown
        stop_issued_at_ms: now - 1000,
      },
      now,
    });
    assert.strictEqual(r.kind, "skip_reenforce");
    assert.strictEqual(r.reason, "cooldown_active");
  });

  test("decide: critical + active block (past cooldown, same pattern) → reenforce", () => {
    const now = 1_000_000;
    const r = decideBlockAction({
      inverter: 3,
      slaves: [
        { slave: 1, patterns: [{ severity: "critical", key: "DC_SUBSTRATE_BREACH", hex: "0x0240", label: "X", severity_rank: 2, count_in_window: 5, last_seen_ts: now - 100 }] },
      ],
      activeBlock: {
        id: 7, inverter: 3,
        pattern_key: "DC_SUBSTRATE_BREACH",  // same pattern as the critical one → no promotion
        pattern_hex: "0x0240",
        created_at_ms: now - 10 * 60_000,
        last_reenforced_ms: now - 10 * 60_000, // 10 min ago — past 5-min cooldown
        stop_issued_at_ms: now - 10 * 60_000,
      },
      now,
    });
    assert.strictEqual(r.kind, "reenforce");
    assert.strictEqual(r.pattern.key, "DC_SUBSTRATE_BREACH");
  });

  test("decide: no critical + active block → noop (waiting on operator ack)", () => {
    const r = decideBlockAction({
      inverter: 3,
      slaves: [
        { slave: 1, patterns: [{ severity: "watch", last_seen_ts: 500 }] },
        { slave: 2, patterns: [{ severity: "ok",    last_seen_ts: 0 }] },
      ],
      activeBlock: { id: 1, inverter: 3, created_at_ms: 1, last_reenforced_ms: 1, stop_issued_at_ms: 1 },
      now: 1000,
    });
    assert.strictEqual(r.kind, "noop");
    assert.strictEqual(r.reason, "block_active_no_new_critical");
  });

  // ── summarizeBlockForApi ───────────────────────────────────────────────
  test("summarizeBlockForApi: null → null", () => {
    assert.strictEqual(summarizeBlockForApi(null), null);
  });

  test("summarizeBlockForApi: active row → is_active true", () => {
    const r = summarizeBlockForApi({
      id: 5, inverter: 7, created_at_ms: 1000,
      pattern_key: "DC_SUBSTRATE_BREACH", pattern_hex: "0x0240",
      acked_at_ms: null,
    });
    assert.strictEqual(r.is_active, true);
    assert.strictEqual(r.inverter, 7);
    assert.strictEqual(r.pattern_hex, "0x0240");
  });

  test("summarizeBlockForApi: acked row → is_active false", () => {
    const r = summarizeBlockForApi({
      id: 5, inverter: 7, created_at_ms: 1000,
      acked_at_ms: 2000, acked_by: "operator-a",
    });
    assert.strictEqual(r.is_active, false);
    assert.strictEqual(r.acked_by, "operator-a");
  });

  // ── enforceOne integration ─────────────────────────────────────────────
  test("enforceOne: critical → opens block, issues STOP to all configured slaves", async () => {
    const calls = { stops: [], blocks: [], reenforce: [], logs: [] };
    const deps = {
      now: () => 1_000_000,
      listSlaves: () => [1, 2, 3, 4],
      loadPatternsForNode: (inv, slave) =>
        slave === 2
          ? [{ severity: "critical", key: "DC_SUBSTRATE_BREACH", hex: "0x0240", label: "X", count_in_window: 3, last_seen_ts: 999_000 }]
          : [{ severity: "ok", key: "DC_SUBSTRATE_BREACH", last_seen_ts: 0 }],
      loadUnbalanceForNode: (inv, slave) =>
        slave === 2 ? { sustained: true, max_pct: 25 } : { sustained: false, max_pct: 0 },
      getActiveBlock: () => null,
      openBlock: (row) => { calls.blocks.push(row); return 42; },
      markReenforced: (id, nowMs, result) => { calls.reenforce.push({ id, nowMs, result }); },
      issueStop: async (inv, slave) => { calls.stops.push({ inv, slave }); return "ok"; },
      logAction: (payload) => { calls.logs.push(payload); },
      stopPerSlaveDelayMs: 0,  // skip the 1500ms settle in tests
    };
    const r = await enforceOne(3, deps);
    assert.strictEqual(r.action.kind, "open_block");
    assert.strictEqual(calls.blocks.length, 1);
    assert.strictEqual(calls.blocks[0].triggering_slave, 2);
    assert.strictEqual(calls.stops.length, 4);
    assert.deepStrictEqual(calls.stops.map((s) => s.slave), [1, 2, 3, 4]);
    assert.strictEqual(calls.reenforce.length, 1);
    assert.strictEqual(calls.reenforce[0].id, 42);
  });

  test("enforceOne: no critical, no active block → noop, no STOP issued", async () => {
    const calls = { stops: [], blocks: [] };
    const deps = {
      now: () => 1_000_000,
      listSlaves: () => [1, 2],
      loadPatternsForNode: () => [{ severity: "ok", key: "DC_SUBSTRATE_BREACH", last_seen_ts: 0 }],
      getActiveBlock: () => null,
      openBlock: (row) => { calls.blocks.push(row); return 1; },
      markReenforced: () => {},
      issueStop: async () => "ok",
    };
    const r = await enforceOne(3, deps);
    assert.strictEqual(r.action.kind, "noop");
    assert.strictEqual(calls.stops.length, 0);
    assert.strictEqual(calls.blocks.length, 0);
  });

  test("enforceOne: promote_block updates pattern in place, no new STOP", async () => {
    const calls = { stops: [], blocks: [], promotes: [], reenforce: [], logs: [] };
    const deps = {
      now: () => 1_000_000,
      listSlaves: () => [1, 2],
      loadPatternsForNode: (inv, slave) =>
        slave === 1
          ? [
              { severity: "critical", key: "DC_FAULT_AC_OVERCURRENT", hex: "0x0210", label: "AC OC", severity_rank: 1, count_in_window: 5, last_seen_ts: 999_500 },
              { severity: "critical", key: "DC_SUBSTRATE_BREACH",     hex: "0x0240", label: "Substrate Breach", severity_rank: 2, count_in_window: 2, last_seen_ts: 998_000 },
            ]
          : [],
      getActiveBlock: () => ({
        id: 77,
        pattern_key: "DC_FAULT_AC_OVERCURRENT",
        pattern_hex: "0x0210",
        created_at_ms:     900_000,
        stop_issued_at_ms: 900_000,
        last_reenforced_ms: 900_000,
        reenforce_count: 0,
      }),
      openBlock: (row) => { calls.blocks.push(row); return 99; },
      promoteBlock: (id, fields, nowMs) => { calls.promotes.push({ id, fields, nowMs }); },
      markReenforced: (id, nowMs, result) => { calls.reenforce.push({ id, nowMs, result }); },
      issueStop: async (inv, slave) => { calls.stops.push({ inv, slave }); return "ok"; },
      logAction: (payload) => { calls.logs.push(payload); },
    };
    const r = await enforceOne(5, deps);
    assert.strictEqual(r.action.kind, "promote_block");
    // Promotion updates the existing row, doesn't open a new one.
    assert.strictEqual(calls.blocks.length, 0);
    assert.strictEqual(calls.promotes.length, 1);
    assert.strictEqual(calls.promotes[0].id, 77);
    assert.strictEqual(calls.promotes[0].fields.pattern_key, "DC_SUBSTRATE_BREACH");
    assert.strictEqual(calls.promotes[0].fields.pattern_hex, "0x0240");
    // No new STOP — the inverter is already stopped from the original block.
    assert.strictEqual(calls.stops.length, 0);
    assert.strictEqual(calls.reenforce.length, 0);
    // Audit log entry carries the transition.
    const promoteLog = calls.logs.find((l) => l.kind === "critical_block_promoted");
    assert.ok(promoteLog, "expected critical_block_promoted log");
    assert.strictEqual(promoteLog.from_pattern_key, "DC_FAULT_AC_OVERCURRENT");
    assert.strictEqual(promoteLog.pattern.key,      "DC_SUBSTRATE_BREACH");
  });

  test("enforceOne: graceful STOP — delay between slaves, NOT before the first", async () => {
    const calls = { stops: [] };
    const deps = {
      now: () => 1_000_000,
      listSlaves: () => [1, 2, 3, 4],
      loadPatternsForNode: () => [
        { severity: "critical", key: "DC_SUBSTRATE_BREACH", hex: "0x0240", label: "X", severity_rank: 3, count_in_window: 2, last_seen_ts: 999_900 },
      ],
      loadUnbalanceForNode: () => ({ sustained: true, max_pct: 25 }),
      getActiveBlock: () => null,
      openBlock: () => 1,
      markReenforced: () => {},
      issueStop: async (inv, slave) => {
        calls.stops.push({ slave, at: Date.now() });
        return "ok";
      },
      // Fast settle so the test doesn't run for 6 seconds.
      stopPerSlaveDelayMs: 25,
    };
    const start = Date.now();
    await enforceOne(3, deps);
    const elapsed = Date.now() - start;
    assert.strictEqual(calls.stops.length, 4);
    // 4 slaves with 25 ms between them = 3 × 25 = 75 ms minimum.
    // Allow some scheduler slack but assert the gap is real.
    assert.ok(elapsed >= 70, `expected ≥70 ms total (3×25), got ${elapsed} ms`);
    // First STOP shouldn't be delayed — block must engage promptly.
    const gap_0_to_1 = calls.stops[1].at - calls.stops[0].at;
    assert.ok(gap_0_to_1 >= 20, `expected ≥20 ms between slave 1 & 2 STOPs, got ${gap_0_to_1} ms`);
  });

  test("enforceOne: stopPerSlaveDelayMs=0 disables graceful spacing (legacy / test mode)", async () => {
    const calls = { stops: [] };
    const deps = {
      now: () => 1_000_000,
      listSlaves: () => [1, 2, 3, 4],
      loadPatternsForNode: () => [
        { severity: "critical", key: "DC_SUBSTRATE_BREACH", hex: "0x0240", label: "X", severity_rank: 3, count_in_window: 2, last_seen_ts: 999_900 },
      ],
      loadUnbalanceForNode: () => ({ sustained: true, max_pct: 25 }),
      getActiveBlock: () => null,
      openBlock: () => 1,
      markReenforced: () => {},
      issueStop: async (_inv, slave) => { calls.stops.push(slave); return "ok"; },
      stopPerSlaveDelayMs: 0,
    };
    const start = Date.now();
    await enforceOne(3, deps);
    const elapsed = Date.now() - start;
    assert.strictEqual(calls.stops.length, 4);
    // With no delay, the loop should run fast (< 100 ms, plenty of slack).
    assert.ok(elapsed < 100, `expected < 100 ms with no delay, got ${elapsed} ms`);
  });

  test("enforceOne: STOP failure doesn't suppress the block row", async () => {
    const calls = { blocks: [], stops: [] };
    const deps = {
      now: () => 1_000_000,
      listSlaves: () => [1],
      loadPatternsForNode: () => [{ severity: "critical", key: "DC_SUBSTRATE_BREACH", hex: "0x0240", label: "X", count_in_window: 2, last_seen_ts: 999_000 }],
      loadUnbalanceForNode: () => ({ sustained: true, max_pct: 25 }),
      getActiveBlock: () => null,
      openBlock: (row) => { calls.blocks.push(row); return 99; },
      markReenforced: () => {},
      issueStop: async () => { throw new Error("modbus timeout"); },
      stopPerSlaveDelayMs: 0,
    };
    const r = await enforceOne(3, deps);
    assert.strictEqual(r.action.kind, "open_block");
    assert.strictEqual(calls.blocks.length, 1);
    assert.match(r.stopResult, /err:modbus timeout/);
  });

  // ── Slice κ.8 — phase-unbalance gate ───────────────────────────────────

  test("decide: critical pattern + sustained unbalance → open_block (gate passes)", () => {
    const r = decideBlockAction({
      inverter: 7,
      slaves: [
        {
          slave: 1,
          patterns: [{ severity: "critical", key: "DC_SUBSTRATE_BREACH", hex: "0x0240", label: "X", severity_rank: 4, count_in_window: 3, last_seen_ts: 999_000 }],
          unbalance: { sustained: true, max_pct: 28.5 },
        },
      ],
      activeBlock: null,
      now: 1_000_000,
    });
    assert.strictEqual(r.kind, "open_block");
    assert.strictEqual(r.reason, "recurring_critical_pattern_with_unbalance");
    assert.strictEqual(r.unbalance.sustained, true);
    assert.strictEqual(r.unbalance.max_pct, 28.5);
  });

  test("decide: critical pattern + NO sustained unbalance → gated_pending_unbalance (no STOP)", () => {
    const r = decideBlockAction({
      inverter: 7,
      slaves: [
        {
          slave: 1,
          patterns: [{ severity: "critical", key: "DC_SUBSTRATE_BREACH", hex: "0x0240", label: "X", severity_rank: 4, count_in_window: 3, last_seen_ts: 999_000 }],
          unbalance: { sustained: false, max_pct: 8.0 },
        },
      ],
      activeBlock: null,
      now: 1_000_000,
    });
    assert.strictEqual(r.kind, "gated_pending_unbalance");
    assert.strictEqual(r.reason, "critical_pattern_without_sustained_unbalance");
    assert.strictEqual(r.unbalance.sustained, false);
    assert.strictEqual(r.pattern.key, "DC_SUBSTRATE_BREACH");
  });

  test("decide: gate is per-slave — pattern on slave 1 with unbalance on slave 2 does NOT open", () => {
    // Slave 1 has the critical alarm pattern; slave 2 has the sustained
    // unbalance. The gate requires both signals on the SAME leg (the
    // physical reason the unbalance check exists at all).
    const r = decideBlockAction({
      inverter: 7,
      slaves: [
        {
          slave: 1,
          patterns: [{ severity: "critical", key: "DC_SUBSTRATE_BREACH", hex: "0x0240", label: "X", severity_rank: 4, count_in_window: 3, last_seen_ts: 999_000 }],
          unbalance: { sustained: false, max_pct: 5 },
        },
        {
          slave: 2,
          patterns: [{ severity: "ok", key: "DC_SUBSTRATE_BREACH", hex: "0x0240", severity_rank: 4, count_in_window: 0, last_seen_ts: 0 }],
          unbalance: { sustained: true, max_pct: 30 },
        },
      ],
      activeBlock: null,
      now: 1_000_000,
    });
    assert.strictEqual(r.kind, "gated_pending_unbalance");
    assert.strictEqual(r.triggering_slave, 1, "gate evaluates per-slave");
  });

  test("decide: no unbalance field on any slave → gated (mandatory gate, NO legacy fallback)", () => {
    // 2.2 — the pre-Slice-κ.8 "no unbalance data ⇒ open" fallback is REMOVED.
    // Phase-current imbalance is now mandatory: a critical pattern with no
    // sustained imbalance evidence must NEVER auto-block.
    const r = decideBlockAction({
      inverter: 7,
      slaves: [
        { slave: 1, patterns: [{ severity: "critical", key: "DC_SUBSTRATE_BREACH", hex: "0x0240", label: "X", severity_rank: 4, count_in_window: 3, last_seen_ts: 999_000 }] },
      ],
      activeBlock: null,
      inSolarWindow: false,
      now: 1_000_000,
    });
    assert.strictEqual(r.kind, "gated_pending_unbalance",
      "no unbalance verdict anywhere → block must NOT open (mandatory gate)");
  });

  // ── Slice κ.9 — "detect during solar, STOP after" deferral ─────────────

  test("decide: critical + sustained unbalance + IN solar window → arm_pending (defer STOP)", () => {
    const r = decideBlockAction({
      inverter: 9,
      slaves: [
        {
          slave: 1,
          patterns: [{ severity: "critical", key: "DC_SUBSTRATE_BREACH", hex: "0x0240", label: "X", severity_rank: 4, count_in_window: 3, last_seen_ts: 999_000 }],
          unbalance: { sustained: true, max_pct: 31 },
        },
      ],
      activeBlock: null,
      pendingBlock: null,
      inSolarWindow: true,
      now: 1_000_000,
    });
    assert.strictEqual(r.kind, "arm_pending");
    assert.strictEqual(r.unbalance.sustained, true);
    assert.strictEqual(r.pattern.key, "DC_SUBSTRATE_BREACH");
  });

  test("decide: armed pending + solar window CLOSED + still critical → open_block (deferred)", () => {
    const r = decideBlockAction({
      inverter: 9,
      slaves: [
        {
          slave: 1,
          // Out of solar the live unbalance read is structurally not sustained
          // (rejected by the solar gate) — the latched evidence is trusted.
          patterns: [{ severity: "critical", key: "DC_SUBSTRATE_BREACH", hex: "0x0240", label: "X", severity_rank: 4, count_in_window: 4, last_seen_ts: 999_500 }],
          unbalance: { sustained: false, max_pct: 0 },
        },
      ],
      activeBlock: null,
      pendingBlock: { id: 55, unbalance_latched: { sustained: true, max_pct: 31 } },
      inSolarWindow: false,
      now: 1_000_000,
    });
    assert.strictEqual(r.kind, "open_block");
    assert.strictEqual(r.reason, "deferred_after_solar");
    assert.strictEqual(r.from_pending, true);
    assert.strictEqual(r.unbalance.sustained, true, "uses latched in-solar evidence");
  });

  test("decide: armed pending + pattern resolved before solar close → disarm_pending", () => {
    const r = decideBlockAction({
      inverter: 9,
      slaves: [
        { slave: 1, patterns: [{ severity: "ok", key: "DC_SUBSTRATE_BREACH", hex: "0x0240", last_seen_ts: 0 }] },
      ],
      activeBlock: null,
      pendingBlock: { id: 55, unbalance_latched: { sustained: true, max_pct: 31 } },
      inSolarWindow: true,
      now: 1_000_000,
    });
    assert.strictEqual(r.kind, "disarm_pending");
    assert.strictEqual(r.reason, "pattern_resolved_before_stop");
  });

  test("enforceOne: arm_pending arms a deferred row — NO STOP, NO openBlock", async () => {
    const calls = { stops: [], blocks: [], armed: [], logs: [] };
    const deps = {
      now: () => 1_000_000,
      listSlaves: () => [1, 2],
      loadPatternsForNode: (inv, slave) =>
        slave === 1
          ? [{ severity: "critical", key: "DC_SUBSTRATE_BREACH", hex: "0x0240", label: "X", severity_rank: 4, count_in_window: 3, last_seen_ts: 999_000 }]
          : [{ severity: "ok", key: "DC_SUBSTRATE_BREACH", last_seen_ts: 0 }],
      loadUnbalanceForNode: (inv, slave) =>
        slave === 1 ? { sustained: true, max_pct: 29 } : { sustained: false, max_pct: 0 },
      getActiveBlock: () => null,
      getPendingBlock: () => null,
      inSolarWindow: true,
      armPending: (row) => { calls.armed.push(row); return 70; },
      openBlock: (row) => { calls.blocks.push(row); return 1; },
      markReenforced: () => {},
      issueStop: async (inv, slave) => { calls.stops.push({ inv, slave }); return "ok"; },
      logAction: (p) => calls.logs.push(p),
      stopPerSlaveDelayMs: 0,
    };
    const r = await enforceOne(9, deps);
    assert.strictEqual(r.action.kind, "arm_pending");
    assert.strictEqual(calls.armed.length, 1, "must arm a pending row");
    assert.strictEqual(calls.armed[0].triggering_slave, 1);
    assert.strictEqual(calls.blocks.length, 0, "must NOT open an active block");
    assert.strictEqual(calls.stops.length, 0, "must NOT issue STOP during solar");
    assert.ok(calls.logs.find((l) => l.kind === "critical_block_armed_pending"));
  });

  test("enforceOne: deferred conversion after solar — activates pending + issues STOP", async () => {
    const calls = { stops: [], activated: [], blocks: [], reenf: [] };
    const deps = {
      now: () => 2_000_000,
      listSlaves: () => [1, 2],
      loadPatternsForNode: () => [{ severity: "critical", key: "DC_SUBSTRATE_BREACH", hex: "0x0240", label: "X", severity_rank: 4, count_in_window: 4, last_seen_ts: 1_999_000 }],
      loadUnbalanceForNode: () => ({ sustained: false, max_pct: 0 }), // post-solar: not live-sustained
      getActiveBlock: () => null,
      getPendingBlock: () => ({ id: 88, unbalance_latched: { sustained: true, max_pct: 33 } }),
      inSolarWindow: false,
      activatePending: (id) => { calls.activated.push(id); },
      openBlock: (row) => { calls.blocks.push(row); return 999; },
      markReenforced: (id, n, r2) => { calls.reenf.push({ id, r2 }); },
      issueStop: async (inv, slave) => { calls.stops.push(slave); return "ok"; },
      logAction: () => {},
      stopPerSlaveDelayMs: 0,
    };
    const r = await enforceOne(9, deps);
    assert.strictEqual(r.action.kind, "open_block");
    assert.strictEqual(r.action.reason, "deferred_after_solar");
    assert.strictEqual(calls.activated.length, 1, "converts the armed row in place");
    assert.strictEqual(calls.activated[0], 88);
    assert.strictEqual(calls.blocks.length, 0, "must NOT insert a second row");
    assert.strictEqual(calls.stops.length, 2, "STOP issued to all slaves after solar");
    assert.strictEqual(r.blockId, 88, "block id stays stable for the operator");
  });

  test("enforceOne: disarm_pending drops the armed row, NO STOP", async () => {
    const calls = { stops: [], disarmed: [], logs: [] };
    const deps = {
      now: () => 2_000_000,
      listSlaves: () => [1],
      loadPatternsForNode: () => [{ severity: "ok", key: "DC_SUBSTRATE_BREACH", hex: "0x0240", last_seen_ts: 0 }],
      loadUnbalanceForNode: () => ({ sustained: false, max_pct: 0 }),
      getActiveBlock: () => null,
      getPendingBlock: () => ({ id: 91 }),
      inSolarWindow: true,
      disarmPending: (inv, reason) => { calls.disarmed.push({ inv, reason }); },
      openBlock: () => 1,
      markReenforced: () => {},
      issueStop: async () => { calls.stops.push(1); return "ok"; },
      logAction: (p) => calls.logs.push(p),
      stopPerSlaveDelayMs: 0,
    };
    const r = await enforceOne(9, deps);
    assert.strictEqual(r.action.kind, "disarm_pending");
    assert.strictEqual(calls.disarmed.length, 1);
    assert.strictEqual(calls.stops.length, 0, "resolved pattern → no STOP ever");
    assert.ok(calls.logs.find((l) => l.kind === "critical_block_disarmed"));
  });

  await test("enforceOne: gated_pending_unbalance emits audit log but no STOP", async () => {
    const calls = { stops: [], blocks: [], audits: [] };
    const deps = {
      now: () => 1_000_000,
      listSlaves: () => [1],
      loadPatternsForNode: () => [{
        severity: "critical", key: "DC_SUBSTRATE_BREACH", hex: "0x0240",
        label: "X", severity_rank: 4, count_in_window: 3, last_seen_ts: 999_000,
      }],
      loadUnbalanceForNode: () => ({ sustained: false, max_pct: 6.0 }),
      getActiveBlock: () => null,
      openBlock: (row) => { calls.blocks.push(row); return 999; },
      markReenforced: () => {},
      issueStop: async (inv, slave) => { calls.stops.push({ inv, slave }); return "ok"; },
      logAction: (p) => calls.audits.push(p),
      stopPerSlaveDelayMs: 0,
    };
    const r = await enforceOne(7, deps);
    assert.strictEqual(r.action.kind, "gated_pending_unbalance");
    assert.strictEqual(calls.blocks.length, 0, "must NOT open block");
    assert.strictEqual(calls.stops.length, 0, "must NOT issue STOP");
    assert.strictEqual(calls.audits.length, 1, "must emit one audit row");
    assert.strictEqual(calls.audits[0].kind, "critical_block_gated_pending_unbalance");
  });

  console.log("\n──────────────────────────────────────────────────────────");
  console.log("  criticalPatternEnforcerCore.test.js complete\n");
}

run();
