"use strict";

const assert = require("assert");
const {
  summarizeCurrentDayEnergyRows,
  mergeCurrentDaySummaryIntoReportSummary,
  buildCurrentDayActualSupplementRows,
} = require("../currentDayEnergyCore");

function run() {
  {
    const summary = summarizeCurrentDayEnergyRows([
      { inverter: 1, total_kwh: 12.345678 },
      { inverter: 2, total_kwh: 7.654321 },
      { inverter: 2, total_kwh: 0 },
    ]);
    assert.equal(summary.inverter_count, 2);
    assert.equal(summary.total_kwh, 19.999999);
    assert.equal(summary.total_mwh, 0.02);
  }

  {
    const merged = mergeCurrentDaySummaryIntoReportSummary(
      {
        date: "2026-03-13",
        week_start: "2026-03-08",
        week_end: "2026-03-14",
        daily: { total_kwh: 90, total_mwh: 0.09, inverter_count: 20 },
        weekly: { total_kwh: 390, total_mwh: 0.39 },
      },
      {
        day: "2026-03-13",
        as_of_ts: 1234567890,
        total_kwh: 100,
        total_mwh: 0.1,
        inverter_count: 21,
      },
      {
        replaceDaily: true,
        replaceWeekly: true,
        baseTodayDailyTotalKwh: 90,
      },
    );
    assert.equal(merged.daily.total_kwh, 100);
    assert.equal(merged.daily.total_mwh, 0.1);
    assert.equal(merged.daily.inverter_count, 21);
    assert.equal(merged.weekly.total_kwh, 400);
    assert.equal(merged.weekly.total_mwh, 0.4);
    assert.equal(merged.current_day.as_of_ts, 1234567890);
  }

  {
    const rows = buildCurrentDayActualSupplementRows({
      startTs: 1_000,
      endTs: 9_000,
      rangeStartTs: 5_000,
      rangeEndTs: 9_000,
      dayStartTs: 1_000,
      dayEndTs: 10_000,
      asOfTs: 8_000,
      authoritativeTotalKwh: 60,
      persistedBeforeRangeKwh: 40,
      persistedRangeKwh: 15,
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].ts, 8_000);
    assert.equal(rows[0].kwh_inc, 5);
  }

  {
    const rows = buildCurrentDayActualSupplementRows({
      startTs: 1_000,
      endTs: 9_000,
      rangeStartTs: 5_000,
      rangeEndTs: 9_000,
      dayStartTs: 1_000,
      dayEndTs: 10_000,
      asOfTs: 8_000,
      authoritativeTotalKwh: 55,
      persistedBeforeRangeKwh: 40,
      persistedRangeKwh: 15,
    });
    assert.equal(rows.length, 0);
  }

  console.log("currentDayEnergyCore.test.js: PASS");
}

run();
