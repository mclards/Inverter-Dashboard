"use strict";

// Regression: remote-mode IP-config save ("save to both") + hardening.
// -------------------------------------------------------------------------
// Feature (2026-06-08): the IP Configuration window is now editable from a
// Remote viewer. A remote POST /api/ip-config must:
//   1. forward the edit to the gateway (authoritative) — _applyIpConfigPostRemote,
//   2. adopt the GATEWAY's returned/sanitized config (not the posted body),
//   3. mirror that config into the remote's OWN local store so both sides match,
//   4. reject a malformed payload before spending a gateway round-trip,
//   5. NOT wipe the local config if the gateway answers 200 with a bad shape,
//   6. surface a gateway failure as an error instead of a false local-only save.
//
// Boots the real app in remote mode against an in-process dummy gateway
// (modelled on modeIsolation.test.js) and verifies every contract over HTTP.

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

process.env.NODE_ENV = "test";
if (!process.env.IM_PORTABLE_DATA_DIR) {
  process.env.IM_PORTABLE_DATA_DIR = fs.mkdtempSync(
    path.join(os.tmpdir(), "adsi-ipcfg-remote-"),
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
// isUnsafeRemoteLoop() rejects a localhost gateway URL in remote mode, so the
// dummy gateway must bind a non-loopback IPv4 — exactly like modeIsolation.
const GATEWAY_HOST =
  String(process.env.ADSI_DUMMY_GATEWAY_HOST || pickNonLoopbackIpv4() || "").trim();
const GATEWAY_BASE_URL = `http://${GATEWAY_HOST}:${GATEWAY_PORT}`;
assert.equal(Boolean(GATEWAY_HOST), true, "No non-loopback IPv4 available for remote IP-config test.");

// The authoritative config the GATEWAY returns. Deliberately DIFFERENT from
// what the client posts, so we can prove the app adopts the gateway's answer
// rather than echoing the request body.
const GATEWAY_CFG = {
  inverters: { 1: "10.77.0.51", 2: "10.77.0.52" },
  poll_interval: { 1: 0.1, 2: 0.2 },
  units: { 1: [1, 2], 2: [3, 4] },
  losses: { 1: 3, 2: 4 },
};

const dummyState = {
  lastPostBody: null,
  postCount: 0,
  mode: "ok", // "ok" | "fail" | "garbage"
};

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}
async function waitFor(fn, timeoutMs = 15000, stepMs = 150) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await fn()) return true;
    await waitMs(stepMs);
  }
  return false;
}
async function fetchRaw(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch (_) {
    parsed = null;
  }
  return { status: response.status, ok: response.ok, body: parsed, text };
}
async function fetchJson(url, options = {}) {
  const r = await fetchRaw(url, options);
  if (!r.ok) throw new Error(String(r.body?.error || r.text || `HTTP ${r.status}`));
  return r.body;
}
function readReqBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (_) {
        resolve({});
      }
    });
  });
}
async function setMode(mode) {
  await fetchJson(`${APP_BASE_URL}/api/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      mode === "remote"
        ? { operationMode: "remote", remoteGatewayUrl: GATEWAY_BASE_URL, remoteApiToken: "" }
        : { operationMode: "gateway" },
    ),
  });
  const ok = await waitFor(async () => {
    const s = await fetchJson(`${APP_BASE_URL}/api/settings`).catch(() => ({}));
    return String(s?.operationMode || "").trim().toLowerCase() === mode;
  }, 10000, 150);
  assert.equal(ok, true, `should switch to ${mode} mode`);
}
function inv1(cfg) {
  return String(cfg?.inverters?.[1] || cfg?.inverters?.["1"] || "");
}

async function run() {
  const gatewayServer = http.createServer(async (req, res) => {
    const url = String(req.url || "");
    if (url.startsWith("/api/ip-config")) {
      if (req.method === "POST") {
        dummyState.postCount += 1;
        dummyState.lastPostBody = await readReqBody(req);
        if (dummyState.mode === "fail") {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Simulated gateway DB failure." }));
          return;
        }
        if (dummyState.mode === "garbage") {
          // 200 OK but NOT an ip-config object-map shape.
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, somethingElse: true }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(GATEWAY_CFG));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(GATEWAY_CFG));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, rows: [] }));
  });

  await new Promise((resolve, reject) => {
    gatewayServer.once("error", reject);
    gatewayServer.listen(GATEWAY_PORT, "0.0.0.0", resolve);
  });

  const serverMod = require("../index.js");

  try {
    const ready = await waitFor(async () => {
      try {
        await fetchJson(`${APP_BASE_URL}/api/settings`);
        return true;
      } catch (_) {
        return false;
      }
    }, 20000, 200);
    if (!ready) throw new Error("App server did not become ready.");

    const POSTED = {
      inverters: { 1: "192.168.9.99" }, // intentionally different from GATEWAY_CFG
      poll_interval: { 1: 0.05 },
      units: { 1: [1] },
      losses: { 1: 9 },
    };

    // ── Contracts 1 + 2: forward to gateway, adopt gateway's authoritative cfg ──
    await setMode("remote");
    dummyState.mode = "ok";
    const saveResp = await fetchRaw(`${APP_BASE_URL}/api/ip-config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(POSTED),
    });
    assert.equal(saveResp.ok, true, `remote save should succeed (got ${saveResp.status}: ${saveResp.text})`);
    assert.equal(dummyState.postCount, 1, "gateway should have received exactly one forwarded POST");
    assert.equal(
      String(dummyState.lastPostBody?.inverters?.[1] || dummyState.lastPostBody?.inverters?.["1"] || ""),
      "192.168.9.99",
      "the operator's edit must be forwarded to the gateway verbatim",
    );
    assert.equal(inv1(saveResp.body), "10.77.0.51", "app must return the gateway's authoritative inverter-1 IP");

    // ── Contract 3: gateway cfg mirrored into the LOCAL store (save to both) ──
    await setMode("gateway");
    const localCfg = await fetchJson(`${APP_BASE_URL}/api/ip-config`);
    assert.equal(inv1(localCfg), "10.77.0.51", "local store must hold the gateway's mirrored inverter-1 IP");
    assert.equal(
      String(localCfg?.inverters?.[2] || localCfg?.inverters?.["2"] || ""),
      "10.77.0.52",
      "local store must hold the gateway's mirrored inverter-2 IP",
    );
    assert.deepEqual(
      (Array.isArray(localCfg?.units?.[1]) ? localCfg.units[1] : localCfg?.units?.["1"]) || [],
      [1, 2],
      "local store must mirror the gateway's enabled-units for inverter 1",
    );

    // ── Contract 4: malformed payload rejected BEFORE any gateway round-trip ──
    await setMode("remote");
    const postCountBeforeBad = dummyState.postCount;
    const badResp = await fetchRaw(`${APP_BASE_URL}/api/ip-config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify("not-an-object"),
    });
    assert.equal(badResp.status, 400, "malformed payload must be rejected with 400");
    assert.equal(
      dummyState.postCount,
      postCountBeforeBad,
      "malformed payload must NOT be forwarded to the gateway",
    );

    // ── Contract 5: garbage gateway-200 must NOT wipe the local config ──
    dummyState.mode = "garbage";
    const garbageResp = await fetchRaw(`${APP_BASE_URL}/api/ip-config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(POSTED),
    });
    assert.equal(garbageResp.ok, true, "garbage gateway-200 should still resolve ok (gateway owns truth)");
    assert.ok(
      String(garbageResp.body?.localMirrorWarning || ""),
      "garbage gateway-200 should flag that the local mirror was skipped",
    );
    // Confirm the previously-mirrored good config survived (not overwritten by defaults).
    await setMode("gateway");
    const afterGarbage = await fetchJson(`${APP_BASE_URL}/api/ip-config`);
    assert.equal(
      inv1(afterGarbage),
      "10.77.0.51",
      "garbage gateway response must NOT overwrite the local config with defaults",
    );

    // ── Contract 6: a gateway failure surfaces as an error ──
    await setMode("remote");
    dummyState.mode = "fail";
    const failResp = await fetchRaw(`${APP_BASE_URL}/api/ip-config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(POSTED),
    });
    assert.equal(failResp.ok, false, "remote save must fail when the gateway rejects it");
    assert.ok(
      /gateway/i.test(String(failResp.body?.error || failResp.text || "")),
      `error should mention the gateway (got: ${failResp.text})`,
    );

    console.log("ipConfigRemoteSave.test.js: PASS");
  } finally {
    try {
      await Promise.race([serverMod.shutdownEmbedded(), waitMs(4000)]);
    } catch (_) {}
    await Promise.race([
      new Promise((resolve) => gatewayServer.close(() => resolve())),
      waitMs(4000),
    ]);
  }
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("ipConfigRemoteSave.test.js: FAIL", err?.stack || err);
    process.exit(1);
  });
