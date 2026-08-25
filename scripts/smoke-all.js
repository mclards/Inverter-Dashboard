#!/usr/bin/env node
"use strict";

/**
 * T7.3 — ABI-toggle smoke harness for ADSI-Dashboard
 * --------------------------------------------------
 * Built 2026-04-14 to unblock Phase-2/3 backlog verification.
 *
 * Sequence:
 *   1. npm run rebuild:native:node            (flip better-sqlite3 ABI to Node)
 *   2. node server/tests/*.test.js            (run every Node test, collect pass/fail)
 *   3. python -m pytest services/tests/       (run Python unit tests)
 *   4. npm run rebuild:native:electron        (MANDATORY restore — see
 *      memory feedback_native_rebuild.md.  Always runs, even on failure,
 *      so the repo is never left in Node-ABI mode.)
 *   5. Write JSON summary to scripts/.smoke-summary.json
 *   6. Exit 0 only if all green.
 *
 * Usage:
 *   npm run smoke           -- run everything
 *   npm run smoke -- --skip-python   -- skip pytest (Node-only)
 *   npm run smoke -- --node-only     -- alias for --skip-python
 *   npm run smoke -- --no-rebuild    -- skip both ABI rebuilds (assumes Node ABI already active)
 *
 * Exit codes:
 *   0   all green
 *   1   one or more steps failed
 *   2   harness itself errored (rebuild step crashed, etc.)
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..");
const SUMMARY_PATH = path.join(__dirname, ".smoke-summary.json");
const NODE_TESTS_DIR = path.join(REPO_ROOT, "server", "tests");
const PY_TESTS_DIR = path.join(REPO_ROOT, "services", "tests");
const PER_NODE_TEST_TIMEOUT_MS = 5 * 60 * 1000; // 5 min/test ceiling

const args = new Set(process.argv.slice(2));
const SKIP_PYTHON = args.has("--skip-python") || args.has("--node-only");
const NO_REBUILD = args.has("--no-rebuild");

const summary = {
  startedAt: new Date().toISOString(),
  args: [...args],
  steps: {},
  nodeTests: [],
  pythonTests: null,
  finishedAt: null,
  durationMs: 0,
  exitCode: 0,
};

const startTs = Date.now();

function logHeader(title) {
  const bar = "─".repeat(60);
  console.log(`\n${bar}\n  ${title}\n${bar}`);
}

function runStep(name, cmd, args, opts = {}) {
  logHeader(`${name}: ${cmd} ${args.join(" ")}`);
  const startedAt = Date.now();
  const r = spawnSync(cmd, args, {
    cwd: REPO_ROOT,
    stdio: opts.captureOutput ? ["ignore", "pipe", "pipe"] : "inherit",
    shell: opts.shell !== false, // npm on Windows needs shell
    timeout: opts.timeoutMs,
    encoding: "utf8",
    windowsHide: true,
  });
  const durationMs = Date.now() - startedAt;
  const ok = r.status === 0 && !r.error;
  const entry = {
    cmd,
    args,
    status: r.status,
    durationMs,
    ok,
    error: r.error ? String(r.error.message || r.error) : null,
  };
  if (opts.captureOutput) {
    entry.stdout = String(r.stdout || "");
    entry.stderr = String(r.stderr || "");
  }
  summary.steps[name] = entry;
  return entry;
}

function listNodeTests() {
  if (!fs.existsSync(NODE_TESTS_DIR)) return [];
  return fs
    .readdirSync(NODE_TESTS_DIR)
    .filter((f) => f.endsWith(".test.js"))
    .sort();
}

function runNodeTests() {
  const files = listNodeTests();
  console.log(`\n[smoke] Found ${files.length} Node test files in ${NODE_TESTS_DIR}`);
  for (const file of files) {
    const fullPath = path.join(NODE_TESTS_DIR, file);
    logHeader(`Node test: ${file}`);
    const startedAt = Date.now();
    const r = spawnSync(process.execPath, [fullPath], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: PER_NODE_TEST_TIMEOUT_MS,
      encoding: "utf8",
      windowsHide: true,
    });
    const durationMs = Date.now() - startedAt;
    const stdout = String(r.stdout || "");
    const stderr = String(r.stderr || "");
    const ok = r.status === 0 && !r.error;
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    summary.nodeTests.push({
      file,
      status: r.status,
      durationMs,
      ok,
      error: r.error ? String(r.error.message || r.error) : null,
      stdoutTail: stdout.split(/\r?\n/).slice(-20).join("\n"),
      stderrTail: stderr.split(/\r?\n/).slice(-20).join("\n"),
    });
    console.log(`[smoke] ${file} → ${ok ? "PASS" : "FAIL"} (${durationMs}ms, status=${r.status})`);
  }
}

function runPythonTests() {
  if (!fs.existsSync(PY_TESTS_DIR)) {
    summary.pythonTests = { skipped: true, reason: "tests directory missing" };
    return;
  }
  const startedAt = Date.now();
  const junitPath = path.join(__dirname, ".smoke-pytest-junit.xml");
  // Best-effort — if pytest is not installed the spawn returns non-zero;
  // we record that and continue rather than abort.
  const r = spawnSync(
    process.platform === "win32" ? "python" : "python3",
    [
      "-m", "pytest", PY_TESTS_DIR,
      "--junitxml", junitPath,
      "-q",
    ],
    {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      windowsHide: true,
    },
  );
  const durationMs = Date.now() - startedAt;
  const stdout = String(r.stdout || "");
  const stderr = String(r.stderr || "");
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  summary.pythonTests = {
    status: r.status,
    durationMs,
    ok: r.status === 0 && !r.error,
    error: r.error ? String(r.error.message || r.error) : null,
    junitPath: fs.existsSync(junitPath) ? junitPath : null,
    stdoutTail: stdout.split(/\r?\n/).slice(-30).join("\n"),
    stderrTail: stderr.split(/\r?\n/).slice(-30).join("\n"),
  };
  console.log(`[smoke] pytest → ${summary.pythonTests.ok ? "PASS" : "FAIL"} (${durationMs}ms, status=${r.status})`);
}

function writeSummary() {
  summary.finishedAt = new Date().toISOString();
  summary.durationMs = Date.now() - startTs;
  try {
    fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2));
    console.log(`\n[smoke] Summary written: ${SUMMARY_PATH}`);
  } catch (e) {
    console.error(`[smoke] Could not write summary: ${e.message}`);
  }
}

function printVerdict() {
  const failedNode = summary.nodeTests.filter((t) => !t.ok);
  const pyFailed = summary.pythonTests && summary.pythonTests.ok === false;
  const failedSteps = Object.entries(summary.steps).filter(([, v]) => !v.ok);

  logHeader("Verdict");
  console.log(`  Node tests: ${summary.nodeTests.length - failedNode.length}/${summary.nodeTests.length} pass`);
  if (failedNode.length) {
    failedNode.forEach((t) => console.log(`    FAIL: ${t.file} (status=${t.status})`));
  }
  if (summary.pythonTests) {
    if (summary.pythonTests.skipped) {
      console.log(`  Python tests: skipped (${summary.pythonTests.reason})`);
    } else {
      console.log(`  Python tests: ${summary.pythonTests.ok ? "PASS" : "FAIL"} (status=${summary.pythonTests.status})`);
    }
  } else {
    console.log(`  Python tests: skipped (--skip-python)`);
  }
  if (failedSteps.length) {
    console.log(`  Failed harness steps:`);
    failedSteps.forEach(([k, v]) => console.log(`    ${k}: status=${v.status} error=${v.error || "-"}`));
  }
  console.log(`  Total wall time: ${summary.durationMs}ms`);
}

// ── main ────────────────────────────────────────────────────────────────
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

let nodeRebuildOk = NO_REBUILD;
let electronRebuildOk = NO_REBUILD;

try {
  if (!NO_REBUILD) {
    const r = runStep("rebuild:native:node", npmCmd, ["run", "rebuild:native:node"], {
      timeoutMs: 10 * 60 * 1000,
    });
    nodeRebuildOk = r.ok;
    if (!r.ok) {
      console.error("[smoke] Node-ABI rebuild failed; aborting before tests run.");
      summary.exitCode = 2;
    }
  }

  if (nodeRebuildOk || NO_REBUILD) {
    runNodeTests();
    if (!SKIP_PYTHON) {
      runPythonTests();
    }
  }
} catch (e) {
  console.error(`[smoke] Harness crashed: ${e.message}`);
  summary.exitCode = 2;
} finally {
  // CRITICAL: always restore Electron ABI, even on failure or crash, so
  // the repo is never left in Node-ABI mode (per memory
  // feedback_native_rebuild.md).
  if (!NO_REBUILD) {
    const r = runStep("rebuild:native:electron", npmCmd, ["run", "rebuild:native:electron"], {
      timeoutMs: 10 * 60 * 1000,
    });
    electronRebuildOk = r.ok;
    if (!r.ok) {
      console.error("[smoke] WARNING: Electron-ABI restore FAILED. " +
        "Run `npm run rebuild:native:electron` manually before launching the app.");
      summary.exitCode = Math.max(summary.exitCode, 2);
    }
  }

  // Compute exit code from results
  const failedNode = summary.nodeTests.filter((t) => !t.ok).length;
  const pyFailed = summary.pythonTests && summary.pythonTests.ok === false;
  const stepFailed = Object.values(summary.steps).some((v) => !v.ok);
  if (failedNode > 0 || pyFailed || stepFailed) {
    summary.exitCode = Math.max(summary.exitCode, 1);
  }

  writeSummary();
  printVerdict();
  process.exit(summary.exitCode);
}
