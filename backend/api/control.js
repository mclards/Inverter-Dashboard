"use strict";
const express = require("express");
const router = express.Router();

module.exports = function(controlArbiter, dbManager) {
  // Get active control lock state
  router.get("/status", (req, res) => {
    res.json({ ok: true, ...controlArbiter.getLockStatus() });
  });

  // Explicitly claim control lease
  router.post("/acquire", express.json(), (req, res) => {
    const deviceId = req.headers["x-device-id"] || req.body?.deviceId;
    const operatorName = req.headers["x-operator-name"] || req.body?.operatorName || "Operator";
    const role = req.headers["x-operator-role"] || req.body?.role || "operator";
    const ip = req.ip || req.connection?.remoteAddress;
    const durationSec = req.body?.durationSec || 60;

    const result = controlArbiter.acquireLease({ deviceId, operatorName, role, ip, durationSec });
    if (!result.ok) {
      return res.status(423).json(result);
    }
    dbManager.logAudit({
      action: "control_lease_acquired",
      target: "fleet_control",
      operatorName,
      deviceId,
      ip,
      details: { durationSec, role }
    });
    res.json(result);
  });

  // Release control lease
  router.post("/release", express.json(), (req, res) => {
    const deviceId = req.headers["x-device-id"] || req.body?.deviceId;
    const role = req.headers["x-operator-role"] || req.body?.role || "operator";
    const force = Boolean(req.body?.force);
    const result = controlArbiter.releaseLease({ deviceId, role, force });
    if (!result.ok) {
      return res.status(403).json(result);
    }
    res.json(result);
  });

  return router;
};
