"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");

const tempPortableRoot = path.join(
  __dirname,
  "..",
  "..",
  ".tmp",
  "xlsx-export-style-test",
);
fs.mkdirSync(tempPortableRoot, { recursive: true });
process.env.IM_PORTABLE_DATA_DIR = tempPortableRoot;
process.env.ADSI_PORTABLE_DATA_DIR = tempPortableRoot;

const {
  writeEnergySummaryExport,
  exportForecastActual,
  exportSolcastPreview,
} = require("../exporter");
const { closeDb, setSetting } = require("../db");

const COLORS = {
  header: "FF24435C",
  highlight: "FFFFF2CC",
  summaryMetric: "FFEAF1F8",
  averageHeader: "FFF4B183",
  averageSide: "FFFDEBD3",
  averageCell: "FFFFF1DF",
};

async function readWorkbook(filePath) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  return wb;
}

async function run() {
  const exportRoot = path.join(tempPortableRoot, "exports");
  setSetting("csvSavePath", exportRoot);

  const energyPath = await writeEnergySummaryExport({
    startTs: new Date("2026-03-14T05:00:00").getTime(),
    endTs: new Date("2026-03-14T18:00:00").getTime(),
    inverter: "all",
    format: "xlsx",
    rows: [
      {
        Date: "2026-03-14",
        Inverter_Number: 1,
        Node_Number: 1,
        First_Seen: "05:00:00",
        Last_Seen: "18:00:00",
        Peak_Pac_kW: 9.876,
        Total_MWh: 12.345678,
      },
      {
        Date: "2026-03-14",
        Inverter_Number: "DAY TOTAL",
        Node_Number: "",
        First_Seen: "",
        Last_Seen: "",
        Peak_Pac_kW: "",
        Total_MWh: 12.345678,
      },
    ],
  });
  const energyWb = await readWorkbook(energyPath);
  const energyWs = energyWb.getWorksheet("Export");
  assert(energyWs, "Energy export worksheet should exist.");
  assert.strictEqual(
    energyWs.getCell("A1").fill?.fgColor?.argb,
    COLORS.header,
    "Generic export header should use the shared dark header fill.",
  );
  assert.strictEqual(
    energyWs.getCell("A3").fill?.fgColor?.argb,
    COLORS.highlight,
    "DAY TOTAL rows should be highlighted in generic XLSX exports.",
  );
  assert(
    Number(energyWs.getColumn(1).width || 0) >= 10,
    "Generic XLSX columns should size to fit their content.",
  );

  const standardPath = await exportForecastActual({
    startTs: new Date("2026-03-14T05:00:00").getTime(),
    endTs: new Date("2026-03-14T18:00:00").getTime(),
    resolution: "5min",
    format: "xlsx",
    exportFormat: "standard",
  });
  const standardWb = await readWorkbook(standardPath);
  const summaryWs = standardWb.getWorksheet("Summary");
  const intervalsWs = standardWb.getWorksheet("Intervals");
  assert(summaryWs, "Standard forecast export should include a Summary sheet.");
  assert(intervalsWs, "Standard forecast export should include an Intervals sheet.");
  assert.strictEqual(
    summaryWs.getCell("A1").fill?.fgColor?.argb,
    COLORS.header,
    "Summary headers should use the shared dark header fill.",
  );
  assert.strictEqual(
    summaryWs.getCell("A2").fill?.fgColor?.argb,
    COLORS.summaryMetric,
    "Summary metric cells should use the summary metric fill.",
  );
  assert.strictEqual(
    intervalsWs.getCell("A1").fill?.fgColor?.argb,
    COLORS.header,
    "Standard forecast data headers should use the shared dark header fill.",
  );

  const averagePath = await exportSolcastPreview({
    rawRows: [
      {
        date: "2026-03-14",
        time: "05:05",
        forecastMw: 9.876,
        forecastMwh: 0.823,
      },
    ],
    rows: [],
    startDay: "2026-03-14",
    endDay: "2026-03-14",
    resolution: "PT5M",
    exportFormat: "average-table",
    format: "xlsx",
  });
  const averageWb = await readWorkbook(averagePath);
  const averageWs = averageWb.worksheets[0];
  assert(averageWs, "Average-table forecast export should contain a worksheet.");
  assert.strictEqual(
    averageWs.getCell("A1").fill?.fgColor?.argb,
    COLORS.averageHeader,
    "Average-table headers should keep the dedicated average-table header fill.",
  );
  assert.strictEqual(
    averageWs.getCell("A3").fill?.fgColor?.argb,
    COLORS.averageSide,
    "Average-table hour labels should use the side-column fill.",
  );
  assert.strictEqual(
    averageWs.getCell("N3").fill?.fgColor?.argb,
    COLORS.averageCell,
    "Average-table average column should use the dedicated average fill.",
  );
}

run()
  .then(() => {
    console.log("xlsxExportStyling.test.js: PASS");
  })
  .catch((err) => {
    console.error("xlsxExportStyling.test.js: FAIL", err?.stack || err);
    process.exitCode = 1;
  })
  .finally(() => {
    try {
      closeDb();
    } catch {}
    try {
      fs.rmSync(tempPortableRoot, { recursive: true, force: true });
    } catch {}
  });
