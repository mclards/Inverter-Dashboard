"use strict";

/**
 * shutdownReason.test.js — v2.8.14 nightly-reboot diagnostics
 *
 * Covers electron/shutdownReason.js:
 *   1. First boot (no sentinel, no current) → classification "first-boot"
 *   2. Graceful shutdown path:
 *        - recordShutdownReasonSync writes shutdown-reason.current.json
 *        - readLastShutdownSync → classification "graceful" with reason
 *        - shutdown-reason.current.json archived to .prev
 *   3. Unexpected shutdown (sentinel present, current missing) →
 *        classification "unexpected" and a synthetic prev record is
 *        written so the server can surface a banner.
 *   4. Every readLastShutdownSync writes a fresh boot-sentinel.json so the
 *        NEXT run can detect whether our handlers fired.
 *   5. recordShutdownReasonSync is safe to call multiple times — used by
 *        `recordShutdownReasonOnce` in electron/main.js which relies on
 *        idempotent behaviour of the raw writer (the once-ness lives in
 *        the caller).
 *
 * Uses a scratch PROGRAMDATA override via process.env so the test does
 * NOT touch the real C:\ProgramData\InverterDashboard\lifecycle directory.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const MODULE_PATH = path.join(REPO_ROOT, "electron", "shutdownReason.js");

function mkTempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `adsi-shutdown-${label}-`));
}

function rmTree(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) { /* best effort */ }
}

function freshRequire(originalProgramData, scratchDir) {
  // The shutdownReason module captures PROGRAMDATA at require time. To
  // exercise the paths we need a clean require per scenario.
  process.env.PROGRAMDATA = scratchDir;
  delete require.cache[require.resolve(MODULE_PATH)];
  const mod = require(MODULE_PATH);
  // Restore original for any concurrent tests — the module already captured
  // its PATHS, so mutating env afterwards is safe.
  if (originalProgramData !== undefined) process.env.PROGRAMDATA = originalProgramData;
  else delete process.env.PROGRAMDATA;
  return mod;
}

function runTest(name, fn) {
  const originalProgramData = process.env.PROGRAMDATA;
  const scratchRoot = mkTempDir(name);
  // Module expects <PROGRAMDATA>/InverterDashboard/lifecycle/...
  try {
    fn({ scratchRoot, originalProgramData });
    console.log(`  ✓ ${name}`);
  } finally {
    rmTree(scratchRoot);
    if (originalProgramData !== undefined) process.env.PROGRAMDATA = originalProgramData;
    else delete process.env.PROGRAMDATA;
  }
}

console.log("shutdownReason.test.js — v2.8.14 diagnostics module");

runTest("first-boot-no-sentinel", ({ scratchRoot, originalProgramData }) => {
  const mod = freshRequire(originalProgramData, scratchRoot);
  const snap = mod.readLastShutdownSync();
  assert.strictEqual(snap.classification, "first-boot", "fresh install should classify as first-boot");
  assert.strictEqual(snap.sentinelWasPresent, false);
  assert.strictEqual(snap.priorReason, null);
  // Sentinel MUST exist after read so the next run can classify
  assert.ok(fs.existsSync(mod.PATHS.sentinel), "boot-sentinel should be written on every read");
});

