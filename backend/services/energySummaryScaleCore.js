"use strict";

// Pure helpers for the Energy Summary export's per-inverter scaling math.
//
// Extracted from server/exporter.js so the v2.9.2 clamp interaction (which
// alters `authoritativeKwh` by suppressing spike rows in `energy_5min`) can
// be regression-tested without loading the native better-sqlite3 binding.
//
// Architecture:
//   • rawSubtotalKwh    — sum of per-unit PAC-recomputed day totals
//                         (independent of clamp; recomputed from readings.pac).
//   • authoritativeKwh  — sum of energy_5min.kwh_inc for the day-in-range
//                         (clamp-aware; spike rows are 0).
//   • scale             — apportions authoritativeKwh proportionally across units.
//   • subtotalMwh       — final day-of-inverter total. When authoritativeKwh > 0
//                         it is forced to `authoritativeKwh / 1000` (so per-unit
//                         rounding errors don't affect the day total).
//
// The behaviour to preserve, in priority order:
//   1. authoritativeKwh > 0  → day total = authoritativeKwh / 1000 (hard rule).
//   2. authoritativeKwh = 0 and rawSubtotalKwh > 0 → fall back to scaled subtotal
//      (recompute path acts as safety net when energy_5min is empty).
//   3. Both = 0 → returns subtotalMwh = 0 and the inverter is skipped upstream.

function computeInverterScale(authoritativeKwh, rawSubtotalKwh) {
  const auth = Math.max(0, Number(authoritativeKwh) || 0);
  const raw = Math.max(0, Number(rawSubtotalKwh) || 0);
  if (auth > 0 && raw > 0) return auth / raw;
  return 1;
}

function applyInverterScale({
  detailRows,
  authoritativeKwh,
  rawSubtotalKwh,
}) {
  const auth = Math.max(0, Number(authoritativeKwh) || 0);
  const raw = Math.max(0, Number(rawSubtotalKwh) || 0);
  const scale = computeInverterScale(auth, raw);

  let scaledSubtotalMwh = 0;
  let dayEtotalKwh = 0;
  let dayParceKwh = 0;
  let dayEtotalUnitsValid = 0;   // count of units that contributed to the sum
  let dayParceUnitsValid = 0;
  let dayEtotalUnitsTotal = 0;
  let dayParceUnitsTotal = 0;

  const scaledRows = (Array.isArray(detailRows) ? detailRows : []).map((row) => {
    const rawEnergyKwh = Math.max(0, Number(row?.rawEnergyKwh) || 0);
    const energyMwh = (rawEnergyKwh * scale) / 1000;
    scaledSubtotalMwh += energyMwh;

    const eValid = Number.isFinite(row?.rawEtotalKwh);
    const pValid = Number.isFinite(row?.rawParceKwh);
    dayEtotalUnitsTotal += 1;
    dayParceUnitsTotal += 1;
    if (eValid) {
      dayEtotalKwh += Number(row.rawEtotalKwh);
      dayEtotalUnitsValid += 1;
    }
    if (pValid) {
      dayParceKwh += Number(row.rawParceKwh);
      dayParceUnitsValid += 1;
    }

    return {
      ...row,
      Total_MWh: Number(energyMwh.toFixed(6)),
      Etotal_MWh: eValid ? Number((Number(row.rawEtotalKwh) / 1000).toFixed(6)) : NaN,
      ParcE_MWh:  pValid ? Number((Number(row.rawParceKwh)  / 1000).toFixed(6)) : NaN,
    };
  });

  // Hard rule: when energy_5min has data, the day total is the SUM directly
  // (not the scaled per-unit sum). This ensures the day total exactly matches
  // the authoritative source even after rounding the per-unit values.
  const subtotalMwh = auth > 0 ? auth / 1000 : scaledSubtotalMwh;

  return {
    scale,
    scaledRows,
    subtotalMwh: Number(subtotalMwh.toFixed(6)),
    dayEtotalKwh,
    dayParceKwh,
    // v2.10.x — graceful degradation. Day-total Etotal/parcE used to NaN-
    // propagate when ANY single unit was invalid; that left an entire day's
    // export with both HW columns blank because of one bad node. We now sum
    // whatever IS valid and surface the partial-coverage status separately
    // so the operator can spot incomplete days at a glance without losing
    // the sum that DID compute.
    dayEtotalValid: dayEtotalUnitsTotal > 0 && dayEtotalUnitsValid > 0,
    dayParceValid:  dayParceUnitsTotal  > 0 && dayParceUnitsValid  > 0,
    dayEtotalCoverage: { valid: dayEtotalUnitsValid, total: dayEtotalUnitsTotal },
    dayParceCoverage:  { valid: dayParceUnitsValid,  total: dayParceUnitsTotal  },
  };
}

module.exports = {
  computeInverterScale,
  applyInverterScale,
};
