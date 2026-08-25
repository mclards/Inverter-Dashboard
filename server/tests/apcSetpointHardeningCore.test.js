"use strict";

/**
 * Hardening tests for the %P Setpoint apply path (v2.11.0).
 *
 * Pure-function exercise of:
 *   - target shape validation (extracted from server/index.js)
 *   - in-flight dedup window
 *   - per-target audit shape (against an in-memory better-sqlite3-style stub)
 */

const assert = require("assert");

// Mirror of _validateApcTargets from server/index.js. Kept here so the test
// is independent of the giant index.js module and runs without ABI deps.
function validateApcTargets(targets, scope) {
  if (scope === "plant") return { ok: true, normalized: [] };
  if (!Array.isArray(targets) || targets.length === 0) {
    return { ok: false, error: "targets array is required for scope=node|inverter" };
  }
  const normalized = [];
  const seen = new Set();
  for (const t of targets) {
    const ip = String(t?.ip || "").trim();
    const slave = Number(t?.slave);
    if (!ip) return { ok: false, error: `target missing ip: ${JSON.stringify(t)}` };
    if (!/^[0-9]{1,3}(\.[0-9]{1,3}){3}$/.test(ip)) {
      return { ok: false, error: `target ip is not a valid IPv4 address: ${ip}` };
    }
    if (!Number.isFinite(slave) || slave < 1 || slave > 4) {
      return { ok: false, error: `target slave must be 1–4, got: ${t?.slave}` };
    }
    const key = `${ip}:${slave}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ ip, slave });
  }
  if (normalized.length === 0) {
    return { ok: false, error: "no valid targets after normalization" };
  }
  return { ok: true, normalized };
}

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}

console.log("\n  apcSetpointHardeningCore.test.js — %P Setpoint hardening\n");

/* ── Target validation ─────────────────────────────────────────────────── */

test("plant scope: empty targets array is OK (engine fans out)", () => {
  const r = validateApcTargets([], "plant");
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.normalized, []);
});

test("node scope: empty targets array is rejected", () => {
  const r = validateApcTargets([], "node");
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /targets array is required/);
});

test("node scope: missing ip is rejected", () => {
  const r = validateApcTargets([{ slave: 1 }], "node");
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /missing ip/);
});

test("node scope: malformed ip is rejected", () => {
  for (const ip of ["abc", "1.2.3", "1.2.3.4.5", "999.999.999.999.x"]) {
    const r = validateApcTargets([{ ip, slave: 1 }], "node");
    assert.strictEqual(r.ok, false, `expected fail for ip=${ip}`);
    assert.match(r.error, /not a valid IPv4/i);
  }
});

test("node scope: slave must be 1..4", () => {
  for (const slave of [0, 5, -1, 10, "abc"]) {
    const r = validateApcTargets([{ ip: "1.2.3.4", slave }], "node");
    assert.strictEqual(r.ok, false, `expected fail for slave=${slave}`);
    assert.match(r.error, /slave must be 1–4/);
  }
});

test("node scope: valid single target normalizes", () => {
  const r = validateApcTargets([{ ip: "192.168.1.10", slave: 2 }], "node");
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.normalized, [{ ip: "192.168.1.10", slave: 2 }]);
});

test("multiple identical targets dedupe to one", () => {
  const r = validateApcTargets([
    { ip: "10.0.0.1", slave: 1 },
    { ip: "10.0.0.1", slave: 1 },
    { ip: "10.0.0.1", slave: 1 },
  ], "node");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.normalized.length, 1);
});

test("mixed valid + invalid: first invalid wins, no partial pass", () => {
  const r = validateApcTargets([
    { ip: "10.0.0.1", slave: 1 },
    { ip: "10.0.0.2", slave: 99 }, // invalid
    { ip: "10.0.0.3", slave: 2 },
  ], "node");
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /slave/);
});

test("ipv4 trims whitespace then validates", () => {
  const r = validateApcTargets([{ ip: "  192.168.1.10  ", slave: 3 }], "node");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.normalized[0].ip, "192.168.1.10");
});

/* ── In-flight dedup window ────────────────────────────────────────────── */

function makeDedupGuard(windowMs) {
  const store = new Map();
  return (ip, slave, opcode, now) => {
    const key = `${ip}:${slave}:${opcode}`;
    const last = store.get(key);
    if (last && (now - last) < windowMs) return false; // duplicate
    store.set(key, now);
    return true;
  };
}

test("dedup: two rapid identical writes are rejected", () => {
  const guard = makeDedupGuard(1500);
  const t = 100_000;
  assert.strictEqual(guard("1.1.1.1", 1, "set", t), true);
  assert.strictEqual(guard("1.1.1.1", 1, "set", t + 500), false);
});

test("dedup: writes outside window are accepted", () => {
  const guard = makeDedupGuard(1500);
  const t = 100_000;
  assert.strictEqual(guard("1.1.1.1", 1, "set", t), true);
  assert.strictEqual(guard("1.1.1.1", 1, "set", t + 2000), true);
});

test("dedup: different opcodes on same node are independent", () => {
  const guard = makeDedupGuard(1500);
  const t = 100_000;
  assert.strictEqual(guard("1.1.1.1", 1, "set",  t), true);
  assert.strictEqual(guard("1.1.1.1", 1, "stop", t + 500), true); // different opcode
});

test("dedup: different nodes are independent", () => {
  const guard = makeDedupGuard(1500);
  const t = 100_000;
  assert.strictEqual(guard("1.1.1.1", 1, "set", t), true);
  assert.strictEqual(guard("1.1.1.1", 2, "set", t + 500), true);
  assert.strictEqual(guard("1.1.1.2", 1, "set", t + 500), true);
});

/* ── Per-target audit shape ─────────────────────────────────────────────── */

function makeAuditStub() {
  const rows = [];
  const stmt = { run: (...args) => rows.push(args) };
  const txnFns = [];
  const db = {
    prepare: () => stmt,
    transaction: (fn) => () => { txnFns.push(fn); fn(); },
  };
  return { db, rows, txnFns };
}

// Mirror of the per-target audit logic in plantCapController.applySetpoint.
function emitAuditRows(db, { ts, operator, scope, targets, opcode, target_pct, result }) {
  const actionLabel = opcode === "stop" ? "plantCap.setpoint.stop"
    : opcode === "start" ? "plantCap.setpoint.start"
    : opcode === "abort" ? "plantCap.setpoint.abort"
    : "plantCap.setpoint.set";
  const baseScope = `apc:${scope}`;
  const resultLabel = result?.ok ? "queued" : "failed";
  const reasonBase = opcode === "set"
    ? `to=${target_pct} job=${result?.job_id || ""}`
    : `op=${opcode} job=${result?.job_id || ""}`;
  const stmt = db.prepare("INSERT INTO audit_log(ts, operator, inverter, node, action, scope, result, ip, reason) VALUES (?,?,?,?,?,?,?,?,?)");
  const txn = db.transaction(() => {
    if (scope === "plant" || !Array.isArray(targets) || targets.length === 0) {
      stmt.run(ts, operator, 0, 0, actionLabel, baseScope, resultLabel, "", reasonBase);
    } else {
      for (const t of targets) {
        stmt.run(ts, operator, 0, Number(t?.slave ?? 0), actionLabel, baseScope, resultLabel, String(t?.ip || ""), reasonBase);
      }
    }
  });
  txn();
}

test("audit: plant scope produces single summary row with empty ip", () => {
  const { db, rows } = makeAuditStub();
  emitAuditRows(db, { ts: 1, operator: "op", scope: "plant", targets: [], opcode: "set", target_pct: 80, result: { ok: true, job_id: "J1" } });
  assert.strictEqual(rows.length, 1);
  const [, , , slave, action, scope, result, ip] = rows[0];
  assert.strictEqual(slave, 0);
  assert.strictEqual(action, "plantCap.setpoint.set");
  assert.strictEqual(scope, "apc:plant");
  assert.strictEqual(result, "queued");
  assert.strictEqual(ip, "");
});

test("audit: node scope with one target → one row with ip+slave", () => {
  const { db, rows } = makeAuditStub();
  emitAuditRows(db, { ts: 1, operator: "op", scope: "node", targets: [{ ip: "10.0.0.1", slave: 2 }], opcode: "set", target_pct: 50, result: { ok: true, job_id: "J1" } });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0][3], 2);            // node = slave
  assert.strictEqual(rows[0][7], "10.0.0.1");   // ip
});

test("audit: inverter scope with 4 targets → 4 rows, each with own slave", () => {
  const { db, rows } = makeAuditStub();
  const targets = [1, 2, 3, 4].map(s => ({ ip: "10.0.0.5", slave: s }));
  emitAuditRows(db, { ts: 1, operator: "op", scope: "inverter", targets, opcode: "set", target_pct: 75, result: { ok: true, job_id: "J2" } });
  assert.strictEqual(rows.length, 4);
  assert.deepStrictEqual(rows.map(r => r[3]), [1, 2, 3, 4]);
  assert.ok(rows.every(r => r[7] === "10.0.0.5"));
});

test("audit: failed result writes 'failed' label", () => {
  const { db, rows } = makeAuditStub();
  emitAuditRows(db, { ts: 1, operator: "op", scope: "node", targets: [{ ip: "1.1.1.1", slave: 1 }], opcode: "set", target_pct: 50, result: { ok: false } });
  assert.strictEqual(rows[0][6], "failed");
});

test("audit: stop opcode produces 'plantCap.setpoint.stop' action label", () => {
  const { db, rows } = makeAuditStub();
  emitAuditRows(db, { ts: 1, operator: "op", scope: "node", targets: [{ ip: "1.1.1.1", slave: 1 }], opcode: "stop", result: { ok: true, job_id: "X" } });
  assert.strictEqual(rows[0][4], "plantCap.setpoint.stop");
  assert.match(rows[0][8], /op=stop/);
});

test("audit: abort opcode produces 'plantCap.setpoint.abort' action label", () => {
  const { db, rows } = makeAuditStub();
  emitAuditRows(db, { ts: 1, operator: "op", scope: "node", targets: [{ ip: "1.1.1.1", slave: 1 }], opcode: "abort", result: { ok: true, job_id: "X" } });
  assert.strictEqual(rows[0][4], "plantCap.setpoint.abort");
});
