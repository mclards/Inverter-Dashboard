"use strict";

/**
 * Topology auth lease — server/index.js requireTopologyAuth.
 *
 * Locks the contract that:
 *   • The first valid `adsiM` / `adsiMM` (current minute ±1) starts a
 *     60-min rolling lease keyed by the exact key string.
 *   • Subsequent requests with the SAME key string succeed even after
 *     the time window has rolled past (this is the bug-fix for the
 *     "Topology key rejected. Click Start again to re-enter." prompt
 *     that fired every ~2 minutes before).
 *   • Each successful validation re-stamps the lease (rolling window).
 *   • Expired leases are evicted, after which a stale key without
 *     a current-window match is rejected again.
 *
 * Implementation lives inline in server/index.js — to keep the test
 * lightweight and avoid spinning the whole Express app, we import the
 * function directly via Node's vm.runInThisContext after extracting the
 * relevant block. That's fragile, so instead we build a minimal Express
 * shim and re-construct the lease semantics inline via a tiny helper
 * that mirrors the production code (kept in lock-step intentionally —
 * if you change the production lease behaviour, update this fixture).
 *
 * Pure-JS, no real HTTP, no DB.
 */

const assert = require("assert");

const TOPOLOGY_AUTH_LEASE_MS = 60 * 60 * 1000;
const TOPOLOGY_AUTH_FAIL_LIMIT = 5;
const TOPOLOGY_AUTH_WINDOW_MS = 60_000;

// Reconstruct the production lease logic — keep this byte-equivalent
// to server/index.js requireTopologyAuth lease check.
function makeAuthChecker() {
  const failures = new Map();
  const leases = new Map();
  function leaseCleanup(now) {
    for (const [k, v] of leases) {
      if (Number(v?.expiresAt || 0) <= now) leases.delete(k);
    }
  }
  return function check(rawKey, ip, nowMs) {
    const key = String(rawKey || "").trim().toLowerCase();
    const now = nowMs;
    const failEntry = failures.get(ip);
    if (failEntry && now - failEntry.windowStart < TOPOLOGY_AUTH_WINDOW_MS &&
        failEntry.count >= TOPOLOGY_AUTH_FAIL_LIMIT) {
      return { status: 429 };
    }
    function recordFail() {
      const entry = failures.get(ip);
      if (!entry || now - entry.windowStart >= TOPOLOGY_AUTH_WINDOW_MS) {
        failures.set(ip, { count: 1, windowStart: now });
      } else {
        entry.count += 1;
      }
    }
    if (!key) { recordFail(); return { status: 401 }; }
    leaseCleanup(now);
    const m = new Date(now).getMinutes();
    const valid = new Set([
      `adsi${m}`, `adsi${String(m).padStart(2, "0")}`,
      `adsi${(m + 59) % 60}`, `adsi${String((m + 59) % 60).padStart(2, "0")}`,
      `adsi${(m + 1) % 60}`, `adsi${String((m + 1) % 60).padStart(2, "0")}`,
    ]);
    const lease = leases.get(key);
    const leaseOk = lease && Number(lease.expiresAt || 0) > now;
    if (leaseOk || valid.has(key)) {
      leases.set(key, { issuedAt: now, expiresAt: now + TOPOLOGY_AUTH_LEASE_MS });
      failures.delete(ip);
      return { status: 200 };
    }
    recordFail();
    return { status: 403 };
  };
}

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error(err.stack || err);
    process.exitCode = 1;
  }
}

