"use strict";
/**
 * controlArbiter.js — Single-Writer Inverter Control Arbitration & Mutex Guard
 *
 * Enforces single-controller access for all destructive / setpoint commands
 * (Active Power %P, Power Factor, Reactive kVAr, Start/Stop, Plant Cap, Compliance Sweeps).
 * Unlimited multi-client telemetry reading is always allowed.
 */

class ControlArbiter {
  constructor({ defaultLeaseSec = 60, onLockChange = null } = {}) {
    this.defaultLeaseMs = defaultLeaseSec * 1000;
    this.onLockChange = onLockChange;
    this.activeLock = null; // { deviceId, operatorName, ip, acquiredTs, expiresTs, reason }
  }

  isLocked() {
    if (!this.activeLock) return false;
    if (Date.now() > this.activeLock.expiresTs) {
      this._releaseInternal("lease_expired");
      return false;
    }
    return true;
  }

  getLockStatus() {
    if (!this.isLocked()) {
      return { locked: false, activeLock: null };
    }
    const remainingSec = Math.max(0, Math.ceil((this.activeLock.expiresTs - Date.now()) / 1000));
    return {
      locked: true,
      remainingSec,
      activeLock: { ...this.activeLock }
    };
  }

  acquireLease({ deviceId, operatorName, role = "operator", ip, reason = "Inverter Control", durationSec = 60 }) {
    const now = Date.now();
    const durationMs = Math.max(1, Math.min(300, Number(durationSec) || 60)) * 1000;
    const isDev = String(role || "").toLowerCase() === "developer";

    // If currently locked by another device
    if (this.isLocked() && this.activeLock.deviceId !== deviceId) {
      // Developer can preemptively take over operator locks
      const lockIsDev = this.activeLock.role === "developer";
      if (!isDev || lockIsDev) {
        const remainingSec = Math.ceil((this.activeLock.expiresTs - now) / 1000);
        return {
          ok: false,
          error: `Inverter controls locked by ${this.activeLock.operatorName || "another operator"} (${this.activeLock.role || "operator"} @ ${this.activeLock.ip}). Lease expires in ${remainingSec}s.`,
          activeLock: this.activeLock,
          remainingSec
        };
      }
    }

    // Grant or renew lease
    this.activeLock = {
      deviceId: String(deviceId || "unknown"),
      operatorName: String(operatorName || "Operator"),
      role: isDev ? "developer" : "operator",
      ip: String(ip || "127.0.0.1"),
      reason: String(reason || "Inverter Control"),
      acquiredTs: this.activeLock?.acquiredTs || now,
      expiresTs: now + durationMs
    };

    if (this.onLockChange) {
      this.onLockChange(this.getLockStatus());
    }

    return {
      ok: true,
      leaseGranted: true,
      activeLock: { ...this.activeLock },
      expiresTs: this.activeLock.expiresTs,
      remainingSec: Math.ceil(durationMs / 1000)
    };
  }

  releaseLease({ deviceId, role = "operator", force = false }) {
    if (!this.activeLock) return { ok: true, released: false };
    const isDev = String(role || "").toLowerCase() === "developer";

    if (this.activeLock.role === "developer" && !isDev) {
      return { ok: false, error: "Cannot override or release an active Developer control session." };
    }

    if (!force && !isDev && this.activeLock.deviceId !== deviceId) {
      return { ok: false, error: "Cannot release lease owned by another device." };
    }
    this._releaseInternal(force || isDev ? "admin_force" : "operator_release");
    return { ok: true, released: true };
  }

  _releaseInternal(reason = "released") {
    const prev = this.activeLock;
    this.activeLock = null;
    if (this.onLockChange && prev) {
      this.onLockChange({ locked: false, activeLock: null, releaseReason: reason });
    }
  }

  middleware() {
    return (req, res, next) => {
      const deviceId = req.headers["x-device-id"] || req.query.deviceId || req.body?.deviceId;
      const operatorName = req.headers["x-operator-name"] || req.query.operatorName || req.body?.operatorName || "Operator";
      const ip = req.ip || req.connection?.remoteAddress || "127.0.0.1";

      if (!deviceId) {
        return res.status(400).json({ ok: false, error: "Missing X-Device-Id header for control action." });
      }

      const leaseResult = this.acquireLease({
        deviceId,
        operatorName,
        ip,
        reason: req.path
      });

      if (!leaseResult.ok) {
        return res.status(423).json({
          ok: false,
          locked: true,
          error: leaseResult.error,
          activeLock: leaseResult.activeLock,
          remainingSec: leaseResult.remainingSec
        });
      }

      req.controlLease = leaseResult;
      next();
    };
  }
}

module.exports = ControlArbiter;
