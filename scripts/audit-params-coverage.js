"use strict";

// audit-params-coverage.js — measure which inverter_5min_param columns are
// consistently populated vs. NULL/0 across today's solar-window rows.
// Run: node scripts/audit-params-coverage.js [YYYY-MM-DD]

const path = require("path");
const Database = require("better-sqlite3");

const DEFAULT_DB = "C:\\ProgramData\\InverterDashboard\\adsi.db";
const dbPath = process.env.ADSI_DB || DEFAULT_DB;

function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const dateLocal = process.argv[2] || todayLocal();
const db = new Database(dbPath, { readonly: true, fileMustExist: false });

const cols = [
  // base
  "vdc_v", "idc_a", "pdc_w",
  "vac1_v", "vac2_v", "vac3_v",
  "iac1_a", "iac2_a", "iac3_a",
  "temp_c", "pac_w", "cosphi", "freq_hz",
  "inv_alarms", "track_alarms",
  "parce_kwh",
  // slow-poll β
  "qac_var_avg",
  "tempint_c_avg",
  "zpos_kohm_last", "zneg_kohm_last",
  "vpv_n_v_avg", "vpv_p_v_avg",
  "nominal_power_w_last",
  "time_to_connect_s_avg",
  "alarms_inst_32_max", "alarms_maint_32_max",
  "power_reduction_bits_last",
  "analog_in_1_avg", "analog_in_2_avg", "analog_in_3_avg", "analog_in_4_avg",
  "pt100_1_last", "pt100_2_last",
  "inverter_state_raw_last",
];

const total = db
  .prepare(
    `SELECT COUNT(*) AS n FROM inverter_5min_param WHERE date_local = ? AND in_solar_window = 1`,
  )
  .get(dateLocal).n;

console.log(`\nDB: ${dbPath}`);
console.log(`Date: ${dateLocal}  (in_solar_window=1)`);
console.log(`Rows: ${total}\n`);

if (total === 0) {
  console.log("No rows in window — exiting.");
  process.exit(0);
}

const w1 = 32; // col name width
const w2 = 9;  // "non-null %"
const w3 = 9;  // "non-zero %"
console.log(
  `${"column".padEnd(w1)}${"non-NULL".padStart(w2)}${"non-zero".padStart(w3)}  notes`,
);
console.log("-".repeat(w1 + w2 + w3 + 8));

const flagged = [];
for (const col of cols) {
  const nonNull = db
    .prepare(
      `SELECT COUNT(*) AS n FROM inverter_5min_param WHERE date_local = ? AND in_solar_window = 1 AND ${col} IS NOT NULL`,
    )
    .get(dateLocal).n;
  const nonZero = db
    .prepare(
      `SELECT COUNT(*) AS n FROM inverter_5min_param WHERE date_local = ? AND in_solar_window = 1 AND ${col} IS NOT NULL AND ${col} != 0`,
    )
    .get(dateLocal).n;
  const pctNN = ((nonNull / total) * 100).toFixed(1) + "%";
  const pctNZ = ((nonZero / total) * 100).toFixed(1) + "%";
  let note = "";
  if (nonNull === 0) {
    note = "  ⚠ ALWAYS NULL";
    flagged.push(col);
  } else if (nonNull < total * 0.05) {
    note = "  ⚠ <5% populated";
    flagged.push(col);
  } else if (nonZero === 0 && nonNull > 0) {
    note = "  ⚠ NEVER non-zero";
    flagged.push(col);
  }
  console.log(`${col.padEnd(w1)}${pctNN.padStart(w2)}${pctNZ.padStart(w3)}${note}`);
}

console.log(
  "\nLegend: a column flagged as ALWAYS NULL means the persist path or the upstream Python read never produces a value for it.",
);
if (flagged.length === 0) {
  console.log("\nAll columns populated above the 5% threshold — no obvious gaps.");
} else {
  console.log(`\nFlagged columns (${flagged.length}): ${flagged.join(", ")}`);
}

db.close();