function run() {
  test("rejects empty key with 401", () => {
    const c = makeAuthChecker();
    const r = c("", "1.2.3.4", Date.parse("2026-05-13T12:30:00Z"));
    assert.strictEqual(r.status, 401);
  });

  test("accepts current-minute key (padded)", () => {
    const c = makeAuthChecker();
    const t = Date.parse("2026-05-13T12:30:15Z"); // minute 30
    const r = c("adsi30", "1.1.1.1", t);
    assert.strictEqual(r.status, 200);
  });

  test("accepts current-minute key (unpadded variant)", () => {
    const c = makeAuthChecker();
    const t = Date.parse("2026-05-13T12:05:00Z"); // minute 5
    assert.strictEqual(c("adsi5", "1.1.1.1", t).status, 200);
    // Reset so failure budget doesn't leak.
    const c2 = makeAuthChecker();
    assert.strictEqual(c2("adsi05", "1.1.1.1", t).status, 200);
  });

  test("accepts previous minute (current ±1 window)", () => {
    const c = makeAuthChecker();
    const t = Date.parse("2026-05-13T12:30:15Z");
    assert.strictEqual(c("adsi29", "1.1.1.1", t).status, 200);
  });

  test("accepts next minute (current ±1 window — gateway-clock-lag tolerance)", () => {
    const c = makeAuthChecker();
    const t = Date.parse("2026-05-13T12:30:15Z"); // minute 30
    assert.strictEqual(c("adsi31", "1.1.1.1", t).status, 200);
  });

  test("rejects two-minute-stale key WITHOUT lease (the original bug)", () => {
    const c = makeAuthChecker();
    const t0 = Date.parse("2026-05-13T12:30:15Z");
    const t1 = Date.parse("2026-05-13T12:33:15Z"); // 3 minutes later
    // adsi30 was valid at t0 but never used → no lease at t1.
    const r = c("adsi30", "1.1.1.1", t1);
    assert.strictEqual(r.status, 403);
  });

  test("LEASE: key validated at t0 still works at t0 + 5 min (the fix)", () => {
    const c = makeAuthChecker();
    const t0 = Date.parse("2026-05-13T12:30:15Z");
    const t5 = Date.parse("2026-05-13T12:35:15Z");
    assert.strictEqual(c("adsi30", "1.1.1.1", t0).status, 200, "t0 must accept");
    // 5 minutes later — outside time window but lease is active.
    assert.strictEqual(c("adsi30", "1.1.1.1", t5).status, 200, "t5 must accept via lease");
  });

  test("LEASE: still valid at t0 + 59 min (just inside 60-min lease)", () => {
    const c = makeAuthChecker();
    const t0 = Date.parse("2026-05-13T12:30:15Z");
    assert.strictEqual(c("adsi30", "1.1.1.1", t0).status, 200);
    const t59 = t0 + 59 * 60 * 1000;
    assert.strictEqual(c("adsi30", "1.1.1.1", t59).status, 200);
  });

  test("LEASE: rolling — re-stamped on every successful validation", () => {
    const c = makeAuthChecker();
    const t0 = Date.parse("2026-05-13T12:30:15Z");
    assert.strictEqual(c("adsi30", "1.1.1.1", t0).status, 200);
    // Tick at 30 min — this re-stamps the lease for another 60 min.
    const t30 = t0 + 30 * 60 * 1000;
    assert.strictEqual(c("adsi30", "1.1.1.1", t30).status, 200);
    // 80 min after t0 = 50 min after t30 → still inside the rolling lease.
    const t80 = t0 + 80 * 60 * 1000;
    assert.strictEqual(c("adsi30", "1.1.1.1", t80).status, 200);
  });

  test("LEASE: expires after 60 min of non-use → key rejected if outside time window", () => {
    const c = makeAuthChecker();
    const t0 = Date.parse("2026-05-13T12:30:15Z");
    assert.strictEqual(c("adsi30", "1.1.1.1", t0).status, 200);
    // Skip ahead 65 min — no traffic so lease expires.
    const t65 = t0 + 65 * 60 * 1000;
    // adsi30 is no longer in the current ±1 window AND lease evicted.
    assert.strictEqual(c("adsi30", "1.1.1.1", t65).status, 403);
  });

  test("LEASE is keyed per key-string (sibling key needs its own validation)", () => {
    const c = makeAuthChecker();
    const t0 = Date.parse("2026-05-13T12:30:15Z");
    assert.strictEqual(c("adsi30", "1.1.1.1", t0).status, 200);
    // adsi29 has its own time-window membership (prev minute) — accepted
    // independently and starts its own lease.
    assert.strictEqual(c("adsi29", "1.1.1.1", t0).status, 200);
    // adsi15 is neither current nor prev → no lease yet → reject.
    assert.strictEqual(c("adsi15", "1.1.1.1", t0).status, 403);
  });

  test("rate limit: 5+ failures from same IP in 60s → 429", () => {
    const c = makeAuthChecker();
    const t = Date.parse("2026-05-13T12:30:15Z");
    for (let i = 0; i < 5; i++) {
      assert.strictEqual(c("adsi99", "evil.host", t + i).status, 403);
    }
    // 6th attempt → throttled.
    assert.strictEqual(c("adsi99", "evil.host", t + 6).status, 429);
  });

  console.log("topologyAuthLease.test.js: done");
}

run();
