"use strict";

// Test the BackupHealthRegistry module in isolation: persistence, counter
// behavior, snapshot shape, and broadcast hook.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { BackupHealthRegistry } = require("../backupHealthRegistry");

function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "adsi-bhr-"));
  try {
    const stateFilePath = path.join(root, "backupHealth.json");

    const broadcastEvents = [];
    const broadcast = (msg) => broadcastEvents.push(msg);

    // ── Constructor with no prior state ──
    let reg = new BackupHealthRegistry({ stateFilePath, broadcast });
    let snap = reg.getSnapshot();
    assert.equal(snap.summaryStatus, "ok", "fresh snapshot should be ok");
    assert.equal(snap.tier1.lastAttemptAt, null);
    assert.equal(snap.tier1.consecutiveFailures, 0);
    assert.equal(snap.tier1.status, "unknown", "no attempts yet → unknown");

    // ── Record a success ──
    reg.recordAttempt("tier1", true, {
      destination: "/tmp/adsi_backup_0.db",
      sizeBytes: 1234,
      durationMs: 50,
    });
    snap = reg.getSnapshot();
    assert.equal(snap.tier1.consecutiveFailures, 0);
    assert.equal(snap.tier1.status, "ok");
    assert.equal(snap.tier1.lastSizeBytes, 1234);
    assert.equal(snap.tier1.destination, "/tmp/adsi_backup_0.db");
    assert.equal(broadcastEvents.length, 1);
    assert.equal(broadcastEvents[0].type, "backup_health");

    // ── Three consecutive failures → status=alert ──
    for (let i = 0; i < 3; i++) {
      reg.recordAttempt("tier1", false, { error: `fake fail ${i}` });
    }
    snap = reg.getSnapshot();
    assert.equal(snap.tier1.consecutiveFailures, 3);
    assert.equal(snap.tier1.status, "alert");
    assert.equal(snap.summaryStatus, "alert", "summaryStatus should escalate");
    assert.equal(snap.tier1.lastError, "fake fail 2");

    // ── Success after failures resets counter ──
    reg.recordAttempt("tier1", true, { sizeBytes: 5678 });
    snap = reg.getSnapshot();
    assert.equal(snap.tier1.consecutiveFailures, 0);
    assert.equal(snap.tier1.status, "ok");
    assert.equal(snap.tier1.lastError, null);
    assert.equal(snap.summaryStatus, "ok");

    // ── Persistence: re-instantiate and read back ──
    reg = new BackupHealthRegistry({ stateFilePath, broadcast });
    snap = reg.getSnapshot();
    assert.equal(snap.tier1.lastSizeBytes, 5678, "state should persist across instances");
    assert.equal(snap.tier1.consecutiveFailures, 0);

    // ── Unknown type is ignored, not crash ──
    reg.recordAttempt("nonsense", true, {});
    // No new event should have been broadcast — still 1 from the new
    // instance's internal stuff (none) — verify by checking the most recent
    // type we DID record is still "tier1".
    snap = reg.getSnapshot();
    assert.equal(snap.tier1.status, "ok");

    // ── setNextScheduled / setDestination ──
    reg.setNextScheduled("portableScheduled", 1700000000000);
    reg.setDestination("portableScheduled", "D:/usb/backups");
    snap = reg.getSnapshot();
    assert.equal(snap.portableScheduled.nextScheduledAt, 1700000000000);
    assert.equal(snap.portableScheduled.destination, "D:/usb/backups");

    // ── recentEvents cap (50) ──
    for (let i = 0; i < 60; i++) {
      reg.recordAttempt("tier3", true, { sizeBytes: i });
    }
    snap = reg.getSnapshot();
    assert.ok(snap.recentEvents.length <= 50, `events capped at 50, got ${snap.recentEvents.length}`);
    // Most recent event should be the last one we recorded.
    const last = snap.recentEvents[snap.recentEvents.length - 1];
    assert.equal(last.type, "tier3");
    assert.equal(last.sizeBytes, 59);

    // ── Corrupt state file → graceful blank reload ──
    fs.writeFileSync(stateFilePath, "{not json");
    reg = new BackupHealthRegistry({ stateFilePath, broadcast });
    snap = reg.getSnapshot();
    assert.equal(snap.tier1.lastAttemptAt, null, "corrupt JSON should reset to blank");
    assert.equal(snap.summaryStatus, "ok");

    console.log("backupHealthRegistry.test.js: PASS");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

try {
  run();
} catch (err) {
  console.error("backupHealthRegistry.test.js: FAIL");
  console.error(err);
  process.exitCode = 1;
}
