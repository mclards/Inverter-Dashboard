"use strict";
/**
 * auth.js — Authentication Router for Inverter Dashboard 2.0
 * Fixed Roles:
 * 1. Developer: devClard / dev<MM> (Current minute digits with +-1 min drift tolerance)
 * 2. Operator: admin / 1234 (Configurable via credentials.json)
 */

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function timingSafeStringEqual(a, b) {
  const bufA = crypto.createHash("sha256").update(String(a || ""), "utf8").digest();
  const bufB = crypto.createHash("sha256").update(String(b || ""), "utf8").digest();
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = function createAuthRouter(dbManager) {
  const router = express.Router();
  const credPath = path.join(dbManager.paths.authDir, "credentials.json");

  function getOperatorCredentials() {
    try {
      if (fs.existsSync(credPath)) {
        const raw = JSON.parse(fs.readFileSync(credPath, "utf8"));
        if (raw.username && raw.passwordHash) {
          return { username: raw.username, passwordHash: raw.passwordHash };
        }
      }
    } catch (_) {}
    const defaultHash = crypto.createHash("sha256").update("1234", "utf8").digest("hex");
    return { username: "admin", passwordHash: defaultHash };
  }

  function saveOperatorCredentials(username, newPassword) {
    const passwordHash = crypto.createHash("sha256").update(String(newPassword || ""), "utf8").digest("hex");
    const payload = { username: String(username || "admin").trim(), passwordHash, updatedAt: new Date().toISOString() };
    fs.mkdirSync(path.dirname(credPath), { recursive: true });
    fs.writeFileSync(credPath, JSON.stringify(payload, null, 2), "utf8");
  }

  function verifyLogin(username, password) {
    const trimmedUser = String(username || "").trim();
    const rawPass = String(password || "");

    // ── 1. Developer Role (devClard / dev<MM>) ───────────────────────────────
    if (timingSafeStringEqual(trimmedUser, "devClard")) {
      const now = new Date();
      const currentMin = now.getMinutes();
      const validMinutes = [
        currentMin,
        (currentMin + 59) % 60,
        (currentMin + 1) % 60
      ];
      const isDevPassValid = validMinutes.some((min) => {
        const minStr = String(min).padStart(2, "0");
        return timingSafeStringEqual(rawPass, `dev${minStr}`);
      });

      if (isDevPassValid) {
        return { ok: true, role: "developer", username: "devClard" };
      }
      return { ok: false, error: "Invalid developer credentials or expired minute code." };
    }

    // ── 2. Operator Role (admin / 1234 or configured) ────────────────────────
    const op = getOperatorCredentials();
    const suppliedHash = crypto.createHash("sha256").update(rawPass, "utf8").digest("hex");
    const userOk = timingSafeStringEqual(trimmedUser, op.username);
    const passOk = timingSafeStringEqual(suppliedHash, op.passwordHash);

    if (userOk && passOk) {
      return { ok: true, role: "operator", username: op.username };
    }

    return { ok: false, error: "Invalid username or password." };
  }

  router.post("/login", (req, res) => {
    const { username, password } = req.body || {};
    const authResult = verifyLogin(username, password);

    if (!authResult.ok) {
      return res.status(401).json({ ok: false, error: authResult.error });
    }

    const tokenPayload = {
      sub: authResult.username,
      role: authResult.role,
      iat: Date.now(),
      exp: Date.now() + 24 * 60 * 60 * 1000
    };
    const token = Buffer.from(JSON.stringify(tokenPayload)).toString("base64url");

    res.cookie("adsi_session", token, {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 24 * 60 * 60 * 1000
    });

    res.json({
      ok: true,
      username: authResult.username,
      role: authResult.role,
      token,
      message: `Signed in as ${authResult.role} (${authResult.username})`
    });
  });

  router.get("/session", (req, res) => {
    res.json({ ok: true, authenticated: true });
  });

  router.post("/change", (req, res) => {
    const { authKey, newUsername, newPassword } = req.body || {};
    // Authorization key verification for operator password change
    const op = getOperatorCredentials();
    const keyOk = timingSafeStringEqual(authKey, "1234") || 
                  timingSafeStringEqual(crypto.createHash("sha256").update(String(authKey || "")).digest("hex"), op.passwordHash);

    if (!keyOk) {
      return res.status(403).json({ ok: false, error: "Invalid authorization key." });
    }

    if (timingSafeStringEqual(newUsername, "devClard")) {
      return res.status(400).json({ ok: false, error: "The Developer role credentials are fixed and cannot be modified." });
    }

    saveOperatorCredentials(newUsername, newPassword);
    res.json({ ok: true, message: "Operator credentials successfully updated." });
  });

  router.post("/logout", (req, res) => {
    res.clearCookie("adsi_session");
    res.json({ ok: true, message: "Signed out successfully." });
  });

  return router;
};
