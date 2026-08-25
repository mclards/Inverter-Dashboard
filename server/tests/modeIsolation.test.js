"use strict";

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");

process.env.NODE_ENV = "test";
if (!process.env.IM_PORTABLE_DATA_DIR) {
  process.env.IM_PORTABLE_DATA_DIR = fs.mkdtempSync(
    path.join(os.tmpdir(), "adsi-mode-isolation-"),
  );
}
if (!process.env.ADSI_SERVER_PORT) process.env.ADSI_SERVER_PORT = "3512";
fs.mkdirSync(path.join(process.env.IM_PORTABLE_DATA_DIR, "config"), {
  recursive: true,
});

const APP_BASE_URL = `http://127.0.0.1:${Number(process.env.ADSI_SERVER_PORT || 3512)}`;
const GATEWAY_PORT = Number(process.env.ADSI_DUMMY_GATEWAY_PORT || 3513);
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

assert.equal(Boolean(GATEWAY_HOST), true, "No non-loopback IPv4 available for mode isolation test.");

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

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch (_) {
    parsed = null;
  }
  if (!response.ok) {
    throw new Error(String(parsed?.error || text || `HTTP ${response.status}`));
  }
  return parsed;
}

async function run() {
  const stats = {
    wsOpened: 0,
    wsClosed: 0,
    chatRequests: 0,
    lastChatRequestTs: 0,
  };
  const sockets = new Set();

  const gatewayServer = http.createServer((req, res) => {
    if (String(req.url || "").startsWith("/api/chat/messages")) {
      stats.chatRequests += 1;
      stats.lastChatRequestTs = Date.now();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, rows: [] }));
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
    ws.on("close", () => {
      stats.wsClosed += 1;
      sockets.delete(ws);
    });
  });

  await new Promise((resolve, reject) => {
    gatewayServer.once("error", reject);
    gatewayServer.listen(GATEWAY_PORT, "0.0.0.0", resolve);
  });
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

    const remoteSettings = await fetchJson(`${APP_BASE_URL}/api/settings`);
    assert.equal(
      String(remoteSettings?.operationMode || "").trim().toLowerCase(),
      "remote",
      "remote mode should persist after remote settings save",
    );

    const remoteReady = await waitFor(
      () => stats.wsOpened >= 1 && stats.chatRequests >= 1,
      15000,
      100,
    );
    if (!remoteReady) {
      const latestSettings = await fetchJson(`${APP_BASE_URL}/api/settings`).catch(() => ({}));
      throw new Error(
        `remote mode should open WS and chat polling | wsOpened=${stats.wsOpened}` +
        ` wsClosed=${stats.wsClosed}` +
        ` chatRequests=${stats.chatRequests}` +
        ` remoteConnected=${Boolean(latestSettings?.remoteConnected)}` +
        ` remoteLastError=${String(latestSettings?.remoteLastError || "")}` +
        ` remoteLastSyncDirection=${String(latestSettings?.remoteLastSyncDirection || "")}`,
      );
    }

    await fetchJson(`${APP_BASE_URL}/api/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operationMode: "gateway" }),
    });

    const gatewayReady = await waitFor(async () => {
      const settings = await fetchJson(`${APP_BASE_URL}/api/settings`);
      return String(settings?.operationMode || "").trim().toLowerCase() === "gateway";
    }, 10000, 150);
    assert.equal(gatewayReady, true, "gateway mode should persist after switch");

    const wsStopped = await waitFor(
      () => stats.wsClosed >= 1 && sockets.size === 0,
      5000,
      100,
    );
    assert.equal(wsStopped, true, "remote live websocket should close after switch to gateway");

    const frozenChatCount = stats.chatRequests;
    await waitMs(6500);
    assert.equal(
      stats.chatRequests,
      frozenChatCount,
      "remote chat polling should stop after switch to gateway",
    );

    console.log("modeIsolation.test.js: PASS");
  } finally {
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
    console.error("modeIsolation.test.js: FAIL", err?.stack || err);
    process.exit(1);
  });
