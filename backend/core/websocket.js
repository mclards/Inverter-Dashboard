"use strict";
/**
 * websocket.js — Real-Time WebSocket Telemetry & Control Lock Hub
 */

const WebSocket = require("ws");
const WebSocketServer = WebSocket.Server || WebSocket.WebSocketServer || WebSocket;

class WebSocketHub {
  constructor() {
    this.wss = null;
    this.clients = new Map(); // ws -> { deviceId, operatorName, ip, connectedAt }
  }

  init(httpServer) {
    this.wss = new WebSocketServer({ server: httpServer, path: "/ws" });

    this.wss.on("connection", (ws, req) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const deviceId = url.searchParams.get("deviceId") || req.headers["x-device-id"] || "anonymous";
      const operatorName = url.searchParams.get("operatorName") || req.headers["x-operator-name"] || "Viewer";
      const ip = req.socket.remoteAddress || "127.0.0.1";

      const clientInfo = { deviceId, operatorName, ip, connectedAt: Date.now() };
      this.clients.set(ws, clientInfo);

      // Send initial welcome & connection ack
      ws.send(JSON.stringify({ type: "welcome", serverTime: Date.now(), clientInfo }));

      ws.on("message", (msg) => {
        try {
          const data = JSON.parse(msg);
          if (data.type === "ping") {
            ws.send(JSON.stringify({ type: "pong", ts: Date.now() }));
          }
        } catch (_) {}
      });

      ws.on("close", () => {
        this.clients.delete(ws);
      });
    });
  }

  broadcast(messageObj) {
    if (!this.wss) return;
    const payload = JSON.stringify(messageObj);
    for (const client of this.wss.clients) {
      if (client.readyState === 1) {
        client.send(payload);
      }
    }
  }

  broadcastTelemetry(telemetryData) {
    this.broadcast({ type: "telemetry", data: telemetryData, ts: Date.now() });
  }

  broadcastLockState(lockStatus) {
    this.broadcast({ type: "control_lock", ...lockStatus, ts: Date.now() });
  }

  getConnectedCount() {
    return this.clients.size;
  }
}

module.exports = new WebSocketHub();
