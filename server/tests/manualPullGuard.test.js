"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");

process.env.NODE_ENV = "test";
if (!process.env.IM_PORTABLE_DATA_DIR) {
  process.env.IM_PORTABLE_DATA_DIR = fs.mkdtempSync(
    path.join(os.tmpdir(), "adsi-manual-pull-guard-"),
  );
}
if (!process.env.ADSI_SERVER_PORT) process.env.ADSI_SERVER_PORT = "3516";
fs.mkdirSync(path.join(process.env.IM_PORTABLE_DATA_DIR, "config"), {
  recursive: true,
});

const APP_BASE_URL = `http://127.0.0.1:${Number(process.env.ADSI_SERVER_PORT || 3516)}`;
const GATEWAY_PORT = Number(process.env.ADSI_DUMMY_GATEWAY_PORT || 3517);

function pickNonLoopbackIpv4() {
  const nets = os.networkInterfaces();
  for (const entries of Object.values(nets || {})) {
    for (const entry of entries || []) {
      if (!entry || entry.family !== "IPv4" || entry.internal) continue;
      const addr = String(entry.address || "").trim();
      if (addr) return addr;
    }
  }
  return "";
}

const GATEWAY_HOST =
  String(process.env.ADSI_DUMMY_GATEWAY_HOST || pickNonLoopbackIpv4() || "").trim();
const GATEWAY_BASE_URL = `http://${GATEWAY_HOST}:${GATEWAY_PORT}`;

assert.equal(
  Boolean(GATEWAY_HOST),
  true,
  "No non-loopback IPv4 available for manual pull guard test.",
);

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

async function waitFor(fn, timeoutMs = 15000, stepMs = 100) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await fn()) return true;
    await waitMs(stepMs);
  }
  return false;
}

async function fetchJsonResponse(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch (_) {
    parsed = null;
  }
  return {
    ok: response.ok,
    status: response.status,
    body: parsed,
    text,
  };
}

