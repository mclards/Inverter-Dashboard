"use strict";
/**
 * deviceRegistry.js — Multi-User / Controller Device Identity & Personalization Store
 *
 * Persists connected device IDs, controller friendly names, role permissions,
 * and per-device personalizations (Dark/Solar/Cyberpunk themes, layout zoom,
 * card order, audio alarms) directly on the server's authoritative database.
 */

const crypto = require("crypto");

class DeviceRegistry {
  constructor(db) {
    this.db = db;
    this._initSchema();
  }

  _initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS client_devices (
        device_id TEXT PRIMARY KEY,
        device_name TEXT,
        operator_name TEXT,
        ip_address TEXT,
        role TEXT DEFAULT 'operator',
        preferences_json TEXT DEFAULT '{}',
        created_at_ts INTEGER,
        last_seen_ts INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_devices_last_seen ON client_devices(last_seen_ts);
    `);
  }

  registerDevice({ deviceId, deviceName, operatorName, ip }) {
    const id = String(deviceId || "").trim() || crypto.randomUUID();
    const name = String(deviceName || "").trim() || "Workstation";
    const op = String(operatorName || "").trim() || "Operator";
    const now = Date.now();

    const existing = this.db.prepare(`SELECT * FROM client_devices WHERE device_id = ?`).get(id);

    if (existing) {
      this.db.prepare(`
        UPDATE client_devices
           SET ip_address = ?,
               device_name = COALESCE(NULLIF(?, ''), device_name),
               operator_name = COALESCE(NULLIF(?, ''), operator_name),
               last_seen_ts = ?
         WHERE device_id = ?
      `).run(ip || existing.ip_address, deviceName || "", operatorName || "", now, id);

      let prefs = {};
      try { prefs = JSON.parse(existing.preferences_json || "{}"); } catch (_) {}
      return {
        deviceId: id,
        deviceName: existing.device_name,
        operatorName: existing.operator_name,
        role: existing.role,
        preferences: prefs,
        isNew: false
      };
    }

    const defaultPrefs = JSON.stringify({
      theme: "dark",
      layoutZoom: 1.0,
      favoriteInverters: [],
      audioAlarmEnabled: true
    });

    this.db.prepare(`
      INSERT INTO client_devices (device_id, device_name, operator_name, ip_address, role, preferences_json, created_at_ts, last_seen_ts)
      VALUES (?, ?, ?, ?, 'operator', ?, ?, ?)
    `).run(id, name, op, ip || "127.0.0.1", defaultPrefs, now, now);

    return {
      deviceId: id,
      deviceName: name,
      operatorName: op,
      role: "operator",
      preferences: JSON.parse(defaultPrefs),
      isNew: true
    };
  }

  updatePreferences(deviceId, prefs = {}) {
    if (!deviceId) return false;
    const now = Date.now();
    const existing = this.db.prepare(`SELECT preferences_json FROM client_devices WHERE device_id = ?`).get(deviceId);
    if (!existing) return false;

    let current = {};
    try { current = JSON.parse(existing.preferences_json || "{}"); } catch (_) {}
    const merged = { ...current, ...prefs };

    this.db.prepare(`
      UPDATE client_devices
         SET preferences_json = ?,
             last_seen_ts = ?
       WHERE device_id = ?
    `).run(JSON.stringify(merged), now, deviceId);

    return merged;
  }

  getDevice(deviceId) {
    if (!deviceId) return null;
    return this.db.prepare(`SELECT * FROM client_devices WHERE device_id = ?`).get(deviceId);
  }

  listDevices() {
    return this.db.prepare(`SELECT * FROM client_devices ORDER BY last_seen_ts DESC LIMIT 100`).all();
  }
}

module.exports = DeviceRegistry;
