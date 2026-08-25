"use strict";
const express = require("express");
const router = express.Router();

module.exports = function(deviceRegistry) {
  // Register or handshake a device
  router.post("/register", express.json(), (req, res) => {
    const { deviceId, deviceName, operatorName } = req.body || {};
    const ip = req.ip || req.connection?.remoteAddress;
    const result = deviceRegistry.registerDevice({ deviceId, deviceName, operatorName, ip });
    res.json({ ok: true, device: result });
  });

  // Save personalized theme, layout zoom, favorite views
  router.post("/preferences", express.json(), (req, res) => {
    const deviceId = req.headers["x-device-id"] || req.body?.deviceId;
    if (!deviceId) return res.status(400).json({ ok: false, error: "Missing deviceId" });
    const prefs = req.body?.preferences || req.body || {};
    const updated = deviceRegistry.updatePreferences(deviceId, prefs);
    if (!updated) return res.status(404).json({ ok: false, error: "Device not found" });
    res.json({ ok: true, preferences: updated });
  });

  // List all registered controller devices (Admin)
  router.get("/list", (req, res) => {
    const list = deviceRegistry.listDevices();
    res.json({ ok: true, devices: list });
  });

  return router;
};
