"use strict";

const MAX_SHADOW_AGE_MS = 4 * 60 * 60 * 1000;

function localDateStr(ts = Date.now()) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

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

function mergeTodayEnergyRowsMax(...lists) {
  const merged = new Map();
  for (const list of lists) {
    const rows = normalizeTodayEnergyRows(list);
    for (const row of rows) {
      const inverter = Number(row?.inverter || 0);
      const totalKwh = Number(row?.total_kwh || 0);
      if (inverter <= 0 || !Number.isFinite(totalKwh) || totalKwh < 0) continue;
      const prev = Number(merged.get(inverter) || 0);
      if (totalKwh > prev) {
        merged.set(inverter, Number(totalKwh.toFixed(6)));
      }
    }
  }
  return Array.from(merged.entries())
    .map(([inverter, total_kwh]) => ({ inverter, total_kwh }))
    .sort((a, b) => a.inverter - b.inverter);
}

function todayEnergyRowsEqual(aRaw, bRaw) {
  const a = normalizeTodayEnergyRows(aRaw);
  const b = normalizeTodayEnergyRows(bRaw);
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (Number(a[i]?.inverter || 0) !== Number(b[i]?.inverter || 0)) return false;
    if (Math.abs(Number(a[i]?.total_kwh || 0) - Number(b[i]?.total_kwh || 0)) > 1e-9) return false;
  }
  return true;
}

function applyGatewayCarryRows({ pollerRows, shadowRows, carryByInv, onEvent }) {
  const pollerNorm = normalizeTodayEnergyRows(pollerRows);
  const shadowNorm = normalizeTodayEnergyRows(shadowRows);
  const carry = carryByInv && typeof carryByInv === "object"
    ? carryByInv
    : Object.create(null);
  const emit = typeof onEvent === "function" ? onEvent : null;

  if (!shadowNorm.length) {
    for (const key of Object.keys(carry)) {
      delete carry[key];
    }
    return {
      rows: pollerNorm,
      pollerMap: new Map(
        pollerNorm.map((r) => [Number(r.inverter || 0), Number(r.total_kwh || 0)]),
      ),
    };
  }

  const pollerMap = new Map(
    pollerNorm.map((r) => [Number(r.inverter || 0), Number(r.total_kwh || 0)]),
  );
  const shadowMap = new Map(
    shadowNorm.map((r) => [Number(r.inverter || 0), Number(r.total_kwh || 0)]),
  );
  const invSet = new Set([...pollerMap.keys(), ...shadowMap.keys()]);
  const out = [];

  for (const inv of invSet) {
    if (!Number.isFinite(inv) || inv <= 0) continue;
    const pollerKwh = Math.max(0, Number(pollerMap.get(inv) || 0));
    const shadowKwh = Math.max(0, Number(shadowMap.get(inv) || 0));
    let totalKwh = pollerKwh;

    if (shadowKwh > pollerKwh + 1e-9) {
      const existing = carry[inv];
      if (!existing || Number(existing.shadowBaseKwh || 0) !== shadowKwh) {
        const isNew = !existing;
        carry[inv] = {
          shadowBaseKwh: shadowKwh,
          anchorPollerKwh: pollerKwh,
        };
        if (isNew && emit) {
          emit({
            type: "carry_applied",
            inverter: inv,
            shadowKwh,
            pollerKwh,
            gapKwh: shadowKwh - pollerKwh,
          });
        }
      }
      const carryItem = carry[inv];
      const deltaSinceAnchor = Math.max(0, pollerKwh - Number(carryItem.anchorPollerKwh || 0));
      totalKwh = Math.max(totalKwh, Number(carryItem.shadowBaseKwh || 0) + deltaSinceAnchor);
    } else if (carry[inv]) {
      if (emit) {
        emit({
          type: "carry_removed",
          inverter: inv,
          shadowKwh,
          pollerKwh,
        });
      }
      delete carry[inv];
    }

    if (shadowKwh > totalKwh) totalKwh = shadowKwh;
    out.push({ inverter: inv, total_kwh: Number(totalKwh.toFixed(6)) });
  }

  return {
    rows: out.sort((a, b) => a.inverter - b.inverter),
    pollerMap,
  };
}

function evaluateHandoffProgress({
  handoffMeta,
  carryByInv,
  pollerMap,
  day,
  now = Date.now(),
  maxActiveMs = 0,
}) {
  if (!handoffMeta?.active || String(handoffMeta?.day || "") !== String(day || "")) {
    return { action: "none", elapsedMs: 0, resolvedCount: 0 };
  }

  const startedAt = Number(handoffMeta?.startedAt || 0);
  const elapsedMs = Math.max(0, Number(now || Date.now()) - startedAt);
  const baselines = handoffMeta?.baselines && typeof handoffMeta.baselines === "object"
    ? handoffMeta.baselines
    : Object.create(null);
  const resolvedCount = Object.keys(baselines).length;

  if (Number(maxActiveMs || 0) > 0 && elapsedMs >= Number(maxActiveMs || 0)) {
    return { action: "timeout", elapsedMs, resolvedCount };
  }

  const carryCount = Object.keys(carryByInv || {}).length;
  if (carryCount > 0) return { action: "none", elapsedMs, resolvedCount };

  const allMet = Object.keys(baselines).every((invStr) => {
    const pollerKwh = Number(pollerMap?.get(Number(invStr)) || 0);
    const baselineKwh = Number(baselines[invStr] || 0);
    return pollerKwh >= baselineKwh;
  });
  if (!allMet) return { action: "none", elapsedMs, resolvedCount };

  return { action: "complete", elapsedMs, resolvedCount };
}

module.exports = {
  MAX_SHADOW_AGE_MS,
  localDateStr,
  normalizeTodayEnergyRows,
  mergeTodayEnergyRowsMax,
  todayEnergyRowsEqual,
  applyGatewayCarryRows,
  evaluateHandoffProgress,
};
