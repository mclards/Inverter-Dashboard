"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

function run() {
  const indexSrc = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  const engineSrc = fs.readFileSync(path.join(__dirname, "..", "..", "services", "forecast_engine.py"), "utf8");

  // 1. Assert shared orchestrator exists
  assert(indexSrc.includes("async function runDayAheadGenerationPlan({"), "runDayAheadGenerationPlan function is missing");
  // 2. Assert manual route uses the shared orchestrator
  assert(indexSrc.includes('trigger: "manual_api"'), "Manual route does not use trigger pattern");
  assert(!indexSrc.includes('providerOrder = providerOrder.filter((p) => p !== "ml_local");\n    if (!providerOrder.length) {\n      return res.status(400)'), "Manual route still contains old provider logic");
  // 3. Assert fallback cron uses the shared orchestrator
  assert(indexSrc.includes('trigger: "node_fallback"'), "Fallback cron does not use trigger pattern");
  assert(!indexSrc.includes('const result = await generateDayAheadWithMl(1);'), "Fallback cron still hardcodes ML generation");
  // 4. Assert internal auto generation route exists
  assert(indexSrc.includes('app.post("/api/internal/forecast/generate-auto"'), "Internal auto-generation route is missing");

  // 5. Assert Python scheduler uses HTTP delegation
  assert(engineSrc.includes('def _delegate_run_dayahead(target_date: date, trigger: str = "auto_service") -> dict | None:'), "Python missing delegation helper");
  assert(engineSrc.includes('url = f"http://127.0.0.1:{port}/api/internal/forecast/generate-auto"'), "Python not targeting correct internal endpoint");
  assert(engineSrc.includes('requests.post(url'), "Python not issuing HTTP POST request");

  console.log("forecastProviderParity.test.js: PASS");
}

run();