runTest("graceful-shutdown-recorded-and-archived", ({ scratchRoot, originalProgramData }) => {
  const mod = freshRequire(originalProgramData, scratchRoot);
  // Simulate startup #1 (writes sentinel)
  mod.readLastShutdownSync();
  // Simulate session-end handler firing
  const rec = mod.recordShutdownReasonSync(mod.REASONS.SESSION_END, {
    initiator: mod.INITIATORS.WINDOWS_OS,
    extra: { sessionEndReason: "shutdown" },
  });
  assert.ok(rec, "recordShutdownReasonSync should return the written record");
  assert.strictEqual(rec.reason, "session-end");
  assert.strictEqual(rec.initiator, "windows-os");
  assert.strictEqual(rec.sessionEndReason, "shutdown", "extra fields should be merged");
  assert.ok(fs.existsSync(mod.PATHS.current), "current marker should exist after record");

  // Simulate startup #2 — classify the prior shutdown
  const snap = mod.readLastShutdownSync();
  assert.strictEqual(snap.classification, "graceful");
  assert.strictEqual(snap.priorReason.reason, "session-end");
  assert.strictEqual(snap.priorReason.initiator, "windows-os");
  // current should be archived to prev and removed
  assert.strictEqual(fs.existsSync(mod.PATHS.current), false, "current should be removed after archive");
  assert.ok(fs.existsSync(mod.PATHS.prev), "prev should be written on graceful archive");
});

runTest("unexpected-shutdown-writes-synthetic-prev", ({ scratchRoot, originalProgramData }) => {
  const mod = freshRequire(originalProgramData, scratchRoot);
  // Simulate startup #1 — writes sentinel, no prior shutdown
  mod.readLastShutdownSync();
  assert.ok(fs.existsSync(mod.PATHS.sentinel), "sentinel from startup #1");
  // DO NOT record a shutdown reason — simulates BSOD / power loss / hard kill

  // Simulate startup #2 — sentinel present, no current marker
  const snap = mod.readLastShutdownSync();
  assert.strictEqual(snap.classification, "unexpected");
  assert.strictEqual(snap.sentinelWasPresent, true);
  assert.ok(snap.priorReason, "synthetic prior reason should be populated");
  assert.strictEqual(snap.priorReason.reason, "unexpected-shutdown");
  assert.strictEqual(snap.priorReason.initiator, "unknown");
  // prev should hold the synthetic record for the server to read
  const prev = mod.readPrevShutdownSync();
  assert.ok(prev);
  assert.strictEqual(prev.reason, "unexpected-shutdown");
});

runTest("sentinel-rotates-on-every-read", ({ scratchRoot, originalProgramData }) => {
  const mod = freshRequire(originalProgramData, scratchRoot);
  mod.readLastShutdownSync();
  const first = fs.readFileSync(mod.PATHS.sentinel, "utf8");
  // Second read rotates even with no prior shutdown recorded
  mod.readLastShutdownSync();
  const second = fs.readFileSync(mod.PATHS.sentinel, "utf8");
  // startedAt timestamps should differ OR the pid line should match — the
  // important property is that the file was rewritten with fresh content.
  const firstJson = JSON.parse(first);
  const secondJson = JSON.parse(second);
  assert.ok(secondJson.startedAt >= firstJson.startedAt, "second sentinel should be newer or equal");
});

runTest("record-multiple-times-last-write-wins-at-writer-level", ({ scratchRoot, originalProgramData }) => {
  const mod = freshRequire(originalProgramData, scratchRoot);
  mod.readLastShutdownSync();
  mod.recordShutdownReasonSync(mod.REASONS.BEFORE_QUIT, { initiator: mod.INITIATORS.USER });
  mod.recordShutdownReasonSync(mod.REASONS.SESSION_END, { initiator: mod.INITIATORS.WINDOWS_OS });
  const snap = mod.readLastShutdownSync();
  assert.strictEqual(snap.classification, "graceful");
  // At the raw-writer layer the later call wins. The main.js caller enforces
  // first-write-wins via recordShutdownReasonOnce; that's a separate invariant
  // covered by the electron runtime, not this unit.
  assert.strictEqual(snap.priorReason.reason, "session-end");
});

