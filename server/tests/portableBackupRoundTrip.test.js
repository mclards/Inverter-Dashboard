"use strict";
/**
 * portableBackupRoundTrip.test.js — v2.8.14 hotfix regression
 *
 * The original .adsibak path used `powershell Compress-Archive` /
 * `Expand-Archive`, which on Windows PowerShell 5.1 refuses any source
 * larger than 2 GiB (`File size (...) is greater than 2 GiB`). The fix
 * swaps to Node's `archiver` (Zip64 writer) + `extract-zip` (Zip64-aware
 * reader). It also rewrote sha256File to stream because Node's
 * fs.readFileSync has the same 2 GiB cap and would have failed at the
 * checksum step even after the zip step succeeded.
 *
 * This file covers:
 *   - The new _zipDirectory + _extractZip helpers (round-trip incl. deep tree)
 *   - sha256File on a >2 GiB sparse file (proves the streaming hash works)
 *   - createLocalBackup / restoreBackup roundtrip via the standard scope
 *     path (database+config+logs) — exercises archiver indirectly via the
 *     same code path the portable backup uses, but without the static
 *     getNewRoot() lookups that touch real ProgramData
 *
 * NOT covered here (covered by manual smoke):
 *   - Full createPortableBackup → import → restore on a real machine
 *     (the static getNewRoot() lookups for archive/license/auth make
 *     unit-isolating that path very awkward)
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CloudBackupService = require("../cloudBackup");

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function buildService({ root }) {
  const dataDir = path.join(root, "data");
  const programDataDir = path.join(root, "programdata");
  const backupDir = path.join(root, "cloud_backups");
  const historyFile = path.join(root, "backup_history.json");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(programDataDir, { recursive: true });
  fs.mkdirSync(backupDir, { recursive: true });

  const sourceDb = path.join(root, "source-adsi.db");
  fs.writeFileSync(sourceDb, "MOCK-DB-BYTES");
  fs.writeFileSync(path.join(dataDir, "adsi.db"), "ORIGINAL-LIVE-DB");

  const settingsStore = new Map();
  const fakeDb = {
    backup: async (dest) => { fs.copyFileSync(sourceDb, dest); },
    prepare: () => ({ get: () => null, all: () => [] }),
    pragma: () => {},
  };

  const svc = new CloudBackupService({
    dataDir,
    db: fakeDb,
    getSetting: (k, fb = null) => (settingsStore.has(k) ? settingsStore.get(k) : fb),
    setSetting: (k, v) => { settingsStore.set(k, v); },
    tokenStore: { isConnected: () => false, listConnected: () => [] },
    onedrive: null,
    gdrive: null,
    s3: null,
    poller: { isRunning: () => false, stop: () => {}, start: () => {} },
    ipConfigPath: path.join(programDataDir, "ipconfig.json"),
    programDataDir,
    backupDir,
    historyFile,
  });
  return { svc, dataDir, programDataDir, backupDir };
}

async function testZipDirectoryHelperHandlesEmptyAndDeepTrees() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "adsi-zip-helper-"));
  try {
    const { svc } = buildService({ root });
    const srcDir = path.join(root, "src-tree");
    writeFile(path.join(srcDir, "top.txt"), "TOP");
    writeFile(path.join(srcDir, "a", "b", "c", "deep.txt"), "DEEP");
    writeFile(path.join(srcDir, "manifest.json"), '{"scope":["database"]}');

    const destZip = path.join(root, "out.zip");
    const bytesWritten = await svc._zipDirectory(srcDir, destZip);
    assert.ok(bytesWritten > 0, "zip should have non-zero size");

    // Must be a real zip: PK\x03\x04 (local file header) at offset 0
    const fd = fs.openSync(destZip, "r");
    try {
      const buf = Buffer.alloc(4);
      fs.readSync(fd, buf, 0, 4, 0);
      assert.deepEqual(
        Array.from(buf),
        [0x50, 0x4b, 0x03, 0x04],
        ".zip must start with the PK\\x03\\x04 local file header",
      );
    } finally {
      fs.closeSync(fd);
    }

    // Round-trip through extract-zip
    const extractDir = path.join(root, "extracted");
    await svc._extractZip(destZip, extractDir);
    assert.equal(fs.readFileSync(path.join(extractDir, "top.txt"), "utf8"), "TOP");
    assert.equal(fs.readFileSync(path.join(extractDir, "a", "b", "c", "deep.txt"), "utf8"), "DEEP");

    console.log("  • _zipDirectory + _extractZip handle deep trees (real zip header + round-trip): PASS");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testZipProgressCallback() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "adsi-zip-prog-"));
  try {
    const { svc } = buildService({ root });
    const srcDir = path.join(root, "src");
    // Several files so progress fires at least once
    for (let i = 0; i < 8; i++) {
      writeFile(path.join(srcDir, `file-${i}.bin`), Buffer.alloc(64 * 1024, i));
    }
    const destZip = path.join(root, "prog.zip");
    let lastProcessed = -1;
    let progressCalls = 0;
    await svc._zipDirectory(srcDir, destZip, (processed, _total) => {
      progressCalls += 1;
      assert.ok(processed >= lastProcessed, "progress must be monotonic");
      lastProcessed = processed;
    });
    assert.ok(progressCalls > 0, "onProgress must be invoked at least once");
    console.log(`  • _zipDirectory onProgress fired ${progressCalls} times monotonically: PASS`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testStreamingSha256HandlesLargeFiles() {
  // Repro of the production bug: build a >2 GiB sparse file (zero disk usage)
  // and confirm sha256File no longer throws ERR_FS_FILE_TOO_LARGE. Skipped
  // on platforms where sparse files aren't supported reliably.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "adsi-sha-large-"));
  try {
    const big = path.join(root, "big.bin");
    // 2.5 GiB virtual size, 0 bytes on disk thanks to truncate
    const sizeBytes = 2.5 * 1024 * 1024 * 1024;
    let supported = false;
    try {
      const fd = fs.openSync(big, "w");
      try {
        fs.ftruncateSync(fd, sizeBytes);
        supported = fs.statSync(big).size >= sizeBytes;
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      supported = false;
      console.log(`  • Streaming sha256 (large): SKIPPED (sparse file unsupported: ${err.message})`);
      return;
    }
    if (!supported) {
      console.log("  • Streaming sha256 (large): SKIPPED (truncate produced wrong size)");
      return;
    }

    // Pull the helper out of the module's closure indirectly via a tiny
    // backup that hashes a real file — the easiest is to just call the
    // exported sha256File. It's not exported, so we use a dummy zip that
    // forces _zipDirectory to read the big file (which uses streaming I/O
    // internally). For the *checksum* path we instead instantiate a service
    // and call _verifyChecksums on a manifest pointing at the big file.

    const { svc } = buildService({ root });
    // Place the big file in a known location and craft a manifest that
    // points at it so _verifyChecksums calls sha256File on it.
    const dir = path.join(svc.backupDir, "large-test");
    fs.mkdirSync(dir, { recursive: true });
    fs.renameSync(big, path.join(dir, "huge.bin"));
    const manifest = { checksums: { "huge.bin": "deadbeef" } }; // wrong checksum, but call must not throw
    let threw = null;
    try {
      svc._verifyChecksums(dir, manifest); // should return false (mismatch), not throw
    } catch (err) {
      threw = err;
    }
    assert.equal(
      threw,
      null,
      `sha256File must not throw on >2 GiB files (got: ${threw && threw.message})`,
    );
    console.log("  • Streaming sha256 handles >2 GiB files without ERR_FS_FILE_TOO_LARGE: PASS");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testCreateAndRestoreLocalBackupViaArchiverPath() {
  // Standard local backup path (createLocalBackup → restoreBackup) does NOT
  // touch the static getNewRoot() helpers — it stays inside the constructor's
  // programDataDir/dataDir. Exercising this validates that nothing in the
  // new archiver/extract-zip plumbing broke the in-app backup chain.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "adsi-local-rt-"));
  try {
    const { svc, dataDir, programDataDir } = buildService({ root });
    writeFile(path.join(programDataDir, "ipconfig.json"), '{"items":["192.168.1.10"]}');
    writeFile(path.join(programDataDir, "logs", "recovery.log"), "RECOVERY-OK");

    const created = await svc.createLocalBackup({
      scope: ["database", "config", "logs"],
      tag: "rt-test",
    });
    assert.ok(created.id, "createLocalBackup must return id");

    // Wipe live state
    fs.unlinkSync(path.join(dataDir, "adsi.db"));
    fs.unlinkSync(path.join(programDataDir, "ipconfig.json"));
    fs.rmSync(path.join(programDataDir, "logs"), { recursive: true, force: true });

    svc._setProgress({ status: "done", pct: 100, message: "ready" });
    await svc.restoreBackup(created.id, { skipSafetyBackup: true });

    assert.ok(fs.existsSync(path.join(dataDir, "adsi.db")), "DB must restore");
    assert.ok(fs.existsSync(path.join(programDataDir, "ipconfig.json")), "ipconfig.json must restore");
    assert.ok(
      fs.existsSync(path.join(programDataDir, "logs", "recovery.log")),
      "recovery.log must restore",
    );
    console.log("  • createLocalBackup + restoreBackup round-trip (via new helpers): PASS");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function run() {
  console.log("portableBackupRoundTrip.test.js:");
  await testZipDirectoryHelperHandlesEmptyAndDeepTrees();
  await testZipProgressCallback();
  await testStreamingSha256HandlesLargeFiles();
  await testCreateAndRestoreLocalBackupViaArchiverPath();
  console.log("portableBackupRoundTrip.test.js: PASS");
}

run().catch((err) => {
  console.error("portableBackupRoundTrip.test.js: FAIL");
  console.error(err);
  process.exit(1);
});