async function fetchJson(url, options = {}) {
  const response = await fetchJsonResponse(url, options);
  if (!response.ok) {
    throw new Error(String(response.body?.error || response.text || `HTTP ${response.status}`));
  }
  return response.body;
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function cleanupStagedMainDb(dbMod) {
  const pending = dbMod.readPendingMainDbReplacement();
  if (!pending?.tempName) return;
  dbMod.discardPendingMainDbReplacement(pending.tempName);
}

async function run() {
  const sockets = new Set();
  const stats = {
    wsOpened: 0,
    chatRequests: 0,
  };
  const mainDbBuffer = Buffer.from("manual-pull-guard-main-db", "utf8");
  const mainDbSha256 = sha256(mainDbBuffer);

  const gatewayServer = http.createServer((req, res) => {
    const requestUrl = new URL(String(req.url || "/"), GATEWAY_BASE_URL);

    if (requestUrl.pathname === "/api/live") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        data: {},
        totals: { pac: 0, kwh: 0 },
        todayEnergy: [],
      }));
      return;
    }

    if (requestUrl.pathname === "/api/energy/today") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([]));
      return;
    }

    if (requestUrl.pathname === "/api/chat/messages") {
      stats.chatRequests += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, rows: [] }));
      return;
    }

    if (requestUrl.pathname === "/api/replication/summary") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        summary: {
          generatedTs: Date.now(),
          mode: "gateway",
          source: "gateway",
          tables: {},
        },
      }));
      return;
    }

    if (requestUrl.pathname === "/api/replication/main-db") {
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(mainDbBuffer.length),
        "x-main-db-size": String(mainDbBuffer.length),
        "x-main-db-mtime": String(Date.parse("2026-03-14T12:00:00.000Z")),
        "x-main-db-sha256": mainDbSha256,
        "x-main-db-cursors": "{}",
      });
      res.end(mainDbBuffer);
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });

  const wss = new WebSocket.Server({ server: gatewayServer, path: "/ws" });
  wss.on("connection", (ws) => {
    stats.wsOpened += 1;
    sockets.add(ws);
    ws.send(JSON.stringify({
      type: "init",
      data: {},
      totals: { pac: 0, kwh: 0 },
      todayEnergy: [],
    }));
    ws.on("close", () => sockets.delete(ws));
  });

  await new Promise((resolve, reject) => {
    gatewayServer.once("error", reject);
    gatewayServer.listen(GATEWAY_PORT, "0.0.0.0", resolve);
  });

  const dbMod = require("../db.js");
  const serverMod = require("../index.js");

  try {
    await fetchJson(`${APP_BASE_URL}/api/settings`).catch(async () => {
      const ready = await waitFor(async () => {
        try {
          await fetchJson(`${APP_BASE_URL}/api/settings`);
          return true;
        } catch (_) {
          return false;
        }
      }, 15000, 200);
      if (!ready) throw new Error("App server did not become ready.");
    });

    await fetchJson(`${APP_BASE_URL}/api/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operationMode: "remote",
        remoteGatewayUrl: GATEWAY_BASE_URL,
        remoteApiToken: "",
      }),
    });

    const remoteReady = await waitFor(
      () => stats.wsOpened >= 1 && stats.chatRequests >= 1,
      15000,
      100,
    );
    assert.equal(remoteReady, true, "remote mode should connect before pull tests");

    const baselinePull = await fetchJson(`${APP_BASE_URL}/api/replication/pull-now`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        background: false,
        includeArchive: false,
      }),
    });
    assert.equal(baselinePull?.ok, true, "manual pull should allow local settings drift");
    assert.equal(
      Boolean(baselinePull?.result?.needsRestart),
      true,
      "successful pull should still stage the gateway main DB",
    );
    cleanupStagedMainDb(dbMod);

    const now = Date.now();
    dbMod.db.prepare(
      `INSERT INTO forecast_dayahead
        (date, ts, slot, time_hms, kwh_inc, kwh_lo, kwh_hi, source, updated_ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "2026-03-14",
      now,
      1,
      "05:00:00",
      1.25,
      1.0,
      1.5,
      "test",
      now,
    );

    const blockedPull = await fetchJsonResponse(`${APP_BASE_URL}/api/replication/pull-now`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        background: true,
        includeArchive: false,
      }),
    });
    assert.equal(blockedPull.status, 409, "newer local data should block background pull");
    assert.equal(
      String(blockedPull.body?.errorCode || ""),
      "LOCAL_NEWER_PUSH_FAILED",
      "blocked pull should return the local-newer error code",
    );
    assert.equal(
      Boolean(blockedPull.body?.canForcePull),
      true,
      "blocked pull should advertise force-pull availability",
    );

    const jobStatusAfterBlock = await fetchJson(`${APP_BASE_URL}/api/replication/job-status`);
    assert.equal(
      Boolean(jobStatusAfterBlock?.job?.running),
      false,
      "blocked background pull should not start a job",
    );
    assert.equal(
      dbMod.readPendingMainDbReplacement(),
      null,
      "blocked pull should not stage a main DB replacement",
    );

    const forcedPull = await fetchJson(`${APP_BASE_URL}/api/replication/pull-now`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        background: false,
        includeArchive: false,
        forcePull: true,
      }),
    });
    assert.equal(forcedPull?.ok, true, "force pull should override the local-newer guard");
    assert.equal(Boolean(forcedPull?.forcePull), true, "force pull response should echo the override");
    cleanupStagedMainDb(dbMod);

    console.log("manualPullGuard.test.js: PASS");
  } finally {
    cleanupStagedMainDb(dbMod);
    try {
      await Promise.race([
        serverMod.shutdownEmbedded(),
        waitMs(4000),
      ]);
    } catch (_) {}
    await Promise.race([
      new Promise((resolve) => {
        for (const ws of sockets) {
          try { ws.terminate(); } catch (_) {}
        }
        wss.close(() => gatewayServer.close(() => resolve()));
      }),
      waitMs(4000),
    ]);
  }
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("manualPullGuard.test.js: FAIL", err?.stack || err);
    process.exit(1);
  });
