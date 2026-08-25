"use strict";

const assert = require("assert");

const {
  getConfiguredUnitsForInverter,
  buildInverterProfiles,
  buildPlantCapPreview,
  PlantCapController,
} = require("../plantCapController");

function makeIpConfig(overrides = {}) {
  return {
    inverters: {
      1: "192.168.1.101",
      2: "192.168.1.102",
      3: "192.168.1.103",
    },
    units: {},
    ...overrides,
  };
}

function makeLiveRows(nowTs, inverter, totalKw, options = {}) {
  const unitCount = Number(options.unitCount || 4);
  const pacPerUnitW = (Number(totalKw || 0) * 1000) / unitCount;
  const rows = {};
  for (let unit = 1; unit <= unitCount; unit += 1) {
    rows[`${inverter}_${unit}`] = {
      inverter,
      unit,
      pac: pacPerUnitW,
      pdc: pacPerUnitW,
      ts: nowTs,
      online: 1,
      on_off: Number(options.onOff ?? 1),
    };
  }
  return rows;
}

async function run() {
  const nowTs = Date.now();

  const fallbackUnits = getConfiguredUnitsForInverter(
    makeIpConfig({ units: {} }),
    1,
    4,
  );
  assert.deepStrictEqual(
    fallbackUnits,
    [1, 2, 3, 4],
    "Missing unit entries should default to a full 4-node inverter.",
  );

  const partialProfiles = buildInverterProfiles({
    liveData: {
      ...makeLiveRows(nowTs, 1, 600),
      ...makeLiveRows(nowTs, 2, 300, { unitCount: 2 }),
    },
    ipConfig: makeIpConfig({
      units: {
        2: [1, 2],
      },
    }),
    inverterCount: 2,
    nodeCount: 4,
    nowTs,
  });
  assert.strictEqual(
    partialProfiles[1].enabledNodes,
    2,
    "Partial-node inverter should report the configured node count.",
  );
  assert.strictEqual(
    partialProfiles[1].ratedKw,
    498.82,
    "Rated capacity should scale with the configured node count (997.64 × 2/4).",
  );
  assert.strictEqual(
    partialProfiles[1].dependableKw,
    453.46,
    "Dependable capacity should scale with the configured node count (906.92 × 2/4).",
  );

  const stopPreview = buildPlantCapPreview({
    settings: {
      upperMw: 1.5,
      lowerMw: 1.0,
      sequenceMode: "ascending",
      cooldownSec: 30,
    },
    liveData: {
      ...makeLiveRows(nowTs, 1, 900),
      ...makeLiveRows(nowTs, 2, 600),
      ...makeLiveRows(nowTs, 3, 200),
    },
    ipConfig: makeIpConfig(),
    inverterCount: 3,
    nodeCount: 4,
    nowTs,
  });
  assert.strictEqual(
    stopPreview.selectedStop?.inverter,
    2,
    "The planner should skip an earlier inverter if that stop would overshoot the lower limit and a later valid step exists.",
  );

  const restartPreview = buildPlantCapPreview({
    settings: {
      upperMw: 1.5,
      lowerMw: 1.0,
      sequenceMode: "ascending",
      cooldownSec: 30,
    },
    liveData: {
      ...makeLiveRows(nowTs, 1, 800),
    },
    ipConfig: makeIpConfig(),
    inverterCount: 3,
    nodeCount: 4,
    nowTs,
    ownedStopped: {
      2: {
        inverter: 2,
        stoppedAt: nowTs - 5000,
        pacBeforeStopKw: 400,
        enabledNodes: 4,
        ratedKw: 997.64,
        dependableKw: 906.92,
      },
      3: {
        inverter: 3,
        stoppedAt: nowTs - 1000,
        pacBeforeStopKw: 300,
        enabledNodes: 4,
        ratedKw: 997.64,
        dependableKw: 906.92,
      },
    },
  });
  assert.strictEqual(
    restartPreview.selectedRestart?.inverter,
    3,
    "Restarts should use LIFO order for controller-owned inverters.",
  );

  const stoppedRestartPreview = buildPlantCapPreview({
    settings: {
      upperMw: 2.0,
      lowerMw: 1.0,
      sequenceMode: "ascending",
      cooldownSec: 30,
    },
    liveData: {
      ...makeLiveRows(nowTs, 1, 700),
      ...makeLiveRows(nowTs, 2, 0, { onOff: 0 }),
      ...makeLiveRows(nowTs, 3, 0, { onOff: 0 }),
    },
    ipConfig: makeIpConfig(),
    inverterCount: 3,
    nodeCount: 4,
    nowTs,
  });
  assert.strictEqual(
    stoppedRestartPreview.selectedRestart?.inverter,
    2,
    "Stopped non-exempt inverters should be restart candidates even when they were not previously stopped by the controller.",
  );

  const exemptionPreview = buildPlantCapPreview({
    settings: {
      upperMw: 1.1,
      lowerMw: 1.0,
      sequenceMode: "exemption",
      sequenceCustom: [2],
      cooldownSec: 30,
    },
    liveData: {
      ...makeLiveRows(nowTs, 1, 800),
      ...makeLiveRows(nowTs, 2, 500),
      ...makeLiveRows(nowTs, 3, 300),
    },
    ipConfig: makeIpConfig(),
    inverterCount: 3,
    nodeCount: 4,
    nowTs,
  });
  assert.strictEqual(
    exemptionPreview.selectedStop?.inverter,
    3,
    "Exempted inverter numbers should be skipped during automatic stop selection.",
  );
  assert.strictEqual(
    exemptionPreview.stepMetrics.controllableInverterCount,
    2,
    "Exempted inverters should not be counted as controllable stop candidates.",
  );

  const warningPreview = buildPlantCapPreview({
    settings: {
      upperMw: 1.05,
      lowerMw: 0.95,
      sequenceMode: "ascending",
      cooldownSec: 30,
    },
    liveData: {
      ...makeLiveRows(nowTs, 1, 1000),
      ...makeLiveRows(nowTs, 2, 400),
    },
    ipConfig: makeIpConfig(),
    inverterCount: 2,
    nodeCount: 4,
    nowTs,
  });
  assert(
    warningPreview.warnings.some((warning) =>
      ["narrow_band", "narrow_band_severe"].includes(warning.code),
    ),
    "A narrow cap band should emit a dynamic deadband warning.",
  );

  const authorityController = new PlantCapController({
    getLiveData: () => ({}),
    getIpConfig: () => makeIpConfig(),
    getSettings: () => ({
      inverterCount: 3,
      nodeCount: 4,
      plantCapUpperMw: 1.5,
      plantCapLowerMw: 1.0,
      plantCapSequenceMode: "exemption",
      plantCapSequenceCustom: [3],
      plantCapCooldownSec: 30,
    }),
    executeWrite: async () => ({ ok: true }),
    broadcast: () => {},
  });
  authorityController.state.enabled = true;
  authorityController.state.activeConfig = {
    upperMw: 1.5,
    lowerMw: 1.0,
    sequenceMode: "exemption",
    sequenceCustom: [3],
    cooldownSec: 30,
    inverterCount: 3,
  };
  const blockedGuard = authorityController.getManualWriteGuard({
    scope: "single",
    inverter: 2,
    value: 0,
    operator: "OPERATOR",
  });
  assert.strictEqual(
    blockedGuard.allowed,
    false,
    "Manual control should be blocked for non-exempted inverters while plant cap is enabled.",
  );
  assert(
    /cannot override|not exempted/i.test(String(blockedGuard.message || "")),
    "Blocked manual control should explain that plant cap is active and the inverter is not exempted.",
  );
  const exemptGuard = authorityController.getManualWriteGuard({
    scope: "single",
    inverter: 3,
    value: 0,
    operator: "OPERATOR",
  });
  assert.strictEqual(
    exemptGuard.allowed,
    true,
    "Exempted inverters should remain manually controllable during plant cap monitoring.",
  );
  const plantCapGuard = authorityController.getManualWriteGuard({
    scope: "plant-cap",
    inverter: 2,
    value: 0,
    operator: "PLANT CAP",
  });
  assert.strictEqual(
    plantCapGuard.allowed,
    true,
    "Controller-owned plant-cap commands must bypass the manual-control guard.",
  );

  let manualWritePaused = false;
  const controller = new PlantCapController({
    getLiveData: () => ({}),
    getIpConfig: () => makeIpConfig(),
    getSettings: () => ({
      inverterCount: 3,
      nodeCount: 4,
      plantCapUpperMw: 1.5,
      plantCapLowerMw: 1.0,
      plantCapSequenceMode: "ascending",
      plantCapSequenceCustom: [],
      plantCapCooldownSec: 30,
    }),
    executeWrite: async () => ({ ok: true }),
    broadcast: () => {
      manualWritePaused = true;
    },
  });
  controller.state.enabled = true;
  controller.state.ownedStopped = new Map([
    [2, {
      inverter: 2,
      stoppedAt: nowTs,
      pacBeforeStopKw: 600,
      enabledNodes: 4,
      ratedKw: 997.64,
      dependableKw: 906.92,
    }],
  ]);
  controller.handleManualWrite({
    scope: "single",
    inverter: 2,
    operator: "OPERATOR",
  });
  assert.strictEqual(
    controller.state.enabled,
    false,
    "Manual writes on controller-owned inverters should pause the controller.",
  );
  assert.strictEqual(
    controller.state.reasonCode,
    "manual_override_detected",
    "Manual overrides should leave an explicit pause reason.",
  );
  assert(
    manualWritePaused,
    "Manual overrides should broadcast an updated controller state.",
  );
  assert.strictEqual(
    controller.state.ownedStopped.has(2),
    false,
    "Manual override should clear the stale ownedStopped entry for the overridden inverter.",
  );
}

run()
  .then(() => {
    console.log("plantCapController.test.js: PASS");
  })
  .catch((err) => {
    console.error("plantCapController.test.js: FAIL", err?.stack || err);
    process.exitCode = 1;
  });
