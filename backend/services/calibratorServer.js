// server/calibratorServer.js — standalone Field Calibration server
//
// Exports startCalibratorServer({ port, calibratorPythonBase, dbPath }) which:
//   • Creates an Express app and mounts registerCalibrationRoutes with a
//     calibrator-specific deps object (isolated from fleet server)
//   • Does NOT import server/index.js or touch the fleet adsi.db
//   • Talks to CalibratorService.exe (Python, default port 9200)
//   • Returns { app, server, wss, db, close() } for clean lifecycle

"use strict";

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");
const calibratorDb = require("./calibratorDb");
const firmwareMap = require("./firmwareMap");
const { registerCalibrationRoutes } = require("./calibrationRoutes");

// Default topology auth key window — same algorithm as server/index.js lines 12841–12863
const TOPOLOGY_AUTH_LEASE_MS = 60 * 60 * 1000; // 60 min (matches server/index.js:12789)

// In-memory lease map for topology auth (same as dashboard)
const _topologyAuthLeases = new Map();
const _topologyAuthFailures = new Map();
const TOPOLOGY_AUTH_WINDOW_MS = 60_000; // 60 sec (matches server/index.js:12779 exactly)
const TOPOLOGY_AUTH_FAIL_LIMIT = 5; // matches server/index.js:12778

// In-memory last broadcast state for WS poll fallback
let _lastBroadcastPayload = null;

// Active inverter/transport for the calibrator session
let _activeInverter = null;
let _activeTransport = "ETHERNET"; // ETHERNET or COM
let _activeInverterIp = null;

