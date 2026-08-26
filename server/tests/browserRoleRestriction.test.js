"use strict";

const assert = require("assert");
const crypto = require("crypto");
const express = require("express");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createBrowserAuth } = require("../browserAuth");

function cookieFrom(response) {
  return String(response.headers.get("set-cookie") || "").split(";", 1)[0];
}

async function login(baseUrl, username, password) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ username, password }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  return { payload, cookie: cookieFrom(response) };
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "adsi-browser-role-"));
  const credentialPath = path.join(tempDir, "operator-credentials.json");
  fs.writeFileSync(credentialPath, JSON.stringify({
    username: "operator",
    passwordHash: crypto.createHash("sha256").update("operator-pass").digest("hex"),
  }));

  const app = express();
  app.use(express.json());
  const auth = createBrowserAuth({
    credentialPath,
    // Electron's Node runner does not permit a synthetic Origin header. Keep
    // the fixture loopback-trusted and inspect the issued signed cookie
    // directly; production non-loopback origin/CSRF checks are covered by
    // browserAuth's existing request tests.
    isDirectLoopbackRequest: () => true,
  });
  app.use(auth.originGuard);
  auth.registerRoutes(app);
  app.use("/api/admin-only", (req, res, next) => {
    const session = auth.sessionFromRequest(req);
    if (!auth.isDeveloperSession(session)) {
      return res.status(403).json({ ok: false, error: "Developer access is required for this operation." });
    }
    return next();
  });
  app.post("/api/admin-only", (_req, res) => res.json({ ok: true }));

  const server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const operator = await login(baseUrl, "operator", "operator-pass");
    assert.equal(operator.payload.role, "operator");
    assert.equal(
      auth.sessionFromRequest({ headers: { cookie: operator.cookie } }).payload.role,
      "operator",
      "operator role must be part of the signed session",
    );
    const operatorAdmin = await fetch(`${baseUrl}/api/admin-only`, {
      method: "POST",
      headers: { cookie: operator.cookie, origin: baseUrl },
    });
    assert.equal(operatorAdmin.status, 403, "operator session must not pass a developer route");

    const devPassword = `dev${String(new Date().getMinutes()).padStart(2, "0")}`;
    const developer = await login(baseUrl, "devclard", devPassword);
    assert.equal(developer.payload.role, "developer");
    assert.equal(
      auth.sessionFromRequest({ headers: { cookie: developer.cookie } }).payload.role,
      "developer",
      "developer role must be part of the signed session",
    );
    const devAdmin = await fetch(`${baseUrl}/api/admin-only`, {
      method: "POST",
      headers: { cookie: developer.cookie, origin: baseUrl },
    });
    assert.equal(devAdmin.status, 200, "signed developer session must pass a developer route");
    console.log("browserRoleRestriction.test.js: passed");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
