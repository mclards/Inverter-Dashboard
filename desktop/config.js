"use strict";
/**
 * desktop/config.js — Desktop Client Configuration Manager
 * Manages server connection preferences and window bounds for the Electron shell.
 * Stored under %APPDATA%\InverterDashboard-2.0\client-config.json (Zero conflict with legacy).
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

function getConfigDir() {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "InverterDashboard-2.0");
  }
  return path.join(os.homedir(), ".config", "inverter-dashboard-2.0");
}

const CONFIG_FILE = path.join(getConfigDir(), "client-config.json");

const DEFAULT_CONFIG = {
  serverUrl: "http://127.0.0.1:3500",
  rememberServer: true,
  autoConnect: true,
  theme: "dark",
  windowBounds: {
    width: 1440,
    height: 900,
    maximized: true
  }
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
      return { ...DEFAULT_CONFIG, ...data };
    }
  } catch (err) {
    console.error("[desktop-config] Error reading config:", err.message);
  }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(updates) {
  try {
    const dir = getConfigDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const current = loadConfig();
    const merged = { ...current, ...updates };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), "utf8");
    return merged;
  } catch (err) {
    console.error("[desktop-config] Error saving config:", err.message);
    return null;
  }
}

module.exports = {
  getConfigDir,
  CONFIG_FILE,
  loadConfig,
  saveConfig
};
