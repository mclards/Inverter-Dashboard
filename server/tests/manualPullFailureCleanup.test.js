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
    path.join(os.tmpdir(), "adsi-manual-pull-fail-cleanup-"),
  );
}
if (!process.env.ADSI_SERVER_PORT) process.env.ADSI_SERVER_PORT = "3518";
fs.mkdirSync(path.join(process.env.IM_PORTABLE_DATA_DIR, "config"), {
  recursive: true,
});

const APP_BASE_URL = `http://127.0.0.1:${Number(process.env.ADSI_SERVER_PORT || 3518)}`;
const GATEWAY_PORT = Number(process.env.ADSI_DUMMY_GATEWAY_PORT || 3519);

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
  "No non-loopback IPv4 available for manual pull failure cleanup test.",
);

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

async function waitFor(fn, timeoutMs = 20000, stepMs = 100) {
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

function readJsonFile(filePath, fallbackValue) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_) {
    return fallbackValue;
  }
}

function listTempDownloads(dirPath) {
  try {
    return fs
      .readdirSync(dirPath, { withFileTypes: true })
      .filter((entry) =>
        entry.isFile() &&
        /\.download-\d+\.tmp$/i.test(entry.name),
      )
      .map((entry) => entry.name)
      .sort();
  } catch (_) {
    return [];
  }
}

function streamBufferSlowly(req, res, buffer, stats, key, options = {}) {
  const chunkSize = Math.max(1, Number(options.chunkSize || 32768));
  const delayMs = Math.max(1, Number(options.delayMs || 40));
  let offset = 0;
  let finished = false;
  let timer = null;

  stats.activeStreams += 1;
  stats.activeKeys.add(key);

  const cleanup = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!stats.activeKeys.delete(key)) return;
    stats.activeStreams = Math.max(0, stats.activeStreams - 1);
  };

  const scheduleNext = () => {
    timer = setTimeout(() => {
      if (finished || res.destroyed) return;
      const nextOffset = Math.min(buffer.length, offset + chunkSize);
      const chunk = buffer.subarray(offset, nextOffset);
      offset = nextOffset;
      if (chunk.length > 0) res.write(chunk);
      if (offset >= buffer.length) {
        finished = true;
        res.end();
        cleanup();
        return;
      }
      scheduleNext();
    }, delayMs);
  };

  req.on("aborted", cleanup);
  res.on("close", cleanup);
  res.on("error", cleanup);

  scheduleNext();
}

async function run() {
  const sockets = new Set();
  const stats = {
    wsOpened: 0,
    chatRequests: 0,
    activeStreams: 0,
    activeKeys: new Set(),
    secondArchiveStarted: false,
  };

  const mainDbBuffer = Buffer.from("manual-pull-failure-cleanup-main-db", "utf8");
  const mainDbSha256 = sha256(mainDbBuffer);
  const archiveBuffers = {
    "2026-01.db": Buffer.alloc(64 * 1024, 0x31),
    "2026-02.db": Buffer.alloc(384 * 1024, 0x32),
  };
  const archiveMeta = [
    {
      name: "2026-01.db",
      size: archiveBuffers["2026-01.db"].length,
      mtimeMs: Date.parse("2026-01-31T12:00:00.000Z"),
      sha256: sha256(archiveBuffers["2026-01.db"]),
    },
    {
      name: "2026-02.db",
      size: archiveBuffers["2026-02.db"].length,
      mtimeMs: Date.parse("2026-02-28T12:00:00.000Z"),
      sha256: sha256(Buffer.from("intentionally-wrong-archive-hash", "utf8")),
    },
  ];

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
      res.end(JSON.stringify([{ inverter: 1, total_kwh: 0.123 }]));
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

    if (requestUrl.pathname === "/api/replication/archive-manifest") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, manifest: archiveMeta }));
      return;
    }

    if (requestUrl.pathname === "/api/replication/archive-download") {
      const name = String(requestUrl.searchParams.get("file") || "");
      const fileMeta = archiveMeta.find((entry) => entry.name === name);
      if (!fileMeta) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Archive file not found." }));
        return;
      }
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(fileMeta.size),
        "x-archive-size": String(fileMeta.size),
        "x-archive-mtime": String(fileMeta.mtimeMs),
        "x-archive-sha256": fileMeta.sha256,
      });
      if (name === "2026-02.db") {
        stats.secondArchiveStarted = true;
        streamBufferSlowly(
          req,
          res,
          archiveBuffers[name],
          stats,
          `archive:${name}`,
          { chunkSize: 32768, delayMs: 45 },
        );
        return;
      }
      res.end(archiveBuffers[name]);
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
  const mainPendingPath = path.join(dbMod.DATA_DIR, ".pending-main-db-replacement.json");
  const archivePendingPath = path.join(
    dbMod.ARCHIVE_DIR,
    ".pending-archive-replacements.json",
  );

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
    assert.equal(remoteReady, true, "remote mode should connect before cleanup test");

    const started = await fetchJson(`${APP_BASE_URL}/api/replication/pull-now`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        background: true,
        includeArchive: true,
        forcePull: true,
      }),
    });
    assert.equal(Boolean(started?.job?.running), true, "background pull should start");

    // v2.8.9 fix (2026-04-15): the pull orchestrator now pulls archives FIRST
    // (see `runManualPullSync` in server/index.js — "Step 1 — Pull archive DB
    // files first").  When archive 2026-02 fails its SHA check the whole pull
    // aborts before the main DB is ever downloaded, so the pending-main
    // replacement file is never written on this path.  Only archive 2026-01
    // should have staged, and the subsequent failure cleanup removes even
    // that.  Assertion updated to match the archives-first behaviour.
    const stagedDuringFailure = await waitFor(() => {
      if (!fs.existsSync(archivePendingPath)) return false;
      const archivePending = readJsonFile(archivePendingPath, []);
      return (
        Array.isArray(archivePending) &&
        archivePending.some((entry) => String(entry?.name || "") === "2026-01.db") &&
        stats.secondArchiveStarted &&
        stats.activeKeys.has("archive:2026-02.db")
      );
    }, 20000, 100);
    assert.equal(
      stagedDuringFailure,
      true,
      "pull should stage the first archive while the later archive streams (archives-first ordering)",
    );

    let failedJob = null;
    const failed = await waitFor(async () => {
      const status = await fetchJson(`${APP_BASE_URL}/api/replication/job-status`);
      failedJob = status?.job || null;
      return String(failedJob?.status || "").trim().toLowerCase() === "failed";
    }, 20000, 100);
    assert.equal(failed, true, "background pull should settle as failed");
    assert.equal(
      String(failedJob?.error || "").includes("SHA-256 mismatch"),
      true,
      "failed job should report the archive integrity error",
    );

    const cleaned = await waitFor(() => {
      return (
        !fs.existsSync(mainPendingPath) &&
        !fs.existsSync(archivePendingPath) &&
        listTempDownloads(dbMod.DATA_DIR).length === 0 &&
        listTempDownloads(dbMod.ARCHIVE_DIR).length === 0 &&
        stats.activeStreams === 0
      );
    }, 15000, 100);
    assert.equal(
      cleaned,
      true,
      "failed pull should remove staged replacement manifests and temp downloads",
    );

    console.log("manualPullFailureCleanup.test.js: PASS");
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
    console.error("manualPullFailureCleanup.test.js: FAIL", err?.stack || err);
    process.exit(1);
  });
