"use strict";

const assert = require("assert");
const {
  evaluateTodayEnergyHealth,
} = require("../todayEnergyHealthCore");

function makePrevState(overrides = {}) {
  return {
    byInv: Object.create(null),
    summary: {
      state: "ok",
      reasonCode: "healthy",
      reasonText: "Today-energy sources are healthy.",
      checkedAt: 0,
      activeInverterCount: 0,
      fallbackActiveCount: 0,
      staleCount: 0,
      mismatchCount: 0,
      selectedSource: "pac",
    },
    ...overrides,
  };
}

function run() {
  const now = 1_000_000;

  {
    const result = evaluateTodayEnergyHealth({
      pacRows: [{ inverter: 1, total_kwh: 12.5 }],
      liveTotalsByInv: { 1: { pac: 125000 } },
      prevState: makePrevState({
        byInv: {
          1: {
            pacKwh: 12.2,
            pacAdvanceTs: now - 1000,
            source: "pac",
            reasonCode: "healthy",
          },
        },
      }),
      now,
      solarActive: true,
    });
    assert.equal(result.health.state, "ok");
    assert.equal(result.rows[0].total_kwh, 12.5);
    assert.equal(result.nextState.byInv[1].source, "pac");
  }

  {
    const result = evaluateTodayEnergyHealth({
      pacRows: [{ inverter: 2, total_kwh: 22.0 }],
      liveTotalsByInv: { 2: { pac: 145000 } },
      prevState: makePrevState({
        byInv: {
          2: {
            pacKwh: 22.0,
            pacAdvanceTs: now - 45000,
            source: "pac",
            reasonCode: "healthy",
          },
        },
      }),
      now,
      solarActive: true,
    });
    assert.equal(result.health.state, "stale");
    assert.equal(result.health.reasonCode, "pac_stalled");
    assert.equal(result.rows[0].total_kwh, 22.0);
    assert.equal(result.nextState.byInv[2].source, "pac");
    assert.equal(result.nextState.byInv[2].pacStale, true);
    assert.ok(
      result.events.some(
        (evt) =>
          evt.type === "source_change" &&
          evt.inverter === 2 &&
          evt.source === "pac" &&
          evt.reasonCode === "pac_stalled",
      ),
    );
  }

  {
    const result = evaluateTodayEnergyHealth({
      pacRows: [{ inverter: 3, total_kwh: 30.0 }],
      liveTotalsByInv: { 3: { pac: 110000 } },
      prevState: makePrevState({
        byInv: {
          3: {
            pacKwh: 30.0,
            pacAdvanceTs: now - 60000,
            source: "pac",
            reasonCode: "healthy",
          },
        },
      }),
      now,
      solarActive: true,
    });
    assert.equal(result.health.state, "stale");
    assert.equal(result.health.reasonCode, "pac_stalled");
    assert.equal(result.nextState.byInv[3].source, "pac");
    assert.equal(result.nextState.byInv[3].pacStale, true);
  }

  {
    const result = evaluateTodayEnergyHealth({
      pacRows: [{ inverter: 4, total_kwh: 0.8 }],
      liveTotalsByInv: { 4: { pac: 0 } },
      prevState: makePrevState(),
      now,
      solarActive: false,
    });
    assert.equal(result.health.state, "idle");
    assert.equal(result.health.reasonCode, "inactive");
    assert.equal(result.nextState.byInv[4].source, "pac");
  }

  console.log("todayEnergyHealth.test.js: PASS");
}

run();
