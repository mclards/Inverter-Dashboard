"use strict";

const assert = require("assert");
const { buildTodayEnergyRowsFromSeed } = require("../poller");

function rowKwh(rows, inverter) {
  return Number(
    (Array.isArray(rows) ? rows : []).find((row) => Number(row?.inverter || 0) === inverter)?.total_kwh || 0,
  );
}

function run() {
  {
    const rows = buildTodayEnergyRowsFromSeed({
      seededTotalByInv: new Map([[1, 102]]),
      seededLiveByInv: new Map([[1, 102]]),
      currentLiveByInv: new Map([[1, 104]]),
    });
    assert.equal(rowKwh(rows, 1), 104, "continuous runtime should not double-count seeded energy");
  }

  {
    const rows = buildTodayEnergyRowsFromSeed({
      seededTotalByInv: new Map([[1, 130]]),
      seededLiveByInv: new Map([[1, 32]]),
      currentLiveByInv: new Map([[1, 40]]),
    });
    assert.equal(rowKwh(rows, 1), 138, "restart seed should preserve persisted energy and add only new live growth");
  }

  {
    const rows = buildTodayEnergyRowsFromSeed({
      seededTotalByInv: new Map(),
      seededLiveByInv: new Map(),
      currentLiveByInv: new Map([[2, 5.4321987]]),
    });
    assert.equal(rowKwh(rows, 2), 5.432199, "new inverters after seed should still contribute their live total");
  }

  console.log("pollerTodayEnergyTotal.test.js: PASS");
}

run();
