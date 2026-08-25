const { contextBridge, ipcRenderer } = require("electron");

// Single unified API surface exposed to all renderer windows.
contextBridge.exposeInMainWorld("electronAPI", {
  // Window controls
  minimize: () => ipcRenderer.send("window-minimize"),
  maximize: () => ipcRenderer.send("window-maximize"),
  close: () => ipcRenderer.send("window-close"),
  closeCurrentWindow: () => ipcRenderer.send("close-current-window"),

  // Navigation
  openTopologyWindow: () => ipcRenderer.send("open-topology-window"),
  openIpConfigWindow: () => ipcRenderer.send("open-ip-config-window"),
  openCalibrator: (theme) => ipcRenderer.send("open-calibrator", theme),
  openPopoutWindow: (page, theme) => ipcRenderer.send("open-popout-window", { page, theme }),
  showNavContextMenu: (page, theme) => ipcRenderer.send("show-nav-context-menu", { page, theme }),
  createCalibratorShortcut: () => ipcRenderer.invoke("create-calibrator-shortcut"),
  openLogs: (folder) => ipcRenderer.send("open-logs-folder", folder),

  // File/folder operations
  pickFolder: (startPath) => ipcRenderer.invoke("pick-folder", startPath),
  openFolder: (folder) => ipcRenderer.invoke("open-folder", folder),
  saveTextFile: (options) => ipcRenderer.invoke("save-text-file", options),
  openTextFile: (options) => ipcRenderer.invoke("open-text-file", options),
  downloadUserGuidePdf: () => ipcRenderer.invoke("download-user-guide-pdf"),
  downloadCredentialsPdf: () => ipcRenderer.invoke("download-credentials-pdf"),
  saveAdsibak: () => ipcRenderer.invoke("save-adsibak"),
  openAdsibak: () => ipcRenderer.invoke("open-adsibak"),

  // IP config
  getConfig: () => ipcRenderer.invoke("config-get"),
  saveConfig: (config) => ipcRenderer.invoke("config-save", config),
  openIP: (ip) => ipcRenderer.send("open-ip", ip),
  openIPCheck: (ip) => ipcRenderer.send("open-ip-check", ip),

  // Events — return a cleanup function that the caller must invoke to remove the listener
  onIPStatus: (cb) => {
    const handler = (_, payload) => cb(payload);
    ipcRenderer.on("ip-status", handler);
    return () => ipcRenderer.removeListener("ip-status", handler);
  },
  onInverterStatus: (cb) => {
    const handler = (_, payload) => cb(payload);
    ipcRenderer.on("inverter-status", handler);
    return () => ipcRenderer.removeListener("inverter-status", handler);
  },

  // License
  getLicenseStatus: () => ipcRenderer.invoke("license-get-status"),
  getLicenseAudit: () => ipcRenderer.invoke("license-get-audit"),
  getLicenseFingerprint: () => ipcRenderer.invoke("license-get-fingerprint"),
  uploadLicense: () => ipcRenderer.invoke("license-upload"),
  onLicenseStatus: (cb) => {
    const handler = (_, payload) => cb(payload);
    ipcRenderer.on("license-status", handler);
    return () => ipcRenderer.removeListener("license-status", handler);
  },

  // Admin
  getAuthKey: () => ipcRenderer.invoke("get-auth-key"),

  // App update
  getUpdateState: () => ipcRenderer.invoke("app-update-get-state"),
  checkForUpdates: () => ipcRenderer.invoke("app-update-check"),
  downloadUpdate: () => ipcRenderer.invoke("app-update-download"),
  installUpdate: () => ipcRenderer.invoke("app-update-install"),
  setAutoDownload: (enabled) => ipcRenderer.invoke("app-update-set-auto-download", enabled),
  setAutoInstallOvernight: (enabled) => ipcRenderer.invoke("app-update-set-auto-install-overnight", enabled),
  restartApp: () => ipcRenderer.invoke("app-restart"),
  onUpdateStatus: (cb) => {
    const handler = (_, payload) => cb(payload);
    ipcRenderer.on("app-update-status", handler);
    return () => ipcRenderer.removeListener("app-update-status", handler);
  },
  onUpdateReady: (cb) => {
    const handler = (_, payload) => cb(payload);
    ipcRenderer.on("app-update-ready", handler);
    return () => ipcRenderer.removeListener("app-update-ready", handler);
  },

  // Startup readiness
  reportStartupProgress: (payload) => ipcRenderer.send("dashboard-startup-progress", payload),
  reportStartupReady: (payload) => ipcRenderer.send("dashboard-startup-ready", payload),
  reportStartupFailure: (message) => ipcRenderer.send("dashboard-startup-failed", message),
  reportRemoteConnectivityFailure: (message) => ipcRenderer.send("dashboard-remote-connectivity-failed", message),
  switchOperationMode: (mode) => ipcRenderer.send("switch-operation-mode", mode),

  // Camera popout lifecycle
  onCameraPopoutOpened: (cb) => {
    const handler = () => cb();
    ipcRenderer.on("camera-popout-opened", handler);
    return () => ipcRenderer.removeListener("camera-popout-opened", handler);
  },
  onCameraPopoutClosed: (cb) => {
    const handler = () => cb();
    ipcRenderer.on("camera-popout-closed", handler);
    return () => ipcRenderer.removeListener("camera-popout-closed", handler);
  },
  signalCameraPopoutReady: () => ipcRenderer.send("camera-popout-ready"),
  openHikvisionNativeViewer: (theme) => ipcRenderer.invoke("hikvision-native-viewer-open", { theme }),
  hikvisionNativeViewerStatus: () => ipcRenderer.invoke("hikvision-native-viewer-status"),
  onHikvisionNativeViewerOpened: (cb) => {
    const handler = () => cb();
    ipcRenderer.on("hikvision-native-viewer-opened", handler);
    return () => ipcRenderer.removeListener("hikvision-native-viewer-opened", handler);
  },
  onHikvisionNativeViewerClosed: (cb) => {
    const handler = () => cb();
    ipcRenderer.on("hikvision-native-viewer-closed", handler);
    return () => ipcRenderer.removeListener("hikvision-native-viewer-closed", handler);
  },

  hikvisionNativeStart: (rect) => ipcRenderer.invoke("hikvision-native-start", rect),
  hikvisionNativeUpdate: (rect) => ipcRenderer.invoke("hikvision-native-update", rect),
  hikvisionNativeStop: () => ipcRenderer.invoke("hikvision-native-stop"),
  hikvisionNativeHide: () => ipcRenderer.invoke("hikvision-native-hide"),
  hikvisionNativeShow: () => ipcRenderer.invoke("hikvision-native-show"),
  hikvisionNativeStatus: () => ipcRenderer.invoke("hikvision-native-status"),

  // Cloud Backup OAuth
  // Opens an OAuth window and returns { ok, callbackUrl } or { ok: false, error }
  openOAuthWindow: (authUrl) => ipcRenderer.invoke("oauth-start", { authUrl }),
});
