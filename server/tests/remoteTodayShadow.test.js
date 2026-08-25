"use strict";

const {
  normalizeTodayEnergyRows,
  applyGatewayCarryRows,
} = require("../mwhHandoffCore");

let passed = 0;
let failed = 0;

function assert(condition, desc, detail = "") {
  if (condition) {
    console.log(`  [PASS] ${desc}`);
    passed += 1;
    return;
  }
  console.error(`  [FAIL] ${desc}${detail ? ` - ${detail}` : ""}`);
  failed += 1;
}

function kwhFor(rows, inverter) {
  const match = (rows || []).find((row) => Number(row?.inverter || 0) === Number(inverter || 0));
  return Number(match?.total_kwh || 0);
}

function buildRemoteDisplayedRows({
  currentSourceKey = "",
  shadowSourceKey = "",
  shadowRows = [],
  gatewayRows = [],
  liveRows = [],
} = {}) {
  const authoritativeRows = normalizeTodayEnergyRows(gatewayRows);
  const fallbackRows =
    authoritativeRows.length > 0
      ? authoritativeRows
      : String(currentSourceKey || "").trim() &&
          String(shadowSourceKey || "").trim() === String(currentSourceKey || "").trim()
        ? normalizeTodayEnergyRows(shadowRows)
        : [];
  const liveTodayRows = normalizeTodayEnergyRows(liveRows);
  if (!fallbackRows.length) return liveTodayRows;
  return applyGatewayCarryRows({
    pollerRows: liveTodayRows,
    shadowRows: fallbackRows,
    carryByInv: Object.create(null),
  }).rows;
}

function buildGatewayRestartRows({ shadowRows = [], pollerRows = [] } = {}) {
  return applyGatewayCarryRows({
    pollerRows: normalizeTodayEnergyRows(pollerRows),
    shadowRows: normalizeTodayEnergyRows(shadowRows),
    carryByInv: Object.create(null),
  }).rows;
}

const SOURCE_A = "http://gateway-a:9000";
const SOURCE_B = "http://gateway-b:9000";

console.log("\n-- Scenario A: Fresh gateway totals beat stale local shadow --");
{
  const rows = buildRemoteDisplayedRows({
    currentSourceKey: SOURCE_A,
    shadowSourceKey: SOURCE_A,
    shadowRows: [{ inverter: 1, total_kwh: 111.712 }],
    gatewayRows: [{ inverter: 1, total_kwh: 67.721144 }],
    liveRows: [],
  });
  const total = kwhFor(rows, 1);
  assert(
    Math.abs(total - 67.721144) < 1e-6,
    "remote display uses the fresh gateway row, not the inflated shadow",
    `got ${total}`,
  );
}

console.log("\n-- Scenario B: Same-source shadow is only a fallback until gateway rows arrive --");
{
  const rows = buildRemoteDisplayedRows({
    currentSourceKey: SOURCE_A,
    shadowSourceKey: SOURCE_A,
    shadowRows: [{ inverter: 1, total_kwh: 67.721144 }],
    gatewayRows: [],
    liveRows: [{ inverter: 1, total_kwh: 68.031144 }],
  });
  const total = kwhFor(rows, 1);
  assert(
    Math.abs(total - 68.031144) < 1e-6,
    "shadow fallback carries forward live increments while the gateway snapshot is missing",
    `got ${total}`,
  );
}

console.log("\n-- Scenario C: Cross-gateway shadow is ignored --");
{
  const rows = buildRemoteDisplayedRows({
    currentSourceKey: SOURCE_B,
    shadowSourceKey: SOURCE_A,
    shadowRows: [{ inverter: 1, total_kwh: 111.712 }],
    gatewayRows: [],
    liveRows: [],
  });
  assert(
    rows.length === 0,
    "remote display does not reuse a shadow captured from another gateway",
    `rows=${JSON.stringify(rows)}`,
  );
}

console.log("\n-- Scenario D: Gateway handoff captures the current remote display total --");
{
  const displayedRows = buildRemoteDisplayedRows({
    currentSourceKey: SOURCE_A,
    shadowSourceKey: SOURCE_A,
    shadowRows: [{ inverter: 1, total_kwh: 67.721144 }],
    gatewayRows: [{ inverter: 1, total_kwh: 67.721144 }],
    liveRows: [{ inverter: 1, total_kwh: 68.031144 }],
  });
  const capturedBaseline = kwhFor(displayedRows, 1);
  assert(
    Math.abs(capturedBaseline - 68.031144) < 1e-6,
    "handoff baseline uses the current remote display state, not the older gateway snapshot",
    `got ${capturedBaseline}`,
  );
}

console.log("\n-- Scenario E: Preserved shadow bridges Gateway mode after standby restart --");
{
  const rows = buildGatewayRestartRows({
    shadowRows: [{ inverter: 1, total_kwh: 67.721144 }],
    pollerRows: [],
  });
  const total = kwhFor(rows, 1);
  assert(
    Math.abs(total - 67.721144) < 1e-6,
    "gateway restart still serves the preserved gateway total before the local poller catches up",
    `got ${total}`,
  );
}

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
