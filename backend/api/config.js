"use strict";
const express = require("express");
const os = require("os");
const fs = require("fs");
const path = require("path");
const router = express.Router();

function getConnectUrls(port = 3500) {
  const urls = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family === "IPv4" && !ni.internal) {
        const isTailscale = ni.address.startsWith("100.");
        urls.push({
          label: isTailscale ? "Tailscale Mesh" : `LAN (${name})`,
          url: `http://${ni.address}:${port}`,
          ip: ni.address,
          tailscale: isTailscale
        });
      }
    }
  }
  urls.push({
    label: "Local Loopback",
    url: `http://127.0.0.1:${port}`,
    ip: "127.0.0.1",
    local: true
  });
  // Sort Tailscale first, then LAN, then Local
  urls.sort((a, b) => Number(!!b.tailscale) - Number(!!a.tailscale) || Number(!!a.local) - Number(!!b.local));
  return urls;
}

module.exports = function(dbManager) {
  // Get reachable connect URLs for other devices
  router.get("/connect-urls", (req, res) => {
    const port = Number(process.env.PORT) || 3500;
    res.json({ ok: true, port, urls: getConnectUrls(port) });
  });

  // Get Inverter IP & Topology Configuration
  router.get("/ipconfig", (req, res) => {
    const ipconfigFile = path.join(dbManager.paths.configDir, "ipconfig.json");
    if (!fs.existsSync(ipconfigFile)) {
      return res.json({ ok: true, config: {} });
    }
    try {
      const data = JSON.parse(fs.readFileSync(ipconfigFile, "utf8"));
      res.json({ ok: true, config: data });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Save Inverter IP & Topology Configuration (Server Authoritative)
  router.post("/ipconfig", express.json(), (req, res) => {
    const ipconfigFile = path.join(dbManager.paths.configDir, "ipconfig.json");
    const deviceId = req.headers["x-device-id"] || "";
    const operatorName = req.headers["x-operator-name"] || "Operator";
    const ip = req.ip || req.connection?.remoteAddress;

    try {
      const data = req.body || {};
      fs.writeFileSync(ipconfigFile, JSON.stringify(data, null, 2), "utf8");

      dbManager.logAudit({
        action: "ipconfig_updated",
        target: "plant_topology",
        operatorName,
        deviceId,
        ip,
        details: { invertersCount: data.inverters?.length || 0 }
      });

      res.json({ ok: true, message: "IP Configuration saved successfully." });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Get Server Settings
  router.get("/settings", (req, res) => {
    const rows = dbManager.db.prepare(`SELECT key, value FROM settings`).all();
    const settings = {};
    rows.forEach(r => { settings[r.key] = r.value; });
    res.json({ ok: true, settings });
  });

  // Save Server Settings
  router.post("/settings", express.json(), (req, res) => {
    const updates = req.body || {};
    const deviceId = req.headers["x-device-id"] || "";
    const operatorName = req.headers["x-operator-name"] || "Operator";
    const ip = req.ip || req.connection?.remoteAddress;

    for (const [k, v] of Object.entries(updates)) {
      dbManager.setSetting(k, v);
    }

    dbManager.logAudit({
      action: "settings_updated",
      target: "system_settings",
      operatorName,
      deviceId,
      ip,
      details: updates
    });

    res.json({ ok: true, message: "Settings saved successfully." });
  });

  return router;
};
