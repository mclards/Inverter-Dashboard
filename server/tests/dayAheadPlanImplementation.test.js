"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

function run() {
  const indexSrc = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  const dbSrc = fs.readFileSync(path.join(__dirname, "..", "db.js"), "utf8");
  const engineSrc = fs.readFileSync(
    path.join(__dirname, "..", "..", "services", "forecast_engine.py"),
    "utf8",
  );

  // Node orchestrator must support exact-date ML generation (not only "tomorrow + N").
  assert(indexSrc.includes("async function generateDayAheadWithMl(dates)"), "ML generator helper must accept explicit dates");
  assert(indexSrc.includes('"--generate-date"'), "ML orchestration missing --generate-date CLI path");
  assert(indexSrc.includes('"--generate-range"'), "ML orchestration missing --generate-range CLI path");

  // Audit writes must use exported statements object.
  assert(indexSrc.includes("stmts.insertForecastRunAudit.run"), "run audit writes should use stmts.insertForecastRunAudit");
  assert(!indexSrc.includes("db.stmts.insertForecastRunAudit"), "obsolete db.stmts audit write path still present");

  // Quality-aware fallback states should be explicit.
  assert(indexSrc.includes('return "wrong_provider"'), "quality assessment missing wrong_provider state");
  assert(indexSrc.includes('return "stale_input"'), "quality assessment missing stale_input state");
  assert(indexSrc.includes('return "missing_audit"'), "quality assessment missing missing_audit state");

  // DB schema should include richer comparison persistence columns.
  assert(dbSrc.includes("include_in_error_memory"), "DB schema missing include_in_error_memory column");
  assert(dbSrc.includes("signed_error_kwh"), "DB schema missing signed_error_kwh column");
  assert(dbSrc.includes("support_weight"), "DB schema missing support_weight column");

  // Python memory correction should use persisted eligible comparison rows.
  assert(engineSrc.includes("include_in_error_memory = 1"), "error memory must read include_in_error_memory rows");
  assert(engineSrc.includes("comparison_quality = 'eligible'"), "error memory must filter by eligible comparison quality");
  assert(engineSrc.includes("usable_for_error_memory"), "error memory must filter usable_for_error_memory slots");

  console.log("dayAheadPlanImplementation.test.js: PASS");
}

run();

