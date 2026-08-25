"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, "..", "..", relPath), "utf8");
}

try {
  const backfill = read("scripts/backfill_forecast_history.py");
  const fixOrder = read("scripts/fix_order.py");
  const fixOrder2 = read("scripts/fix_order2.py");
  const fixOrder3 = read("scripts/fix_order3.py");
  const fixSwap = read("scripts/fix_swap.py");
  const updatePricing = read("scripts/update_pricing.py");
  const updateSection02 = read("scripts/update_section02.py");
  const updateComparison = read("scripts/update_comparison.py");

  assert(
    backfill.includes("forecast_variant"),
    "backfill_forecast_history.py should insert forecast_variant to match forecast_run_audit schema",
  );
  assert(
    backfill.includes("_epoch_ms_noon_utc"),
    "backfill_forecast_history.py should compute generated_ts as epoch milliseconds",
  );
  assert(
    backfill.includes("generated_ts"),
    "backfill_forecast_history.py should write generated_ts",
  );

  for (const src of [fixOrder, fixOrder2, fixOrder3, fixSwap]) {
    assert(
      src.includes("from reorder_perpetual_section import main"),
      "legacy fix_* scripts should delegate to shared reorder_perpetual_section.py",
    );
  }

  for (const src of [updatePricing, updateSection02, updateComparison]) {
    assert(
      src.includes("resolve_input_output"),
      "update DOCX scripts should expose safe --input/--output/--in-place path handling",
    );
  }

  console.log("scriptsSourceSanity.test.js: PASS");
} catch (err) {
  console.error("scriptsSourceSanity.test.js: FAIL", err?.stack || err);
  process.exit(1);
}

