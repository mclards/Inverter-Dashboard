"use strict";

const ROW_EPSILON_KWH = 0.0001;
const ACTIVE_PAC_W = 1000;
const STALE_MS = 30000;

function normalizeTodayEnergyRows(rowsRaw) {
  const rows = Array.isArray(rowsRaw) ? rowsRaw : [];
  const map = new Map();
  for (const row of rows) {
    const inverter = Math.floor(Number(row?.inverter || 0));
    const totalKwh = Number(row?.total_kwh);
    if (inverter <= 0 || !Number.isFinite(totalKwh) || totalKwh < 0) continue;
    const prev = Number(map.get(inverter) || 0);
    if (totalKwh > prev) {
      map.set(inverter, Number(totalKwh.toFixed(6)));
    }
  }
  return Array.from(map.entries())
    .map(([inverter, total_kwh]) => ({ inverter, total_kwh }))
    .sort((a, b) => a.inverter - b.inverter);
}

function rowsToMap(rowsRaw) {
  return new Map(
    normalizeTodayEnergyRows(rowsRaw).map((row) => [
      Number(row?.inverter || 0),
      Number(row?.total_kwh || 0),
    ]),
  );
}

function normalizeLivePacByInverter(liveTotalsRaw = {}) {
  const source =
    liveTotalsRaw && typeof liveTotalsRaw === "object" ? liveTotalsRaw : {};
  const out = Object.create(null);
  for (const [key, totals] of Object.entries(source)) {
    const inverter = Math.floor(Number(key || 0));
    const pac = Math.max(0, Number(totals?.pac || 0));
    if (inverter <= 0 || !Number.isFinite(pac)) continue;
    out[inverter] = {
      pac: Number(pac.toFixed(3)),
    };
  }
  return out;
}

function evaluateTodayEnergyHealth({
  pacRows,
  liveTotalsByInv,
  prevState,
  now = Date.now(),
  solarActive = true,
}) {
  const pacMap = rowsToMap(pacRows);
  const livePacMap = normalizeLivePacByInverter(liveTotalsByInv);
  const prevByInv =
    prevState?.byInv && typeof prevState.byInv === "object"
      ? prevState.byInv
      : Object.create(null);
  const invSet = new Set([
    ...pacMap.keys(),
    ...Object.keys(livePacMap).map((key) => Number(key || 0)),
  ]);
  const rows = [];
  const nextByInv = Object.create(null);
  const events = [];
  let activeCount = 0;
  let staleCount = 0;

  for (const inverter of Array.from(invSet).sort((a, b) => a - b)) {
    if (!(inverter > 0)) continue;
    const pacKwh = Math.max(0, Number(pacMap.get(inverter) || 0));
    const livePacW = Math.max(0, Number(livePacMap[inverter]?.pac || 0));
    const prev = prevByInv[inverter] || {};
    const lastPacKwh = Math.max(0, Number(prev.pacKwh || 0));
    const pacAdvanceTs =
      pacKwh > lastPacKwh + ROW_EPSILON_KWH
        ? now
        : Math.max(0, Number(prev.pacAdvanceTs || 0));
    const active = Boolean(solarActive && livePacW >= ACTIVE_PAC_W);
    if (active) activeCount += 1;
    const pacStale =
      active && pacAdvanceTs > 0 && now - pacAdvanceTs > STALE_MS;
    if (pacStale) staleCount += 1;

    nextByInv[inverter] = {
      pacKwh: Number(pacKwh.toFixed(6)),
      selectedKwh: Number(pacKwh.toFixed(6)),
      livePacW: Number(livePacW.toFixed(3)),
      pacAdvanceTs,
      active,
      pacStale,
      source: "pac",
      reasonCode: pacStale ? "pac_stalled" : active ? "healthy" : "inactive",
    };

    if (
      prev.reasonCode !== nextByInv[inverter].reasonCode ||
      Boolean(prev.pacStale) !== pacStale
    ) {
      events.push({
        type: "source_change",
        inverter,
        source: "pac",
        reasonCode: nextByInv[inverter].reasonCode,
        pacStale,
        pacKwh: Number(pacKwh.toFixed(6)),
        livePacW: Number(livePacW.toFixed(3)),
      });
    }

    if (pacKwh > 0) {
      rows.push({
        inverter,
        total_kwh: Number(pacKwh.toFixed(6)),
      });
    }
  }

  let state = "ok";
  let reasonCode = "healthy";
  let reasonText = "Today-energy is derived from PAC x elapsed time.";
  if (activeCount <= 0) {
    state = "idle";
    reasonCode = "inactive";
    reasonText = "Plant PAC is below the active threshold.";
  } else if (staleCount > 0) {
    state = "stale";
    reasonCode = "pac_stalled";
    reasonText = "PAC day-energy stalled while the plant still appears active.";
  }

  const health = {
    state,
    reasonCode,
    reasonText,
    checkedAt: Math.max(0, Number(now || Date.now())),
    activeInverterCount: activeCount,
    fallbackActiveCount: 0,
    staleCount,
    mismatchCount: 0,
    selectedSource: "pac",
  };
  const prevSummary =
    prevState?.summary && typeof prevState.summary === "object"
      ? prevState.summary
      : {};
  if (
    prevSummary.state !== health.state ||
    prevSummary.reasonCode !== health.reasonCode ||
    Number(prevSummary.staleCount || 0) !== health.staleCount
  ) {
    events.push({
      type: "summary_change",
      health,
    });
  }

  return {
    rows,
    health,
    nextState: {
      byInv: nextByInv,
      summary: health,
    },
    events,
  };
}

module.exports = {
  ROW_EPSILON_KWH,
  ACTIVE_PAC_W,
  STALE_MS,
  normalizeTodayEnergyRows,
  evaluateTodayEnergyHealth,
};
