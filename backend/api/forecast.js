"use strict";
/**
 * forecast.js — Solar AI Day-Ahead Generation & QA Accuracy Scoring
 */
const express = require("express");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const router = express.Router();

function resolvePython() {
  if (process.platform === "win32") {
    const venv = path.join(__dirname, "..", "..", "venv", "Scripts", "python.exe");
    if (fs.existsSync(venv)) return venv;
    return "python";
  }
  const venvNix = path.join(__dirname, "..", "..", "venv", "bin", "python");
  if (fs.existsSync(venvNix)) return venvNix;
  return "python3";
}

module.exports = function(dbManager) {
  // Trigger Day-Ahead Forecast Generation (1 to 31 days)
  router.post("/generate", express.json(), (req, res) => {
    const days = Math.max(1, Math.min(31, Number(req.body?.dayCount) || 1));
    const py = resolvePython();
    const script = path.join(__dirname, "..", "engines", "forecast", "ForecastCoreService.py");

    const proc = spawn(py, [script, "--generate-days", String(days)], {
      cwd: path.join(__dirname, "..", "engines", "forecast"),
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", d => { stdout += d.toString(); });
    proc.stderr.on("data", d => { stderr += d.toString(); });

    proc.on("exit", (code) => {
      res.json({
        ok: code === 0,
        code,
        days,
        output: stdout,
        error: code !== 0 ? stderr : null
      });
    });
  });

  // Run QA Accuracy Evaluation / Backfill
  router.post("/backfill-qa", express.json(), (req, res) => {
    const days = Math.max(1, Math.min(90, Number(req.body?.days || req.query?.days) || 15));
    const py = resolvePython();
    const script = path.join(__dirname, "..", "engines", "forecast", "ForecastCoreService.py");

    const proc = spawn(py, [script, "--backfill-qa", String(days)], {
      cwd: path.join(__dirname, "..", "engines", "forecast"),
      windowsHide: true
    });

    let stdout = "";
    proc.stdout.on("data", d => { stdout += d.toString(); });
    proc.on("exit", (code) => {
      res.json({ ok: code === 0, days, output: stdout });
    });
  });

  // Fetch QA Comparison Accuracy History
  router.get("/qa-history", (req, res) => {
    try {
      const rows = dbManager.db.prepare(`
        SELECT * FROM forecast_error_compare
         ORDER BY date DESC
         LIMIT 60
      `).all();
      res.json({ ok: true, rows });
    } catch (_) {
      res.json({ ok: true, rows: [] });
    }
  });

  return router;
};