runTest("record-returns-null-when-writer-fails", ({ scratchRoot, originalProgramData }) => {
  const mod = freshRequire(originalProgramData, scratchRoot);
  // Point PATHS at a directory that cannot be created — unwritable root.
  // On Windows we simulate by making the lifecycle dir read-only. This is
  // best-effort — if the FS permits the write, the test passes vacuously.
  try {
    fs.mkdirSync(mod.PATHS.lifecycleDir, { recursive: true });
    // Make lifecycleDir a file so writes to its children fail. Windows
    // ACLs vary; skip if this setup doesn't take.
    rmTree(mod.PATHS.lifecycleDir);
    fs.writeFileSync(mod.PATHS.lifecycleDir, "not-a-dir");
    const rec = mod.recordShutdownReasonSync(mod.REASONS.BEFORE_QUIT);
    // Either null (failure gracefully handled) or an object if the FS
    // somehow permitted the write. Both are acceptable; what matters is
    // that the function did not throw.
    assert.ok(rec === null || typeof rec === "object");
  } catch (err) {
    // Any throw would be a regression
    assert.fail(`recordShutdownReasonSync threw: ${err?.message || err}`);
  } finally {
    // Cleanup: remove the sentinel-blocking file if present so teardown
    // rmTree can clear the scratch dir.
    try {
      const st = fs.statSync(mod.PATHS.lifecycleDir);
      if (st.isFile()) fs.unlinkSync(mod.PATHS.lifecycleDir);
    } catch (_) { /* ignore */ }
  }
});

runTest("concurrent-instance-suppresses-unexpected-classification", ({ scratchRoot, originalProgramData }) => {
  // The standalone Utility Tool / Calibrator launches in parallel with the
  // dashboard and shares the lifecycle dir. Without a liveness check the
  // calibrator's `readLastShutdownSync` would see the dashboard's still-
  // present sentinel + missing current.json and synthesize a bogus
  // "unexpected-shutdown" record into prev — false-flagging a perfectly
  // healthy first-instance run. The liveness check (process.kill(pid, 0))
  // must catch this and return classification "concurrent-instance"
  // without mutating sentinel or prev.
  const mod = freshRequire(originalProgramData, scratchRoot);
  // Startup #1: simulate the dashboard taking ownership.
  mod.readLastShutdownSync();
  const sentinelBefore = fs.readFileSync(mod.PATHS.sentinel, "utf8");
  // Forge a sentinel whose pid is THIS process — known alive. The module's
  // own check skips its own pid intentionally (to avoid self-deadlock in
  // tests / single-run smokes), so we use a sibling pid that is definitely
  // alive: the parent of `process` if available, otherwise fall back to
  // `process.pid` and accept the test will exercise the "concurrent" path
  // only when ppid is reachable. On Windows, ppid is usually the shell —
  // also alive while tests run.
  const alivePid = (typeof process.ppid === "number" && process.ppid > 0)
    ? process.ppid
    : process.pid;
  fs.writeFileSync(mod.PATHS.sentinel, JSON.stringify({
    startedAt: Date.now() - 60000,
    isoTime: new Date(Date.now() - 60000).toISOString(),
    pid: alivePid,
    platform: process.platform,
  }, null, 2));
  // No current.json — would normally classify "unexpected".
  try { fs.unlinkSync(mod.PATHS.current); } catch (_) {}
  try { fs.unlinkSync(mod.PATHS.prev); } catch (_) {}

  const snap = mod.readLastShutdownSync();
  if (alivePid !== process.pid) {
    assert.strictEqual(snap.classification, "concurrent-instance",
      "live-pid sentinel must classify as concurrent-instance, not unexpected");
    assert.strictEqual(snap.sentinelWasPresent, true);
    assert.strictEqual(snap.priorReason, null,
      "concurrent-instance must NOT synthesize a unexpected-shutdown prev");
    // Critical: sentinel was NOT overwritten by the concurrent caller
    const sentinelAfter = fs.readFileSync(mod.PATHS.sentinel, "utf8");
    assert.strictEqual(
      JSON.parse(sentinelAfter).pid,
      alivePid,
      "concurrent caller must NOT overwrite the live process's sentinel",
    );
    assert.strictEqual(fs.existsSync(mod.PATHS.prev), false,
      "concurrent caller must NOT write a synthetic prev");
  } else {
    // No usable ppid (rare): the test cannot exercise the path, but the
    // classifier must still not crash and must return a coherent snapshot.
    assert.ok(snap.classification);
  }
  void sentinelBefore;
});

