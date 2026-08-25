"use strict";

/**
 * crashRecovery.test.js — Phase D verification (v2.8.10 → v2.8.11)
 *
 * Covers:
 *   1. electron/integrityGate.js
 *      - missing asar → ok:false, reason "app.asar missing"
 *      - valid asar + matching manifest → ok:true, mode "full"
 *      - valid asar + mismatching manifest → ok:false, "hash mismatch"
 *      - invalid header → ok:false, "header is invalid"
 *      - no manifest → ok:true, mode "skipped"
 *      - [v2.8.11] Electron asar virtualization simulation — when fs.statSync
 *        reports the asar as a directory with size=0, we must NOT fire the
 *        recovery dialog; we must degrade to `mode=skipped`.
 *   2. server/db.js auto-restore path
 *      - corrupt main adsi.db + valid backup slot 0 → restored:true,
 *        restoredFromSlot: 0, live table readable after open
 *
 * Runs under the smoke harness (scripts/smoke-all.js) after
 * `npm run rebuild:native:node`, so better-sqlite3 ABI matches Node.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const INTEGRITY_GATE_PATH = path.join(REPO_ROOT, "electron", "integrityGate.js");
const DB_MODULE_PATH = path.join(REPO_ROOT, "server", "db.js");

function mkTempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `adsi-${label}-`));
}

function rmTree(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); }
  catch (_) { /* best effort */ }
}

function writeAsarWithManifest(dir, sizeBytes = 256 * 1024) {
  fs.mkdirSync(dir, { recursive: true });
  const body = Buffer.concat([
    Buffer.from([0x04, 0x00, 0x00, 0x00]),  // asar magic
    crypto.randomBytes(sizeBytes),
  ]);
  const asarPath = path.join(dir, "app.asar");
  fs.writeFileSync(asarPath, body);
  const digest = crypto.createHash("sha512").update(body).digest("hex");
  fs.writeFileSync(asarPath + ".sha512", digest + "\n");
  return { asarPath, body, digest };
}

function testIntegrityGate() {
  const { verifyAsarIntegrity } = require(INTEGRITY_GATE_PATH);

  // 1a. Missing asar
  {
    const tmp = mkTempDir("ig-missing");
    const r = verifyAsarIntegrity({ resourcesPath: tmp, forceFull: true });
    assert.strictEqual(r.ok, false, "missing asar must fail");
    assert.ok(/missing/i.test(r.reason), `expected 'missing' in reason, got: ${r.reason}`);
    rmTree(tmp);
  }

  // 1b. Valid asar + matching manifest
  {
    const tmp = mkTempDir("ig-valid");
    writeAsarWithManifest(tmp);
    const r = verifyAsarIntegrity({ resourcesPath: tmp, forceFull: true });
    assert.strictEqual(r.ok, true, `valid asar must pass, got reason: ${r.reason}`);
    assert.strictEqual(r.mode, "full");
    rmTree(tmp);
  }

  // 1c. Valid asar + mismatching manifest
  {
    const tmp = mkTempDir("ig-corrupt");
    const { asarPath, body } = writeAsarWithManifest(tmp);
    const flipped = Buffer.from(body);
    flipped[100] ^= 0xFF;
    fs.writeFileSync(asarPath, flipped);
    const r = verifyAsarIntegrity({ resourcesPath: tmp, forceFull: true });
    assert.strictEqual(r.ok, false, "corrupted asar must fail");
    assert.ok(/hash mismatch/i.test(r.reason), `expected 'hash mismatch', got: ${r.reason}`);
    rmTree(tmp);
  }

  // 1d. Invalid header
  {
    const tmp = mkTempDir("ig-bad-header");
    fs.mkdirSync(tmp, { recursive: true });
    const asarPath = path.join(tmp, "app.asar");
    fs.writeFileSync(asarPath, Buffer.alloc(8192, 0xFF));  // no magic bytes
    fs.writeFileSync(asarPath + ".sha512", "deadbeef\n");
    const r = verifyAsarIntegrity({ resourcesPath: tmp, forceFull: true });
    assert.strictEqual(r.ok, false, "bad header must fail");
    assert.ok(/header is invalid/i.test(r.reason), `expected 'header is invalid', got: ${r.reason}`);
    rmTree(tmp);
  }

  // 1e. No manifest (pre-v2.8.10 install)
  {
    const tmp = mkTempDir("ig-no-manifest");
    fs.mkdirSync(tmp, { recursive: true });
    const asarPath = path.join(tmp, "app.asar");
    fs.writeFileSync(asarPath, Buffer.concat([
      Buffer.from([0x04, 0x00, 0x00, 0x00]),
      Buffer.alloc(1024, 0xAA),
    ]));
    const r = verifyAsarIntegrity({ resourcesPath: tmp, forceFull: true });
    assert.strictEqual(r.ok, true, "missing manifest must pass (legacy install)");
    assert.strictEqual(r.mode, "skipped");
    rmTree(tmp);
  }

  console.log("  ✓ integrityGate: 5 cases (missing, valid, corrupt, bad-header, no-manifest)");
}

