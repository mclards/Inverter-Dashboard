"use strict";

function toFiniteNonNegative(value) {
  const num = Number(value || 0);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return num;
}

function summarizeCurrentDayEnergyRows(rowsRaw) {
  const rows = Array.isArray(rowsRaw) ? rowsRaw : [];
  const seen = new Set();
  let totalKwh = 0;

  for (const row of rows) {
    const inverter = Number(row?.inverter || 0);
    if (inverter > 0) seen.add(inverter);
    totalKwh += toFiniteNonNegative(row?.total_kwh);
  }

  return {
    inverter_count: seen.size,
    total_kwh: Number(totalKwh.toFixed(6)),
    total_mwh: Number((totalKwh / 1000).toFixed(6)),
  };
}

function cloneJson(value) {
  if (!value || typeof value !== "object") return null;
  return JSON.parse(JSON.stringify(value));
}

function mergeCurrentDaySummaryIntoReportSummary(
  baseSummaryRaw,
  currentDaySummaryRaw,
  options = {},
) {
  const baseSummary = cloneJson(baseSummaryRaw) || {};
  const currentDaySummary =
    currentDaySummaryRaw && typeof currentDaySummaryRaw === "object"
      ? { ...currentDaySummaryRaw }
      : null;
  if (!currentDaySummary) return baseSummary;

  const replaceDaily = options.replaceDaily === true;
  const replaceWeekly = options.replaceWeekly === true;
  const baseTodayDailyTotalKwh = toFiniteNonNegative(options.baseTodayDailyTotalKwh);

  if (replaceDaily) {
    const daily = baseSummary.daily && typeof baseSummary.daily === "object"
      ? { ...baseSummary.daily }
      : {};
    daily.inverter_count = Number(currentDaySummary.inverter_count || 0);
    daily.total_kwh = Number(currentDaySummary.total_kwh || 0);
    daily.total_mwh = Number(currentDaySummary.total_mwh || 0);
    if (Number(currentDaySummary.as_of_ts || 0) > 0) {
      daily.as_of_ts = Number(currentDaySummary.as_of_ts);
    }
    baseSummary.daily = daily;
  }

  if (replaceWeekly) {
    const weekly = baseSummary.weekly && typeof baseSummary.weekly === "object"
      ? { ...baseSummary.weekly }
      : {};
    const weeklyTotalKwh = Math.max(
      0,
      toFiniteNonNegative(weekly.total_kwh) -
        baseTodayDailyTotalKwh +
        toFiniteNonNegative(currentDaySummary.total_kwh),
    );
    weekly.total_kwh = Number(weeklyTotalKwh.toFixed(6));
    weekly.total_mwh = Number((weeklyTotalKwh / 1000).toFixed(6));
    baseSummary.weekly = weekly;
  }

  baseSummary.current_day = {
    day: String(currentDaySummary.day || ""),
    as_of_ts: Number(currentDaySummary.as_of_ts || 0),
    inverter_count: Number(currentDaySummary.inverter_count || 0),
    total_kwh: Number(currentDaySummary.total_kwh || 0),
    total_mwh: Number(currentDaySummary.total_mwh || 0),
  };

  return baseSummary;
}

function buildCurrentDayActualSupplementRows(options = {}) {
  const rangeStartTs = Number(options.rangeStartTs || options.startTs || 0);
  const rangeEndTs = Number(options.rangeEndTs || options.endTs || 0);
  const dayStartTs = Number(options.dayStartTs || 0);
  const dayEndTs = Number(options.dayEndTs || 0);
  const asOfTs = Number(options.asOfTs || 0);
  const authoritativeTotalKwh = toFiniteNonNegative(options.authoritativeTotalKwh);
  const persistedBeforeRangeKwh = toFiniteNonNegative(options.persistedBeforeRangeKwh);
  const persistedRangeKwh = toFiniteNonNegative(options.persistedRangeKwh);

  const overlapStartTs = Math.max(rangeStartTs, dayStartTs);
  const overlapEndTs = Math.min(
    rangeEndTs,
    dayEndTs,
    asOfTs > 0 ? asOfTs : rangeEndTs,
  );
  if (!(overlapEndTs >= overlapStartTs)) return [];

  const authoritativeRangeKwh = Math.max(
    0,
    authoritativeTotalKwh - persistedBeforeRangeKwh,
  );
  const deltaKwh = authoritativeRangeKwh - persistedRangeKwh;
  if (!(deltaKwh > 0)) return [];

  return [
    {
      ts: Math.max(overlapStartTs, Math.min(asOfTs || overlapEndTs, overlapEndTs)),
      kwh_inc: Number(deltaKwh.toFixed(6)),
    },
  ];
}

module.exports = {
  summarizeCurrentDayEnergyRows,
  mergeCurrentDaySummaryIntoReportSummary,
  buildCurrentDayActualSupplementRows,
};
