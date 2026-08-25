"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "adsi-alarm-ack-"));
process.env.NODE_ENV = "test";
process.env.IM_PORTABLE_DATA_DIR = tempRoot;
fs.mkdirSync(path.join(tempRoot, "config"), { recursive: true });

let closeDb = () => {};
try {
  const dbModule = require("../db");
  const { db, stmts } = dbModule;
  closeDb = dbModule.closeDb;

  const baseTs = Date.now() - 10_000;
  const first = stmts.insertAlarm.run({
    ts: baseTs,
    inverter: 1,
    unit: 1,
    alarm_code: "0040H",
    alarm_value: 0x0040,
    severity: "fault",
    updated_ts: baseTs,
  });
  const firstId = Number(first.lastInsertRowid);
  const ackTs = Math.max(
    Date.now(),
    Number(stmts.getMaxAlarmUpdatedTs.get()?.updated_ts || 0) + 1,
  );

  assert.strictEqual(stmts.ackAlarm.run(ackTs, firstId).changes, 1);
  const acked = db.prepare("SELECT acknowledged, updated_ts FROM alarms WHERE id=?").get(firstId);
  assert.strictEqual(acked.acknowledged, 1);
  assert.strictEqual(acked.updated_ts, ackTs);

  // Idempotency matters for duplicate clicks and WebSocket/HTTP races: the
  // second request must not manufacture another change event or timestamp.
  assert.strictEqual(stmts.ackAlarm.run(ackTs + 1, firstId).changes, 0);
  assert.strictEqual(
    db.prepare("SELECT updated_ts FROM alarms WHERE id=?").get(firstId).updated_ts,
    ackTs,
  );

  const second = stmts.insertAlarm.run({
    ts: baseTs + 1,
    inverter: 1,
    unit: 2,
    alarm_code: "0200H",
    alarm_value: 0x0200,
    severity: "critical",
    updated_ts: ackTs + 1,
  });
  const allTs = Number(stmts.getMaxAlarmUpdatedTs.get()?.updated_ts || 0) + 1;
  assert.strictEqual(stmts.ackAllAlarms.run(allTs).changes, 1);
  const secondAcked = db
    .prepare("SELECT acknowledged, updated_ts FROM alarms WHERE id=?")
    .get(Number(second.lastInsertRowid));
  assert.deepStrictEqual(secondAcked, { acknowledged: 1, updated_ts: allTs });

  console.log("alarmAckPersistenceCore.test.js: PASS");
} catch (err) {
  console.error("alarmAckPersistenceCore.test.js: FAIL", err?.stack || err);
  process.exitCode = 1;
} finally {
  try { closeDb(); } catch (_) {}
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch (_) {}
}
