"use strict";
/**
 * telemetry.js — Live Inverter Telemetry & 5-Min Aggregations
 */
const express = require("express");
const http = require("http");
const router = express.Router();

const INVERTER_ENGINE_PORT = Number(process.env.INVERTER_ENGINE_PORT) || 9100;

function fetchInverterEngine(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      hostname: "127.0.0.1",
      port: INVERTER_ENGINE_PORT,
      path,
      timeout: 3000
    }, (res) => {
      let data = "";
      res.on("data", chunk => { data += chunk; });
      res.on("end", () => {
        try {
          resolve({ statusCode: res.statusCode, json: JSON.parse(data) });
        } catch (e) {
          resolve({ statusCode: res.statusCode, raw: data });
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Inverter engine request timed out"));
    });
  });
}

module.exports = function(dbManager, websocketHub) {
  // Live Telemetry (1-second fast path)
  router.get("/live", async (req, res) => {
    try {
      const response = await fetchInverterEngine("/api/live");
      if (response.json) {
        websocketHub.broadcastTelemetry(response.json);
        return res.json(response.json);
      }
    } catch (_) {
      // Fallback: return last known good telemetry from database
    }
    res.json({ ok: true, timestamp: Date.now(), inverters: {}, plant_pac_kw: 0 });
  });

  // 5-Minute Historical Telemetry for Charts
  router.get("/energy/5min", (req, res) => {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    try {
      const rows = dbManager.db.prepare(`
        SELECT * FROM plant_telemetry_5min
         WHERE date = ?
         ORDER BY timestamp_ms ASC
      `).all(date);
      res.json({ ok: true, date, data: rows });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  return router;
};
