"use strict";

const assert = require("assert");
const crypto = require("crypto");
const express = require("express");
const expressWs = require("express-ws");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createBrowserAuth } = require("../browserAuth");
const WebSocket = require("ws");

function cookieFrom(response) {
  return String(response.headers.get("set-cookie") || "").split(";", 1)[0];
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "adsi-web-login-hard-"));
  const credentialPath = path.join(tempDir, "operator-credentials.json");
  fs.writeFileSync(
    credentialPath,
    JSON.stringify({
      username: "operator",
      passwordHash: crypto.createHash("sha256").update("operator-pass").digest("hex"),
    }),
  );

  const app = express();
  expressWs(app);
  app.use(express.json());
  const auth = createBrowserAuth({ credentialPath });

  app.use(auth.originGuard);
  auth.registerRoutes(app);
  app.use(auth.pageGuard);

  app.ws("/ws", (ws, req) => {
    const access = auth.authorizeWebSocket(req, "test-remote-bridge-token");
    if (!access.ok) {
      ws.close(Number(access.closeCode || 1008), "Authentication required");
      return;
    }
    ws.send(JSON.stringify({ type: "init", authorizedBy: access.mode }));
  });

  // Developer restricted pages
  const DEVELOPER_PAGES = new Set(["/topology.html", "/global-config.html"]);
  app.use((req, res, next) => {
    const p = String(req.path || "").toLowerCase();
    if (!DEVELOPER_PAGES.has(p)) return next();
    if (auth.isElectronLoopback(req)) return next();
    if (auth.isDeveloperSession(auth.sessionFromRequest(req))) return next();
    return res.status(403).type("text/plain").send("Developer access is required.");
  });

  // Mock static page handlers
  app.get("/login.html", (_req, res) => res.status(200).type("text/html").send("<html>Login Page</html>"));
  app.get("/index.html", (_req, res) => res.status(200).type("text/html").send("<html>Dashboard Index</html>"));
  app.get("/", (_req, res) => res.status(200).type("text/html").send("<html>Dashboard Root</html>"));
  app.get("/css/style.css", (_req, res) => res.status(200).type("text/css").send("/* styles */"));
  app.get("/js/app.js", (_req, res) => res.status(200).type("application/javascript").send("// app js"));
  app.get("/topology.html", (_req, res) => res.status(200).type("text/html").send("<html>Topology Config</html>"));

  const server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  const ELECTRON_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) InverterDashboard/2.8.14 Chrome/120.0.0.0 Electron/30.0.0 Safari/537.36";

  try {
    // 1. Chrome visiting / on localhost without cookie must redirect (302) to /login.html
    const rootRes = await fetch(`${baseUrl}/`, {
      headers: { "user-agent": CHROME_UA, accept: "text/html" },
      redirect: "manual",
    });
    assert.equal(rootRes.status, 302, "Standard browser on localhost must get 302 redirect for root");
    assert.equal(rootRes.headers.get("location"), "/login.html");

    // 2. Chrome visiting /index.html on localhost without cookie must redirect (302) to /login.html
    const indexRes = await fetch(`${baseUrl}/index.html`, {
      headers: { "user-agent": CHROME_UA, accept: "text/html" },
      redirect: "manual",
    });
    assert.equal(indexRes.status, 302, "Standard browser on localhost must get 302 redirect for /index.html");
    assert.equal(indexRes.headers.get("location"), "/login.html");

    // 3. Chrome checking /api/auth/session without cookie must get 401 unauthenticated
    const sessionRes = await fetch(`${baseUrl}/api/auth/session`, {
      headers: { "user-agent": CHROME_UA, accept: "application/json" },
    });
    assert.equal(sessionRes.status, 401, "Unauthenticated browser must receive 401 from /api/auth/session");
    const sessionData = await sessionRes.json();
    assert.equal(sessionData.authenticated, false);

    // 4. Chrome accessing static assets (/css/style.css, /js/app.js, /login.html) without cookie must SUCCEED (200)
    const cssRes = await fetch(`${baseUrl}/css/style.css`, {
      headers: { "user-agent": CHROME_UA },
    });
    assert.equal(cssRes.status, 200, "Static CSS must be accessible without login");

    const jsRes = await fetch(`${baseUrl}/js/app.js`, {
      headers: { "user-agent": CHROME_UA },
    });
    assert.equal(jsRes.status, 200, "Static JS must be accessible without login");

    const loginPageRes = await fetch(`${baseUrl}/login.html`, {
      headers: { "user-agent": CHROME_UA, accept: "text/html" },
    });
    assert.equal(loginPageRes.status, 200, "Login page must be accessible without login");

    // 5. Electron on loopback visiting /index.html is loopback-exempt
    const electronIndexRes = await fetch(`${baseUrl}/index.html`, {
      headers: { "user-agent": ELECTRON_UA, accept: "text/html" },
      redirect: "manual",
    });
    assert.equal(electronIndexRes.status, 200, "Electron shell on loopback accesses /index.html directly");

    // 6. Electron on loopback querying /api/auth/session gets desktop loopback session
    const electronSessRes = await fetch(`${baseUrl}/api/auth/session`, {
      headers: { "user-agent": ELECTRON_UA, accept: "application/json" },
    });
    assert.equal(electronSessRes.status, 200);
    const electronSess = await electronSessRes.json();
    assert.equal(electronSess.authenticated, true);
    assert.equal(electronSess.mode, "loopback");

    // 7. Chrome logging in with valid operator credentials
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "user-agent": CHROME_UA, "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({ username: "operator", password: "operator-pass" }),
    });
    assert.equal(loginRes.status, 200, "Operator login must succeed");
    const opCookie = cookieFrom(loginRes);
    assert.ok(opCookie.includes("adsi_session="), "Must set adsi_session cookie");

    // 8. Chrome with operator cookie accessing /index.html succeeds
    const authedIndexRes = await fetch(`${baseUrl}/index.html`, {
      headers: { "user-agent": CHROME_UA, cookie: opCookie, accept: "text/html" },
      redirect: "manual",
    });
    assert.equal(authedIndexRes.status, 200, "Authenticated browser can view /index.html");

    // 9. Chrome with operator cookie accessing /api/auth/session returns operator role
    const authedSessRes = await fetch(`${baseUrl}/api/auth/session`, {
      headers: { "user-agent": CHROME_UA, cookie: opCookie, accept: "application/json" },
    });
    assert.equal(authedSessRes.status, 200);
    const authedSess = await authedSessRes.json();
    assert.equal(authedSess.authenticated, true);
    assert.equal(authedSess.role, "operator");

    // 10. Chrome with operator cookie trying to access /topology.html gets 403 Forbidden
    const opTopoRes = await fetch(`${baseUrl}/topology.html`, {
      headers: { "user-agent": CHROME_UA, cookie: opCookie, accept: "text/html" },
    });
    assert.equal(opTopoRes.status, 403, "Operator must get 403 on /topology.html");

    // 11. Chrome logging in as devClard with current minute password
    const devPass = `dev${String(new Date().getMinutes()).padStart(2, "0")}`;
    const devLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "user-agent": CHROME_UA, "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({ username: "devClard", password: devPass }),
    });
    assert.equal(devLoginRes.status, 200, "devClard login must succeed");
    const devCookie = cookieFrom(devLoginRes);

    // 12. Chrome with devClard cookie can access /topology.html
    const devTopoRes = await fetch(`${baseUrl}/topology.html`, {
      headers: { "user-agent": CHROME_UA, cookie: devCookie, accept: "text/html" },
    });
    assert.equal(devTopoRes.status, 200, "Developer can access /topology.html");

    // A Remote desktop bridge has no browser cookie. The page guard must let
    // the upgrade reach the route-specific validator, which still requires
    // the exact configured API token.
    const bridgeInit = await new Promise((resolve, reject) => {
      const ws = new WebSocket(baseUrl.replace(/^http/, "ws") + "/ws", {
        headers: { "x-inverter-remote-token": "test-remote-bridge-token" },
      });
      const timer = setTimeout(() => reject(new Error("Remote-token WebSocket timed out")), 3000);
      ws.once("message", (raw) => {
        clearTimeout(timer);
        const value = JSON.parse(String(raw));
        ws.close();
        resolve(value);
      });
      ws.once("error", reject);
    });
    assert.equal(bridgeInit.type, "init");
    assert.equal(bridgeInit.authorizedBy, "remote-token");

    const rejectedCode = await new Promise((resolve, reject) => {
      const ws = new WebSocket(baseUrl.replace(/^http/, "ws") + "/ws", {
        headers: { "x-inverter-remote-token": "wrong-token" },
      });
      const timer = setTimeout(() => reject(new Error("Rejected WebSocket did not close")), 3000);
      ws.once("close", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
      ws.once("error", reject);
    });
    assert.equal(rejectedCode, 1008, "An invalid Remote token must still be rejected");

    // 13. Developer logout revokes session
    const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, {
      method: "POST",
      headers: { "user-agent": CHROME_UA, cookie: devCookie, "content-type": "application/json", origin: baseUrl },
    });
    assert.equal(logoutRes.status, 200, "Logout succeeds");

    // Session is now revoked
    const postLogoutSess = await fetch(`${baseUrl}/api/auth/session`, {
      headers: { "user-agent": CHROME_UA, cookie: devCookie, accept: "application/json" },
    });
    assert.equal(postLogoutSess.status, 401, "Revoked session returns 401");

    console.log("PASS: Web login hardening and Remote WebSocket authorization passed.");
  } finally {
    server.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
