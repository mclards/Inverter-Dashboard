"use strict";

const assert = require("assert");
const { classifyAlarmTransition } = require("../alarmEpisodeCore");

function run() {
  assert.equal(classifyAlarmTransition(0, 0), "noop");
  assert.equal(classifyAlarmTransition(0, 0x1000), "raise");
  assert.equal(classifyAlarmTransition(0x1000, 0), "clear");
  assert.equal(classifyAlarmTransition(0x1000, 0x1040), "update_active");
  assert.equal(classifyAlarmTransition(0x1040, 0x1000), "update_active");
  console.log("alarmEpisodeCore.test.js: PASS");
}

run();
