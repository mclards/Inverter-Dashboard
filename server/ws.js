"use strict";
// WebSocket client registry and broadcaster for live dashboard updates.

const clients = new Set();
let payloadEnricher = null;
const wsStats = {
  startedAt: Date.now(),
  totalConnections: 0,
  sentFrames: 0,
  droppedFramesBackpressure: 0,
  sendErrors: 0,
  lastPayloadBytes: 0,
  lastSentTs: 0,
  lastDropTs: 0,
};

// WS-level ping/pong keepalive: detects silent TCP drops (NAT timeouts, dead peers)
// that don't produce a clean close event. Browsers handle pongs automatically at the
// protocol level — no client JS needed to respond to pings.
const WS_PING_INTERVAL_MS = 25000; // ping every 25 s
const WS_PING_MISSED_MAX = 2;      // terminate after 2 consecutive missed pongs (~50 s)
let _keepAliveInterval = null;

function registerClient(ws) {
  ws._isAlive = true;
  ws._pongsMissed = 0;
  clients.add(ws);
  wsStats.totalConnections += 1;
  ws.on("close", () => clients.delete(ws));
  ws.on("pong", () => {
    ws._isAlive = true;
    ws._pongsMissed = 0;
  });
}

function broadcastUpdate(payload) {
  if (clients.size === 0) return;
  let finalPayload = payload;
  if (typeof payloadEnricher === "function") {
    try {
      const enriched = payloadEnricher(payload);
      if (enriched && typeof enriched === "object") finalPayload = enriched;
    } catch (err) {
      console.warn("[WS] payload enrich failed:", err.message);
    }
  }
  const msg = JSON.stringify(finalPayload);
  wsStats.lastPayloadBytes = Buffer.byteLength(msg, "utf8");
  for (const ws of clients) {
    try {
      if (ws.readyState !== 1) {
        // Remove definitively-closed sockets on the next broadcast pass.
        clients.delete(ws);
        continue;
      }
      // Drop frame for congested sockets to keep realtime path responsive.
      if (Number(ws.bufferedAmount || 0) > 1024 * 1024) {
        wsStats.droppedFramesBackpressure += 1;
        wsStats.lastDropTs = Date.now();
        continue;
      }
      ws.send(msg);
      wsStats.sentFrames += 1;
      wsStats.lastSentTs = Date.now();
    } catch (err) {
      // Remove dead connections so they don't accumulate.
      clients.delete(ws);
      wsStats.sendErrors += 1;
      console.warn("[WS] send failed, client removed:", err.message);
    }
  }
}

function setBroadcastPayloadEnricher(fn) {
  payloadEnricher = typeof fn === "function" ? fn : null;
}

function startKeepAlive() {
  if (_keepAliveInterval) return;
  _keepAliveInterval = setInterval(() => {
    for (const ws of clients) {
      if (ws.readyState !== 1) {
        clients.delete(ws);
        continue;
      }
      if (!ws._isAlive) {
        // No pong received since the previous ping — increment miss count.
        ws._pongsMissed = (ws._pongsMissed || 0) + 1;
        if (ws._pongsMissed >= WS_PING_MISSED_MAX) {
          // Terminate so the browser gets a close event and reconnects cleanly.
          clients.delete(ws);
          try { ws.terminate(); } catch (_) {}
          console.warn("[WS] keepalive: terminated unresponsive client (2 missed pongs)");
          continue;
        }
      } else {
        ws._pongsMissed = 0;
      }
      ws._isAlive = false; // arm: expect a pong before the next interval
      try { ws.ping(); } catch (_) { clients.delete(ws); }
    }
  }, WS_PING_INTERVAL_MS);
  if (_keepAliveInterval.unref) _keepAliveInterval.unref();
}

function stopKeepAlive() {
  if (_keepAliveInterval) {
    clearInterval(_keepAliveInterval);
    _keepAliveInterval = null;
  }
}

function getStats() {
  return {
    ...wsStats,
    connectedClients: clients.size,
  };
}

module.exports = {
  clients,
  registerClient,
  broadcastUpdate,
  setBroadcastPayloadEnricher,
  startKeepAlive,
  stopKeepAlive,
  getStats,
};
