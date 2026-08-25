"use strict";
/**
 * desktop/main.js — Native Electron Desktop Application
 * Lightweight container that connects directly to the authoritative Inverter Dashboard 2.0 Server.
 * Designed following the edocflow desktop architectural standard.
 */

const { app, BrowserWindow, Menu, Tray, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const http = require("http");
const { loadConfig, saveConfig } = require("./config");

let mainWindow = null;
let tray = null;
let isQuitting = false;

// Parse optional --server CLI override
function getTargetServerUrl() {
  const serverArgIdx = process.argv.findIndex(arg => arg === "--server" || arg.startsWith("--server="));
  if (serverArgIdx !== -1) {
    const arg = process.argv[serverArgIdx];
    if (arg.includes("=")) return arg.split("=")[1];
    if (process.argv[serverArgIdx + 1]) return process.argv[serverArgIdx + 1];
  }
  return loadConfig().serverUrl || "http://127.0.0.1:3500";
}

function checkServerHealth(serverUrl) {
  return new Promise((resolve) => {
    try {
      const url = new URL(serverUrl);
      const req = http.get({
        hostname: url.hostname,
        port: url.port || 80,
        path: "/api/health",
        timeout: 2500
      }, (res) => {
        let data = "";
        res.on("data", c => { data += c; });
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            resolve({ online: json.ok === true, data: json });
          } catch (_) {
            resolve({ online: res.statusCode === 200 });
          }
        });
      });
      req.on("error", () => resolve({ online: false }));
      req.on("timeout", () => { req.destroy(); resolve({ online: false }); });
    } catch (_) {
      resolve({ online: false });
    }
  });
}

const { fork } = require("child_process");

let localServerProcess = null;

async function ensureLocalServerRunning(serverUrl) {
  const url = new URL(serverUrl);
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
    const health = await checkServerHealth(serverUrl);
    if (!health.online) {
      console.log("[desktop] Local server is not running. Starting backend/server.js daemon...");
      const serverPath = path.join(__dirname, "..", "backend", "server.js");
      localServerProcess = fork(serverPath, [], {
        cwd: path.join(__dirname, ".."),
        env: Object.assign({}, process.env, { PORT: url.port || 3500 })
      });
      localServerProcess.on("error", (err) => console.error("[desktop] Local server error:", err));

      // Wait up to 5 seconds for health check
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 250));
        const res = await checkServerHealth(serverUrl);
        if (res.online) {
          console.log("[desktop] Local server successfully started and healthy.");
          break;
        }
      }
    }
  }
}

async function createMainWindow() {
  const config = loadConfig();
  const bounds = config.windowBounds || { width: 1440, height: 900 };

  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    minWidth: 1024,
    minHeight: 640,
    title: "ADSI Inverter Dashboard 2.0",
    backgroundColor: "#0b1329",
    show: false,
    icon: path.join(__dirname, "..", "frontend", "public", "assets", "adsi_logo.png"),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true
    }
  });

  if (bounds.maximized) {
    mainWindow.maximize();
  }

  const serverUrl = getTargetServerUrl();
  console.log(`[desktop] Connecting to Inverter Dashboard Server at ${serverUrl}...`);

  await ensureLocalServerRunning(serverUrl);

  try {
    await mainWindow.loadURL(serverUrl);
    mainWindow.show();
  } catch (err) {
    console.warn(`[desktop] Failed to connect to ${serverUrl}:`, err.message);
    mainWindow.loadFile(path.join(__dirname, "..", "frontend", "public", "server-connect.html"), {
      query: { target: serverUrl }
    }).catch(() => {});
    mainWindow.show();
  }

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      // Save window bounds
      const isMax = mainWindow.isMaximized();
      const currentBounds = mainWindow.getBounds();
      saveConfig({
        windowBounds: {
          width: currentBounds.width,
          height: currentBounds.height,
          maximized: isMax
        }
      });
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Handle external links safely
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      // If same origin or popout route, allow new Electron window
      try {
        const targetUrl = new URL(url);
        const serverOrigin = new URL(serverUrl);
        if (targetUrl.origin === serverOrigin.origin) {
          return { action: "allow" };
        }
      } catch (_) {}
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "deny" };
  });
}

function createTray() {
  const iconPath = path.join(__dirname, "..", "frontend", "public", "assets", "adsi_logo.png");
  if (!require("fs").existsSync(iconPath)) return;

  try {
    tray = new Tray(iconPath);
    const contextMenu = Menu.buildFromTemplate([
      {
        label: "Open Dashboard",
        click: () => {
          if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
          } else {
            createMainWindow();
          }
        }
      },
      { type: "separator" },
      {
        label: "Server: " + getTargetServerUrl(),
        enabled: false
      },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          isQuitting = true;
          app.quit();
        }
      }
    ]);

    tray.setToolTip("ADSI Inverter Dashboard 2.0");
    tray.setContextMenu(contextMenu);
    tray.on("double-click", () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
    });
  } catch (err) {
    console.warn("[desktop] Tray creation skipped:", err.message);
  }
}

// Single Instance Lock
const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    createMainWindow();
    createTray();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });

  app.on("before-quit", () => {
    isQuitting = true;
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}