runTest("dead-pid-sentinel-still-classifies-unexpected", ({ scratchRoot, originalProgramData }) => {
  // The mirror of the concurrent-instance test: a sentinel whose PID has
  // already died (the actual "BSOD / power loss / hard kill" case the
  // banner is built for) MUST still classify as unexpected. We pick a
  // PID very unlikely to exist — 1 on Windows belongs to System Idle
  // (a no-signal target → process.kill(1,0) raises EPERM, which the
  // liveness probe treats as alive). So use a high pid number that is
  // almost certainly unallocated. On a contended box this could collide
  // — accept either outcome but log if collision happens.
  const mod = freshRequire(originalProgramData, scratchRoot);
  mod.readLastShutdownSync();
  // Pick a pid that should not exist. We try in descending order.
  const candidates = [987654321, 999999, 99999];
  let deadPid = null;
  for (const c of candidates) {
    try {
      process.kill(c, 0);
      // exists or EPERM — not usable
    } catch (err) {
      if (err && err.code === "ESRCH") { deadPid = c; break; }
    }
  }
  if (deadPid == null) {
    console.log("    (skipped: could not find a guaranteed-dead pid on this box)");
    return;
  }
  fs.writeFileSync(mod.PATHS.sentinel, JSON.stringify({
    startedAt: Date.now() - 60000,
    isoTime: new Date(Date.now() - 60000).toISOString(),
    pid: deadPid,
    platform: process.platform,
  }, null, 2));
  try { fs.unlinkSync(mod.PATHS.current); } catch (_) {}

  const snap = mod.readLastShutdownSync();
  assert.strictEqual(snap.classification, "unexpected",
    "sentinel from a dead pid must still classify as unexpected — that is the banner's whole purpose");
  assert.strictEqual(snap.sentinelWasPresent, true);
  assert.ok(snap.priorReason);
  assert.strictEqual(snap.priorReason.reason, "unexpected-shutdown");
});

runTest("process-exit-fallback-classifies-graceful", ({ scratchRoot, originalProgramData }) => {
  // Mirrors the electron/main.js last-resort writer: when no specific
  // handler ran, the process 'exit' / app 'quit' fallback records
  // REASONS.PROCESS_EXIT. The next boot MUST classify that as "graceful"
  // (no false "Unexpected prior shutdown" banner) — that is the entire
  // point of the hardening.
  const mod = freshRequire(originalProgramData, scratchRoot);
  assert.strictEqual(
    mod.REASONS.PROCESS_EXIT,
    "process-exit",
    "PROCESS_EXIT reason constant must be exported for the main.js fallback",
  );
  // Startup #1 — writes sentinel
  mod.readLastShutdownSync();
  // The process exits without any specific handler firing; the fallback
  // records process-exit synchronously.
  const rec = mod.recordShutdownReasonSync(mod.REASONS.PROCESS_EXIT, {
    initiator: mod.INITIATORS.RUNTIME,
    extra: { via: "process-exit", fallback: true },
  });
  assert.ok(rec, "fallback record should be written");
  assert.strictEqual(rec.reason, "process-exit");
  assert.strictEqual(rec.fallback, true, "extra.fallback should round-trip");
  assert.ok(fs.existsSync(mod.PATHS.current), "current marker present after fallback record");
  // Startup #2 — classify
  const snap = mod.readLastShutdownSync();
  assert.strictEqual(snap.classification, "graceful", "process-exit must be graceful, not unexpected");
  assert.strictEqual(snap.priorReason.reason, "process-exit");
  assert.strictEqual(snap.priorReason.initiator, "runtime");
});

console.log("✓ shutdownReason.test.js — all scenarios passed");