// FIX D: Validate calibrator db path confinement before opening
function validateCalibratorDbPath(dbPath) {
  const resolved = path.resolve(dbPath);

  // Determine the allowed base directories (APPDATA or HOME)
  const appData = process.env.APPDATA || process.env.LOCALAPPDATA || process.env.HOME || "";
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  const tmpDir = process.env.TEMP || process.env.TMP || "";

  // Default allowed base: ~/.calibrator/ or %APPDATA%/.calibrator/
  const allowedBases = [];
  if (appData) {
    allowedBases.push(path.resolve(appData, ".calibrator"));
  }
  if (homeDir && homeDir !== appData) {
    allowedBases.push(path.resolve(homeDir, ".calibrator"));
  }

  // Also allow test paths in temp directory (only for test runners)
  // Tests will use tmpdir with "calibrator-*-test-" prefix
  if (tmpDir && (dbPath.includes("calibrator") || dbPath.includes("test"))) {
    allowedBases.push(path.resolve(tmpDir));
  }

  // Ensure at least one allowed base is defined
  if (allowedBases.length === 0) {
    throw new Error(
      "calibrator db: cannot determine safe base path (APPDATA/HOME not set)"
    );
  }

  // Check that resolved path starts with one of the allowed bases
  const isAllowed = allowedBases.some((base) => {
    // Normalize path separators for comparison
    const resolvedNorm = resolved.toLowerCase().replace(/\//g, "\\");
    const baseNorm = base.toLowerCase().replace(/\//g, "\\");
    return resolvedNorm.startsWith(baseNorm);
  });

  if (!isAllowed) {
    throw new Error(
      `calibrator db: path ${resolved} is outside allowed sandbox (must be under ${allowedBases.join(" or ")})`
    );
  }

  return resolved;
}

function startCalibratorServer({
  port = 3600,
  calibratorPythonBase = "http://127.0.0.1:9200",
  dbPath = null,
} = {}) {
  // Use a default calibrator db path if not specified
  const dbPathFinal = dbPath || `${process.env.USERPROFILE || process.env.HOME}/.calibrator/db.sqlite`;

  // FIX D: Validate path confinement before opening
  let validatedPath;
  try {
    validatedPath = validateCalibratorDbPath(dbPathFinal);
  } catch (err) {
    throw new Error(`[calibrator] ${err.message}`);
  }

  // Initialize the calibrator database
  const db = calibratorDb.initCalibratorDb(validatedPath);

  const app = express();
  app.use(express.json({ limit: "10mb" }));

  // ── Topology Auth Middleware (mirror dashboard, lines 12798–12864) ──────

  function requireTopologyAuth(req, res, next) {
    const ip = String(req.ip || req.connection?.remoteAddress || "").trim();

    // Failure-budget check
    if (ip) {
      const entry = _topologyAuthFailures.get(ip);
      const now = Date.now();
      if (entry && now - entry.windowStart < TOPOLOGY_AUTH_WINDOW_MS &&
          entry.count >= TOPOLOGY_AUTH_FAIL_LIMIT) {
        const retryAfterS = Math.ceil(
          (TOPOLOGY_AUTH_WINDOW_MS - (now - entry.windowStart)) / 1000,
        );
        res.setHeader("Retry-After", String(retryAfterS));
        return res.status(429).json({
          ok: false, error: `Too many failed attempts; retry in ${retryAfterS}s`,
        });
      }
    }

    const key = String(
      req.headers["x-topology-key"] ||
        req.headers["x-substation-key"] ||
        req.query?.auth ||
        "",
    ).trim().toLowerCase();

    const recordFailure = () => {
      if (!ip) return;
      const now = Date.now();
      const entry = _topologyAuthFailures.get(ip);
      if (!entry || now - entry.windowStart >= TOPOLOGY_AUTH_WINDOW_MS) {
        _topologyAuthFailures.set(ip, { count: 1, windowStart: now });
      } else {
        entry.count += 1;
      }
      if (_topologyAuthFailures.size > 256) {
        const cutoff = now - TOPOLOGY_AUTH_WINDOW_MS;
        for (const [k, v] of _topologyAuthFailures) {
          if (v.windowStart < cutoff) _topologyAuthFailures.delete(k);
        }
      }
    };

    if (!key) {
      recordFailure();
      return res.status(401).json({ ok: false, error: "Authorization required." });
    }

    const nowMs = Date.now();
    const m = new Date(nowMs).getMinutes();
    const valid = new Set([
      `adsi${m}`, `adsi${String(m).padStart(2, "0")}`,
    ]);
    // ±1 minute in BOTH directions (prior + next) — same window as the
    // dashboard's requireTopologyAuth / getPlantWideAuthKeys, so a key that
    // works in the main app also works against the standalone calibrator.
    const mPrev = (m + 59) % 60;
    const mNext = (m + 1) % 60;
    valid.add(`adsi${mPrev}`);
    valid.add(`adsi${String(mPrev).padStart(2, "0")}`);
    valid.add(`adsi${mNext}`);
    valid.add(`adsi${String(mNext).padStart(2, "0")}`);

    // Accept if lease exists and is valid, or key is in current ±1 minute window
    const lease = _topologyAuthLeases.get(key);
    const leaseOk = lease && Number(lease.expiresAt || 0) > nowMs;
    if (leaseOk || valid.has(key)) {
      _topologyAuthLeases.set(key, { issuedAt: nowMs, expiresAt: nowMs + TOPOLOGY_AUTH_LEASE_MS });
      if (ip) _topologyAuthFailures.delete(ip);
      return next();
    }

    recordFailure();
    return res.status(403).json({ ok: false, error: "Invalid authorization key." });
  }

  // ── Calibrator-specific deps ──────────────────────────────────────────

  // callPython: forward HTTP requests to CalibratorService.exe (port 9200)
  async function callPython(path, method = "GET", body = null) {
    // Reuse-shim — calibrationRoutes.js is shared UNCHANGED with the
    // dashboard, which addresses the Python engine by inverter IP:
    //   /calibration/<verb>/<ip>/<slave>
    // The calibrator's Python (calibrator_app.py) is single-transport and
    // slave-addressed: /calibration/<verb>/<slave> — the TCP/serial link is
    // already bound via /transport/select. Collapse the {ip} segment so the
    // shared route reaches the calibrator API without forking either side.
    // (Without this, every Read returns HTTP 404.)
    const mShim = String(path).match(
      /^\/calibration\/(state|full-config|preflight)\/[^/]+\/([^/?]+)(\?.*)?$/,
    );
    if (mShim) {
      path = `/calibration/${mShim[1]}/${mShim[2]}${mShim[3] || ""}`;
    }
    const url = new URL(path, calibratorPythonBase).toString();
    const fetchOpts = {
      method,
      headers: { "Content-Type": "application/json" },
      timeout: 30 * 1000, // 30 s sane timeout
    };
    if (body && (method === "POST" || method === "PUT")) {
      fetchOpts.body = typeof body === "string" ? body : JSON.stringify(body);
    }

    try {
      const response = await fetch(url, fetchOpts);
      const text = await response.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch (_) {
        // Fallback if response is not JSON
        json = { ok: false, error: text || `HTTP ${response.status}` };
      }
      if (!response.ok && !json.ok) {
        json.ok = false;
        if (!json.error) {
          // FastAPI raises HTTPException as {"detail": "..."} — prefer that
          // human-readable reason over a bare "HTTP 503" so the calibrator
          // UI can show the actual cause (unreachable IP, bad COM, etc.).
          const detail =
            typeof json.detail === "string"
              ? json.detail
              : json.detail
                ? JSON.stringify(json.detail)
                : null;
          json.error = detail || `HTTP ${response.status}`;
        }
      }
      return json;
    } catch (err) {
      console.warn(`[callPython] ${method} ${path} failed:`, err.message);
      return { ok: false, error: err.message };
    }
  }

  // setActivePowerPct: single-source consign path (from C2 fix).
  // calibrator_app.py /calibration/consign reads body.percent + body.slave
  // (slave-addressed, single transport). The earlier `pct_pn` key never
  // matched Python's `percent` lookup so every consign defaulted to -1 →
  // "percent must be 0..100". inverter/inverter_ip are ignored by Python
  // (transport already bound via /transport/select) but kept for audit.
  async function setActivePowerPct(inverter, slave, pctPn) {
    const ip = _activeInverterIp || "127.0.0.1"; // placeholder for COM
    return callPython("/calibration/consign", "POST", {
      inverter,
      slave,
      inverter_ip: ip,
      percent: pctPn,
    });
  }

  // isRemoteMode: always false — calibrator is gateway-local
  function isRemoteMode() {
    return false;
  }

  // proxyToRemote: no-op, calibrator is not remote-aware
  function proxyToRemote(req, res) {
    return res.status(400).json({
      ok: false,
      error: "Calibrator does not support remote mode",
    });
  }

  // Best-effort read of the dashboard's mirrored ipconfig.json — the same
  // file /api/ip-config serves. Returns {inverters, units} or null. The
  // Utility Tool runs ON the gateway, so this file is normally present.
  function _readIpConfigJsonBestEffort() {
    const fs = require("fs");
    const pd =
      process.env.PROGRAMDATA ||
      process.env.ALLUSERSPROFILE ||
      "C:\\ProgramData";
    const candidates = [
      path.join(pd, "Inverter-Dashboard", "ipconfig.json"),
      path.join(pd, "Inverter-Dashboard", "config", "ipconfig.json"),
    ];
    for (const p of candidates) {
      try {
        if (!fs.existsSync(p)) continue;
        const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
        if (cfg && typeof cfg === "object" && cfg.inverters) {
          return { inverters: cfg.inverters, units: cfg.units || {} };
        }
      } catch (_) {
        // try next candidate / fall through to placeholder
      }
    }
    return null;
  }

  // loadIpConfigFromDb: resolve inverter→IP for the shared calibrationRoutes
  // helpers (resolveIp / validateInvSlave). The standalone calibrator binds
  // ONE transport by IP via /transport/select, and callPython collapses the
  // path {ip} segment out before it ever reaches Python — so the inverter
  // NUMBER is only a label and resolveIp MUST succeed for any inverter the
  // operator can pick. Previously this returned only {activeInverter||1: …},
  // so every Read / full-config / config-write 404'd ("no IP for inverter N")
  // for any picked inverter other than 1 — the frontend never calls
  // /api/set-active-inverter, so _activeInverter stays null. Source the real
  // fleet map from the mirrored ipconfig.json (same data the picker is built
  // from) when present, and keep the active/placeholder entry as a fallback
  // so the tool still works with no ipconfig at all.
  function loadIpConfigFromDb() {
    const real = _readIpConfigJsonBestEffort();
    if (real && real.inverters && Object.keys(real.inverters).length) {
      const inverters = { ...real.inverters };
      const units = { ...(real.units || {}) };
      if (_activeInverter && !inverters[_activeInverter]) {
        inverters[_activeInverter] = _activeInverterIp || "127.0.0.1";
        units[_activeInverter] = units[_activeInverter] || [1, 2, 3, 4];
      }
      return { inverters, units };
    }
    return {
      inverters: {
        [_activeInverter || 1]: _activeInverterIp || "127.0.0.1",
      },
      units: {
        [_activeInverter || 1]: [1, 2, 3, 4],
      },
    };
  }

  // setActiveInverter: allow C4 / transport-select to set target
  function setActiveInverter(inv, transport = "ETHERNET", ip = null) {
    _activeInverter = inv;
    _activeTransport = transport;
    _activeInverterIp = ip;
  }

  // getConfiguredNodeSet: return the active inverter's units
  function getConfiguredNodeSet(cfg = null) {
    const safeCfg = cfg || loadIpConfigFromDb();
    const set = new Set();
    for (const inv in (safeCfg?.inverters || {})) {
      const invNum = Number(inv);
      if (!Number.isInteger(invNum) || invNum < 1 || invNum > 27) continue;
      const unitsRaw = safeCfg?.units?.[inv] ?? safeCfg?.units?.[String(inv)] ?? [1, 2, 3, 4];
      const units = Array.isArray(unitsRaw)
        ? unitsRaw.map((n) => Number(n)).filter((n) => n >= 1 && n <= 4)
        : [1, 2, 3, 4];
      for (const unit of [...new Set(units)]) {
        set.add(`${invNum}_${unit}`);
      }
    }
    return set;
  }

  // isAuthorizedPlantWideControl: for standalone calibrator, always true
  // (operator decision: the tool is standalone and meant for field use)
  function isAuthorizedPlantWideControl(body = {}, req = null) {
    return true;
  }

  // getActiveCriticalBlock: calibrator has no critical blocks
  function getActiveCriticalBlock(inverter) {
    return null;
  }

  // isCalibrationWritesEnabled: always true (tool exists to calibrate)
  function isCalibrationWritesEnabled() {
    return true;
  }

  // broadcastUpdate: push session state over WS + store for poll fallback
  function broadcastUpdate(payload) {
    _lastBroadcastPayload = payload;
    if (wss && wss.clients) {
      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          try {
            client.send(JSON.stringify(payload));
          } catch (_) {}
        }
      });
    }
  }

  // ── Build deps object for registerCalibrationRoutes ──────────────────

  const deps = {
    isRemoteMode,
    proxyToRemote,
    requireTopologyAuth,
    callPython,
    loadIpConfigFromDb,
    getConfiguredNodeSet,
    isAuthorizedPlantWideControl,
    getActiveCriticalBlock,
    isCalibrationWritesEnabled,
    setSetting: calibratorDb.setSetting,
    insertCalibrationSnapshot: calibratorDb.insertCalibrationSnapshot,
    getLatestCalibrationSnapshot: calibratorDb.getLatestCalibrationSnapshot,
    listCalibrationSnapshots: calibratorDb.listCalibrationSnapshots,
    getCalibrationSnapshotById: calibratorDb.getCalibrationSnapshotById,
    deleteCalibrationSnapshotById: calibratorDb.deleteCalibrationSnapshotById,
    insertCalibrationWriteLog: calibratorDb.insertCalibrationWriteLog,
    listCalibrationWriteLog: calibratorDb.listCalibrationWriteLog,
    insertCalibrationSession: calibratorDb.insertCalibrationSession,
    updateCalibrationSessionEnd: calibratorDb.updateCalibrationSessionEnd,
    getCalibrationSession: calibratorDb.getCalibrationSession,
    listRecentCalibrationSessions: calibratorDb.listRecentCalibrationSessions,
    insertAuditLogRow: calibratorDb.insertAuditLogRow,
    broadcastUpdate,
    setActivePowerPct,
  };

  // ── Mount calibration routes ──────────────────────────────────────────

  registerCalibrationRoutes(app, deps);

  // ── Serve static calibration UI ───────────────────────────────────────

  // GET /health — unauthenticated readiness probe. electron/main.js
  // waitForCalibratorReady() polls http://127.0.0.1:<nodePort>/health and
  // requires {ok:true}; without this route Express 404s and the dashboard
  // shows "Calibrator Startup Failed" even though the server is up.
  // Declared BEFORE static so nothing can shadow it.
  app.get("/health", (req, res) => {
    res.json({
      ok: true,
      service: "calibrator-node",
      node_port: port,
      python_base: calibratorPythonBase,
    });
  });

  // Serve public/ (existing Field Calibration UI) read-only
  const publicDir = require("path").join(__dirname, "..", "public");
  app.use(express.static(publicDir));

  // GET /api/ip-config — PUBLIC, READ-ONLY, BEST-EFFORT convenience list.
  //
  // The standalone calibrator does NOT own a fleet config and must stay
  // independent of the dashboard's operation mode. But if this machine is
  // the gateway, the dashboard mirrors its inverter list to a plain JSON
  // file (ipconfig.json under ProgramData) on every read/write. We read
  // ONLY that file (no adsi.db open, no server/index import) purely to
  // populate the optional "From IP config" dropdown. If the file is absent
  // or unparseable we return an empty config — the dropdown then stays
  // hidden and manual IP entry works exactly as before.
  app.get("/api/ip-config", (req, res) => {
    const fs = require("fs");
    const pd =
      process.env.PROGRAMDATA ||
      process.env.ALLUSERSPROFILE ||
      "C:\\ProgramData";
    const candidates = [
      path.join(pd, "Inverter-Dashboard", "ipconfig.json"),
      path.join(pd, "Inverter-Dashboard", "config", "ipconfig.json"),
    ];
    for (const p of candidates) {
      try {
        if (!fs.existsSync(p)) continue;
        const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
        if (cfg && typeof cfg === "object" && cfg.inverters) {
          return res.json({
            inverters: cfg.inverters,
            units: cfg.units || {},
            source: "ipconfig.json (read-only)",
          });
        }
      } catch (_) {
        // try next candidate / fall through to empty
      }
    }
    return res.json({ inverters: {}, units: {} });
  });

  // GET /api/calibration/cfg-map — PUBLIC, READ-ONLY. Returns the static
  // field map (offsets/kinds/groups/labels/units) so the Utility Tool can
  // render each tab's LAYOUT even before any Connect/Read.
  app.get("/api/calibration/cfg-map", async (req, res) => {
    try {
      const r = await callPython("/calibration/cfg-map", "GET");
      return res.json(r);
    } catch (err) {
      return res.status(502).json({
        ok: false, error: err && err.message ? err.message : String(err),
      });
    }
  });

  // GET /api/active-inverter — report current active inverter for C4
  app.get("/api/active-inverter", (req, res) => {
    res.json({
      ok: true,
      inverter: _activeInverter,
      transport: _activeTransport,
      inverter_ip: _activeInverterIp,
    });
  });

  // POST /api/set-active-inverter — C4 sets the target inverter
  app.post("/api/set-active-inverter", (req, res) => {
    const { inverter, transport, inverter_ip } = req.body || {};
    setActiveInverter(
      Number(inverter),
      String(transport || "ETHERNET"),
      inverter_ip ? String(inverter_ip) : null,
    );
    res.json({
      ok: true,
      inverter: _activeInverter,
      transport: _activeTransport,
      inverter_ip: _activeInverterIp,
    });
  });

  // ── Transport selector routes (topology-gated passthrough to CalibratorService.exe) ──

  // POST /api/transport/select — forward to CalibratorService :9200.
  // PUBLIC (no requireTopologyAuth): opening a Modbus TCP/serial transport is
  // setup and performs no register writes. The single authorization prompt in
  // the tool gates only on entering Calibration Mode (write enable).
  app.post("/api/transport/select", async (req, res) => {
    const response = await callPython("/transport/select", "POST", req.body);
    if (response.ok) {
      return res.json(response);
    }
    return res.status(400).json(response);
  });

  // GET /api/serial/ports — forward to CalibratorService :9200. PUBLIC: COM
  // port enumeration is read-only and required before any auth step.
  app.get("/api/serial/ports", async (req, res) => {
    const response = await callPython("/serial/ports", "GET");
    if (response.ok) {
      return res.json(response);
    }
    return res.status(400).json(response);
  });

  // ── Firmware Upgrade (EXPERIMENTAL — gated per-node flash) ────────────
  //
  // Brick-risk / irreversible on a live 997.64 kW plant. Defence in depth:
  //   • All real safety refusals are enforced in Python
  //     (firmware_transport.flash_inverter_node — the single choke point).
  //   • Dry-run / listing / identity / job-poll / abort are READ-ONLY or
  //     fail-safe and stay PUBLIC (consistent with the calibrator's
  //     "read-only ops need no auth" rule — abort must never be blocked).
  //   • ONLY the irreversible live start (POST /api/firmware/flash) is
  //     topology-auth gated, on top of the typed confirmation the UI
  //     forces and Python's confirm_irreversible/expected_sha256 gates.

  // GET /api/firmware/files — PUBLIC: list candidate .S images (read-only).
  app.get("/api/firmware/files", async (req, res) => {
    const response = await callPython("/firmware/files", "GET");
    return res.status(response.ok ? 200 : 400).json(response);
  });

  // GET /api/firmware/identity/:slave — PUBLIC: FC11 Report-Slave-ID so the
  // operator sees exactly which physical unit a flash would hit (read-only).
  app.get("/api/firmware/identity/:slave", async (req, res) => {
    const slave = Number(req.params.slave);
    if (!Number.isInteger(slave) || slave <= 0) {
      return res.status(400).json({ ok: false, error: "invalid slave" });
    }
    const response = await callPython(`/firmware/identity/${slave}`, "GET");
    return res.status(response.ok ? 200 : 400).json(response);
  });

  // GET /api/firmware/check — PUBLIC: per-inverter firmware homogeneity for
  // the CONNECTED inverter. The calib tool is single-transport (one
  // inverter), so this reads slaves 1..4 via the existing FC11 identity
  // path and reports whether they all run the SAME firmware — the field
  // tech's post-board-swap check (the dual of the serial-relocation guard).
  // Display-only: the calib tool persists nothing; the dashboard scan owns
  // the audit trail. ?slaves=1,2,3,4 (default 1..4).
  app.get("/api/firmware/check", async (req, res) => {
    let slaves = [1, 2, 3, 4];
    const q = String(req.query.slaves || "").trim();
    if (q) {
      const parsed = q.split(",").map((x) => Number(x.trim()))
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= 247);
      if (parsed.length) slaves = parsed;
    }
    const rows = [];
    for (const slave of slaves) {
      let r;
      try {
        r = await callPython(`/firmware/identity/${slave}`, "GET");
      } catch (err) {
        r = { ok: false, error: err.message };
      }
      rows.push({
        inverter_id: 0,
        inverter_ip: "calibrator",       // single synthetic inverter
        inverter_name: "Connected inverter",
        slave,
        ok: Boolean(r && r.ok),
        serial: r && r.serial ? r.serial : null,
        model_code: r && r.ok ? r.model_code : null,
        firmware_main: r && r.ok ? r.firmware_main : null,
        firmware_aux: r && r.ok ? r.firmware_aux : null,
        error: r && !r.ok ? (r.error || "read_failed") : null,
      });
    }
    const classified = firmwareMap.classifyFleet(rows);
    const inv = classified.perInverter[0] || { verdict: "none", drifted: false };
    return res.json({
      ok: true,
      verdict: inv.verdict,          // uniform | split | partial | none
      canonical: classified.canonical,
      nodes: classified.perNode,
      summary: classified.summary,
    });
  });

  // POST /api/firmware/dryrun — PUBLIC: hardware-free full simulation (the
  // safe DEFAULT). Touches no wire; it is the prerequisite a live flash must
  // pass first, so it must be freely runnable without arming anything.
  app.post("/api/firmware/dryrun", async (req, res) => {
    const response = await callPython("/firmware/dryrun", "POST", req.body);
    return res.status(response.ok ? 200 : 400).json(response);
  });

  // POST /api/firmware/flash — TOPOLOGY-AUTH GATED. The IRREVERSIBLE step.
  // This only *starts* the background job; Python re-checks every gate
  // (prior dry-run of this SHA, non-broadcast node, TCP-only, identity/
  // compat, confirm_irreversible) before any byte hits the wire.
  app.post("/api/firmware/flash", requireTopologyAuth, async (req, res) => {
    const response = await callPython("/firmware/flash", "POST", req.body);
    return res.status(response.ok ? 200 : 400).json(response);
  });

  // GET /api/firmware/job/:jobId — PUBLIC: poll progress / audit / result.
  app.get("/api/firmware/job/:jobId", async (req, res) => {
    const jobId = String(req.params.jobId || "");
    if (!/^fw-[0-9a-f]{12}$/.test(jobId)) {
      return res.status(400).json({ ok: false, error: "invalid job id" });
    }
    const response = await callPython(
      `/firmware/job/${encodeURIComponent(jobId)}`, "GET");
    return res.status(response.ok ? 200 : 404).json(response);
  });

  // POST /api/firmware/job/:jobId/abort — PUBLIC by design: an emergency
  // stop must never be gated behind an auth prompt. Cooperative abort is
  // fail-safe (bootloader banks 3/4 are never transmitted, so an
  // interrupted app-flash stays re-flashable).
  app.post("/api/firmware/job/:jobId/abort", async (req, res) => {
    const jobId = String(req.params.jobId || "");
    if (!/^fw-[0-9a-f]{12}$/.test(jobId)) {
      return res.status(400).json({ ok: false, error: "invalid job id" });
    }
    const response = await callPython(
      `/firmware/job/${encodeURIComponent(jobId)}/abort`, "POST", {});
    return res.status(response.ok ? 200 : 404).json(response);
  });

  // ── WebSocket for session updates ─────────────────────────────────────

  const server = http.createServer(app);
  const wss = new WebSocket.Server({ server, host: "127.0.0.1" });

  wss.on("connection", (ws) => {
    // Send last broadcast state on connect (poll fallback)
    if (_lastBroadcastPayload) {
      try {
        ws.send(JSON.stringify(_lastBroadcastPayload));
      } catch (_) {}
    }
    ws.on("error", (err) => {
      console.warn("[calibrator-ws] error:", err.message);
    });
  });

  // ── Return server handle ──────────────────────────────────────────────

  return {
    app,
    server,
    wss,
    db,
    setActiveInverter,
    close() {
      // Failure-isolated: DB durability (calibratorDb.close → WAL
      // checkpoint + handle release) must run even if wss/server close
      // throws (e.g. server already not-listening → ERR_SERVER_NOT_RUNNING).
      // Sockets die with the process anyway; the SQLite checkpoint is the
      // only step with persistence consequences.
      try { wss.close(); } catch (_) { /* ws already closing */ }
      try { server.close(); } catch (_) { /* not listening */ }
      try { calibratorDb.close(); } catch (_) { /* idempotent; best-effort */ }
    },
  };
}

module.exports = {
  startCalibratorServer,
};
