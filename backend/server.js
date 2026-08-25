"use strict";
/**
 * server.js — ADSI Inverter Dashboard 2.0 Backend Gateway (:3500)
 * Pure Client-Server Architecture · Multi-User Identity · Single Source of Truth
 */

const express = require("express");
const http = require("http");
const path = require("path");
const cors = require("cors");
let compression = null;
try { compression = require("compression"); } catch (_) {}
try { require("dotenv").config(); } catch (_) {}

const dbManager = require("./core/db");
const DeviceRegistry = require("./core/deviceRegistry");
const ControlArbiter = require("./core/controlArbiter");
const websocketHub = require("./core/websocket");

const PORT = Number(process.env.PORT) || 3500;
const HOST = process.env.HOST || "0.0.0.0";

const app = express();
const server = http.createServer(app);

// ── 1. Core Middleware ────────────────────────────────────────────────────────
app.use(cors());
if (compression) app.use(compression());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// ── 2. Core Subsystems Initialization ─────────────────────────────────────────
const deviceRegistry = new DeviceRegistry(dbManager.db);
const controlArbiter = new ControlArbiter({
  defaultLeaseSec: 60,
  onLockChange: (status) => websocketHub.broadcastLockState(status)
});

websocketHub.init(server);

// ── 3. API Route Mounting ─────────────────────────────────────────────────────
const devicesRouter = require("./api/devices")(deviceRegistry);
const controlRouter = require("./api/control")(controlArbiter, dbManager);
const configRouter = require("./api/config")(dbManager);
const telemetryRouter = require("./api/telemetry")(dbManager, websocketHub);
const forecastRouter = require("./api/forecast")(dbManager);
const hardwareRouter = require("./api/hardware")(dbManager);
const authRouter = require("./api/auth")(dbManager);

app.use("/api/auth", authRouter);
app.use("/api/device", devicesRouter);
app.use("/api/control", controlRouter);
app.use("/api/config", configRouter);
app.use("/api/telemetry", telemetryRouter);
app.use("/api", telemetryRouter); // Mount /api/live and /api/energy/5min on /api
app.use("/api/forecast", forecastRouter);
app.use("/api", hardwareRouter); // Mount /api/stop-reasons, /api/serial, /api/clock, /api/igbt, /api/compliance

// Health & Info Endpoint
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    name: "ADSI Inverter Dashboard 2.0",
    version: "2.0.0",
    serverTime: new Date().toISOString(),
    connectedClients: websocketHub.getConnectedCount(),
    controlStatus: controlArbiter.getLockStatus()
  });
});

// ── 4. Static Frontend Serving ────────────────────────────────────────────────
const frontendPublic = path.join(__dirname, "..", "frontend", "public");
app.use(express.static(frontendPublic));

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/") || req.path.startsWith("/ws")) return next();
  const indexHtml = path.join(frontendPublic, "index.html");
  res.sendFile(indexHtml);
});

// ── 5. Server Boot & Lifecycle ────────────────────────────────────────────────
server.listen(PORT, HOST, () => {
  console.log(`================================================================`);
  console.log(`  ADSI Inverter Dashboard 2.0 Gateway Online`);
  console.log(`  Listening on: http://${HOST}:${PORT}`);
  console.log(`  Authoritative Storage: ${dbManager.paths.root}`);
  console.log(`================================================================`);
});

function gracefulShutdown(signal) {
  console.log(`\n[Server] Received ${signal}. Shutting down cleanly...`);
  server.close(() => {
    try { dbManager.db.close(); } catch (_) {}
    console.log("[Server] Closed connections and SQLite database. Exited.");
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
