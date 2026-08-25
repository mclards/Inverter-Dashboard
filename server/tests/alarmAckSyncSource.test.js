"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, "..", "..", relPath), "utf8");
}

try {
  const dbSrc = read("server/db.js");
  const serverSrc = read("server/index.js");
  const appSrc = read("public/js/app.js");

  assert(
    /ackAlarm:\s*db\.prepare\([\s\S]*?acknowledged=1, updated_ts=\?[\s\S]*?id=\? AND acknowledged=0/.test(dbSrc),
    "Single-alarm ACK must be idempotent and stamp updated_ts for incremental replication.",
  );
  assert(
    /ackAllAlarms:\s*db\.prepare\([\s\S]*?acknowledged=1, updated_ts=\?[\s\S]*?acknowledged=0/.test(dbSrc),
    "ACK ALL must stamp updated_ts for incremental replication.",
  );
  assert(
    serverSrc.includes("function nextAlarmAcknowledgementTs(") &&
      serverSrc.includes('type: "alarm_ack"') &&
      serverSrc.includes("broadcastAlarmAcknowledgement({ alarmIds: [id]") &&
      serverSrc.includes("broadcastAlarmAcknowledgement({ all: true"),
    "Gateway ACK routes must emit one authoritative alarm_ack event.",
  );
  assert(
    /if \(type === "alarm_ack"\)[\s\S]*?broadcastUpdate\(\{[\s\S]*?type: "alarm_ack"[\s\S]*?return;[\s\S]*?if \(type !== "init" && type !== "live"\) return;/.test(serverSrc),
    "Remote live bridge must forward alarm_ack before filtering non-live frames.",
  );
  assert(
    appSrc.includes('if (msg.type === "alarm_ack")') &&
      appSrc.includes("function handleAlarmAcknowledgementPush(") &&
      appSrc.includes("refreshAlarmBadge().catch") &&
      appSrc.includes("refreshNotifPanel().catch") &&
      appSrc.includes("fetchAlarms({ force: true, silent: true })"),
    "Renderer must reconcile every alarm surface after an alarm_ack event.",
  );

  console.log("alarmAckSyncSource.test.js: PASS");
} catch (err) {
  console.error("alarmAckSyncSource.test.js: FAIL", err?.stack || err);
  process.exit(1);
}