// v2.8.11 regression: simulate Electron's asar virtualization where
// fs.statSync on the asar archive returns synthetic Stats with
// isDirectory()=true and size=0. Before the fix, that made every packaged
// launch trip the "suspiciously small" branch and display the recovery
// dialog. After the fix, the gate must degrade to `mode=skipped` with a
// diagnostic reason — never show a false-positive recovery dialog.
function testElectronAsarShimSimulation() {
  const tmp = mkTempDir("ig-shim");
  try {
    fs.mkdirSync(tmp, { recursive: true });
    // Put a REAL directory named "app.asar" — that's what Electron's shim
    // effectively reports when you stat the archive from inside itself.
    const asarPath = path.join(tmp, "app.asar");
    fs.mkdirSync(asarPath);
    // Manifest on disk alongside it (what afterPack writes). Its presence
    // does not matter here — the guard must trigger before we read it.
    fs.writeFileSync(asarPath + ".sha512", "f".repeat(128) + "\n");

    // Load integrity gate in a fresh require cache so the original-fs
    // resolution runs fresh.
    delete require.cache[require.resolve(INTEGRITY_GATE_PATH)];
    const { verifyAsarIntegrity } = require(INTEGRITY_GATE_PATH);
    const r = verifyAsarIntegrity({ resourcesPath: tmp, forceFull: true });

    assert.strictEqual(r.ok, true,
      `shim simulation must NOT fail integrity (got ok=${r.ok}, reason=${r.reason})`);
    assert.strictEqual(r.mode, "skipped", `expected mode=skipped, got ${r.mode}`);
    assert.ok(/directory|shim|original-fs/i.test(r.reason),
      `reason must indicate shim/directory fallback, got: ${r.reason}`);
    console.log(`  ✓ integrityGate: Electron asar shim simulation → skipped (reason="${r.reason}")`);
  } finally {
    rmTree(tmp);
  }
}

function testDbAutoRestore() {
  const tmp = mkTempDir("db-restore");
  const backupsDir = path.join(tmp, "backups");
  fs.mkdirSync(backupsDir, { recursive: true });

  // Stand up a valid backup slot using better-sqlite3 via ADSI_DATA_DIR.
  process.env.ADSI_DATA_DIR = tmp;
  // Force module cache reset so db.js re-evaluates with the new env.
  delete require.cache[require.resolve(DB_MODULE_PATH)];
  // We need a Database constructor before db.js runs — use a throwaway path.
  // Use the default DELETE journal mode + explicit PRAGMA wal_checkpoint so
  // the standalone .db file contains all data (no dangling WAL sidecar).
  // Production backups use db.backup(dest) which is always consistent, but
  // for a unit test the simpler approach is DELETE mode.
  const Database = require("better-sqlite3");
  const seedPath = path.join(backupsDir, "adsi_backup_0.db");
  const seed = new Database(seedPath);
  seed.pragma("journal_mode = DELETE");
  seed.exec("CREATE TABLE ping(id INTEGER PRIMARY KEY, v TEXT); INSERT INTO ping(v) VALUES('survived')");
  seed.close();

  // Corrupt main adsi.db — write garbage so _sqliteFileLooksValidSync rejects header.
  const mainPath = path.join(tmp, "adsi.db");
  fs.writeFileSync(mainPath, Buffer.alloc(8192, 0xAB));

  // Open db.js — triggers _autoRestoreMainDbFromBackupSync.
  const dbMod = require(DB_MODULE_PATH);
  try {
    const snap = dbMod.startupIntegrityResult;
    assert.ok(snap, "startupIntegrityResult must be exported");
    assert.strictEqual(snap.mainDb, "ok", `expected mainDb=ok after restore, got ${snap.mainDb}`);
    assert.strictEqual(snap.restored, true, "must auto-restore from backup");
    assert.strictEqual(snap.restoredFromSlot, 0, "must restore from slot 0");
    // Verify we can read the restored table.
    const row = dbMod.db.prepare("SELECT v FROM ping WHERE id=1").get();
    assert.strictEqual(row?.v, "survived", "restored DB must have seed row");
    // Verify audit quarantine file exists.
    const quarantined = fs.readdirSync(tmp).filter((f) => /adsi\.db\.corrupt-/.test(f));
    assert.ok(quarantined.length >= 1, "quarantine file should be present");
    console.log(`  ✓ db auto-restore: restoredFromSlot=${snap.restoredFromSlot}, quarantined=${quarantined[0]}`);
  } finally {
    try { dbMod.closeDb(); } catch (_) { /* ignore */ }
    delete require.cache[require.resolve(DB_MODULE_PATH)];
    delete process.env.ADSI_DATA_DIR;
    // Give Windows a beat to release WAL handles before removing.
    setTimeout(() => rmTree(tmp), 150);
  }
}

function main() {
  console.log("[crashRecovery] start");
  testIntegrityGate();
  testElectronAsarShimSimulation();
  testDbAutoRestore();
  console.log("[crashRecovery] all assertions passed");
}

main();
