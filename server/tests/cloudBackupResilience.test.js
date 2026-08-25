"use strict";

// BR-T1 (audit 2026-05-28 §3) — cloud-backup resilience primitives:
//   * _isTransientUploadError  — transient-vs-permanent classification (BR-M1)
//   * _retryWithBackoff        — retry count + non-transient short-circuit (BR-M1)
//   * _withBackupMutex         — strict serialisation, no overlap (BR-M2)
//
// These are exercised against the prototype with a stub `this` so the test
// stays fast and needs neither a DB nor live cloud credentials.

const assert = require("assert");
const CloudBackupService = require("../cloudBackup");
const proto = CloudBackupService.prototype;

async function run() {
  // ── _isTransientUploadError classification ──────────────────────────────
  const isTransient = (e) => proto._isTransientUploadError.call({}, e);

  // Transient: network errno codes
  for (const code of ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "EPIPE", "ENOTFOUND"]) {
    assert.equal(isTransient({ code }), true, `${code} should be transient`);
  }
  // Transient: rate-limit + 5xx by status
  assert.equal(isTransient({ status: 429 }), true, "429 transient");
  assert.equal(isTransient({ statusCode: 503 }), true, "503 transient");
  assert.equal(isTransient({ status: 502 }), true, "502 transient");
  // Transient: by message text / abort / timeout
  assert.equal(isTransient(new Error("OneDrive chunk upload failed: 503")), true, "503 in msg transient");
  assert.equal(isTransient({ name: "AbortError" }), true, "AbortError transient");
  assert.equal(isTransient(new Error("socket hang up")), true, "socket hang up transient");
  assert.equal(isTransient(new Error("network timeout")), true, "timeout transient");
  // NOT transient: auth/permission/4xx (other than 429) and unknown
  assert.equal(isTransient({ status: 403 }), false, "403 not transient");
  assert.equal(isTransient(new Error("Backup manifest missing or corrupted")), false, "manifest error not transient");
  assert.equal(isTransient(null), false, "null not transient");

  // ── _retryWithBackoff — succeeds after transient failures ───────────────
  {
    const ctx = { _isTransientUploadError: proto._isTransientUploadError };
    let calls = 0;
    const result = await proto._retryWithBackoff.call(ctx, "test-upload", async () => {
      calls++;
      if (calls < 3) {
        const e = new Error("temporary 503 from provider");
        throw e;
      }
      return "done";
    });
    assert.equal(result, "done", "should eventually succeed");
    assert.equal(calls, 3, "should have called fn 3 times (2 retries)");
    assert.equal(ctx._lastRetryCount, 2, "_lastRetryCount should record 2 retries");
  }

  // ── _retryWithBackoff — non-transient error throws immediately ──────────
  {
    const ctx = { _isTransientUploadError: proto._isTransientUploadError };
    let calls = 0;
    await assert.rejects(
      proto._retryWithBackoff.call(ctx, "test-upload", async () => {
        calls++;
        throw new Error("403 Forbidden — bad credentials");
      }),
      /403/,
      "non-transient error should propagate",
    );
    assert.equal(calls, 1, "non-transient error must NOT be retried");
    assert.equal(ctx._lastRetryCount, 0, "no retries recorded for non-transient");
  }

  // ── _retryWithBackoff — exhausts retries then throws ────────────────────
  {
    const ctx = { _isTransientUploadError: proto._isTransientUploadError };
    let calls = 0;
    await assert.rejects(
      proto._retryWithBackoff.call(ctx, "test-upload", async () => {
        calls++;
        const e = new Error("read ECONNRESET");
        e.code = "ECONNRESET"; // real network errors carry .code, not just message text
        throw e;
      }),
      /ECONNRESET/,
      "should throw after exhausting retries",
    );
    // UPLOAD_RETRY_MAX = 3 → 1 initial + 3 retries = 4 attempts
    assert.equal(calls, 4, "should attempt 1 + UPLOAD_RETRY_MAX(3) times");
  }

  // ── _withBackupMutex — strict serialisation (no overlap) ────────────────
  {
    const ctx = { _backupOpChain: Promise.resolve() };
    const events = [];
    let active = 0;
    const mkOp = (label, delayMs) => () =>
      proto._withBackupMutex.call(ctx, label, async () => {
        active++;
        assert.equal(active, 1, `op ${label} must run with no other op active`);
        events.push(`start:${label}`);
        await new Promise((r) => setTimeout(r, delayMs));
        events.push(`end:${label}`);
        active--;
        return label;
      });

    // Launch three ops "concurrently" — the mutex must serialise them.
    const results = await Promise.all([mkOp("A", 30)(), mkOp("B", 10)(), mkOp("C", 5)()]);
    assert.deepEqual(results, ["A", "B", "C"], "ops resolve with their own labels");
    // Each op fully completes before the next starts (FIFO order preserved).
    assert.deepEqual(
      events,
      ["start:A", "end:A", "start:B", "end:B", "start:C", "end:C"],
      "ops must run strictly serially in submission order",
    );
  }

  // ── _withBackupMutex — a failing op does not stall the queue ────────────
  {
    const ctx = { _backupOpChain: Promise.resolve() };
    const order = [];
    const p1 = proto._withBackupMutex.call(ctx, "fails", async () => {
      order.push("fails");
      throw new Error("boom");
    }).catch((e) => order.push(`caught:${e.message}`));
    const p2 = proto._withBackupMutex.call(ctx, "after", async () => {
      order.push("after");
      return "ok";
    });
    const [, r2] = await Promise.all([p1, p2]);
    assert.equal(r2, "ok", "op after a failure still runs");
    assert.deepEqual(order, ["fails", "caught:boom", "after"], "failure must not block the next op");
  }

  console.log("cloudBackupResilience.test.js: PASS");
}

run().catch((err) => {
  console.error("cloudBackupResilience.test.js: FAIL");
  console.error(err);
  process.exit(1);
});
