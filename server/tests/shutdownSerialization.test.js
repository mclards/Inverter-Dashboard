"use strict";

// Shutdown serialization regression test (v2.8.11).
//
// Exercises `_beginShutdown` under load to confirm that the serialized
// phase pipeline releases libuv handles without tripping
// `UV_HANDLE_CLOSING` on Windows + Node.
//
// Strategy:
//   1. Boot the embedded server on a random port.
//   2. Fire N concurrent in-flight fetches so AbortController-owned
//      uv_async_t handles are in every possible state when shutdown starts.
//   3. Call `shutdownEmbedded()` and assert it resolves cleanly within
//      budget and the DB file ends up cleanly closed (no WAL residue).
//   4. Repeat the boot/fetch/shutdown cycle LOOP_COUNT times — the race
//      this guards against is probabilistic and accumulates across runs.
//
// Pre-refactor (v2.8.10): 0xC0000409 abort on at least one iteration.
// Post-refactor (v2.8.11): LOOP_COUNT iterations clean.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const LOOP_COUNT = Number(process.env.ADSI_SHUTDOWN_LOOPS || 3);
const CONCURRENT_FETCHES = Number(process.env.ADSI_SHUTDOWN_FETCHES || 10);
const SHUTDOWN_BUDGET_MS = 8000;

process.env.NODE_ENV = "test";

function waitMs(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, Number(ms) || 0)));
}

function pickPort() {
  // Space the ports so parallel smoke runs don't collide with other tests.
  return 3600 + Math.floor(Math.random() * 300);
}

// Fresh IM_PORTABLE_DATA_DIR per iteration so each boot sees a clean DB.
// Keeps the rotating-backup + snapshot paths from each iteration from
// leaking into the next.
function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adsi-shutdown-serial-"));
  fs.mkdirSync(path.join(dir, "config"), { recursive: true });
  return dir;
}

async function fireConcurrentFetches(baseUrl, count) {
  const endpoints = [
    "/api/live",
    "/api/inverters",
    "/api/health/db-integrity",
  ];
  const jobs = [];
  for (let i = 0; i < count; i++) {
    const url = baseUrl + endpoints[i % endpoints.length];
    const controller = new AbortController();
    // Kick off but don't await — we want these in-flight when shutdown runs.
    jobs.push(
      fetch(url, { signal: controller.signal })
        .then((r) => r.text().catch(() => ""))
        .catch(() => {}),
    );
  }
  return jobs;
}

async function runOneIteration(iteration) {
  const tmpDir = makeTmpDir();
  const port = pickPort();
  process.env.IM_PORTABLE_DATA_DIR = tmpDir;
  process.env.ADSI_SERVER_PORT = String(port);

  // Clear require cache so each iteration boots a fresh server. The
  // production path boots once and tears down once, but this loop is
  // specifically probing the teardown-under-load race, so we pay the
  // re-require cost per iteration.
  for (const key of Object.keys(require.cache)) {
    if (
      key.includes(path.sep + "server" + path.sep) &&
      !key.includes(path.sep + "tests" + path.sep)
    ) {
      delete require.cache[key];
    }
  }

  const serverMod = require("../index.js");

  const baseUrl = `http://127.0.0.1:${port}`;

  // Wait for the server to come up (probe /api/live).
  const bootDeadline = Date.now() + 5000;
  let booted = false;
  while (Date.now() < bootDeadline) {
    try {
      const r = await fetch(`${baseUrl}/api/live`);
      if (r.ok || r.status < 500) {
        booted = true;
        break;
      }
    } catch (_) {
      await waitMs(100);
    }
  }
  assert.equal(booted, true, `Iteration ${iteration}: server did not boot on ${baseUrl}`);

  const jobs = await fireConcurrentFetches(baseUrl, CONCURRENT_FETCHES);

  // Do NOT await jobs — they must be in flight when shutdown begins.
  const shutdownStart = Date.now();
  const shutdownPromise = serverMod.shutdownEmbedded();
  assert.ok(shutdownPromise && typeof shutdownPromise.then === "function",
    "shutdownEmbedded must return a Promise");

  const outcome = await Promise.race([
    shutdownPromise.then(() => "clean"),
    waitMs(SHUTDOWN_BUDGET_MS).then(() => "timeout"),
  ]);
  const elapsed = Date.now() - shutdownStart;
  assert.equal(outcome, "clean",
    `Iteration ${iteration}: shutdown did not resolve within ${SHUTDOWN_BUDGET_MS}ms (elapsed=${elapsed}ms)`);

  // Memoization invariant — second call must return the same Promise and
  // resolve immediately without re-running the phases.
  const secondCall = serverMod.shutdownEmbedded();
  const secondOutcome = await Promise.race([
    secondCall.then(() => "clean"),
    waitMs(200).then(() => "timeout"),
  ]);
  assert.equal(secondOutcome, "clean",
    `Iteration ${iteration}: repeat shutdownEmbedded() should be a no-op`);

  // Let any stray fetch rejections settle so node test runner doesn't see
  // them as unhandled after shutdown.
  await Promise.all(jobs);

  // DB file integrity check: the main file must exist with a valid SQLite
  // header, and the WAL (if present) must be truncated to zero — our
  // closeDb() runs `wal_checkpoint(TRUNCATE)` before `db.close()`.
  const dbPath = path.join(tmpDir, "db", "adsi.db");
  assert.ok(fs.existsSync(dbPath), `Iteration ${iteration}: DB file missing at ${dbPath}`);
  const header = Buffer.alloc(16);
  const fd = fs.openSync(dbPath, "r");
  try {
    fs.readSync(fd, header, 0, 16, 0);
  } finally {
    fs.closeSync(fd);
  }
  assert.equal(header.slice(0, 15).toString("utf8"), "SQLite format 3",
    `Iteration ${iteration}: DB header corrupted — got ${header.slice(0, 15).toString("utf8")}`);

  const walPath = dbPath + "-wal";
  if (fs.existsSync(walPath)) {
    const walSize = fs.statSync(walPath).size;
    assert.equal(walSize, 0,
      `Iteration ${iteration}: WAL not truncated after close (size=${walSize})`);
  }

  console.log(`  ✓ Iteration ${iteration}/${LOOP_COUNT} clean (shutdown=${elapsed}ms)`);
}

async function run() {
  console.log(`[Test] Shutdown serialization: ${LOOP_COUNT} iterations × ${CONCURRENT_FETCHES} in-flight fetches`);

  for (let i = 1; i <= LOOP_COUNT; i++) {
    await runOneIteration(i);
  }

  console.log("[Test] All shutdown iterations completed cleanly.");
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("shutdownSerialization.test.js: FAIL", err?.stack || err);
    process.exit(1);
  });
