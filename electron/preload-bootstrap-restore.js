"use strict";
/**
 * preload-bootstrap-restore.js — IPC bridge for the bootstrap-restore wizard.
 *
 * Exposes a narrow, intent-named API to the wizard renderer. Channel names
 * mirror the IPC constants in electron/bootstrapRestore.js exactly.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bootstrapRestoreAPI", {
  // Returns scope checklist definitions: [{ key, label, detail, defaultChecked, critical }]
  getScopes: () => ipcRenderer.invoke("bootstrap-restore:get-scopes"),

  // Opens a native file picker. Resolves to { ok, path?, size?, canceled?, error? }
  pickFile: () => ipcRenderer.invoke("bootstrap-restore:pick-file"),

  // Validates an .adsibak path. Resolves to { ok, info? | error }
  // info: { appVersion, schemaVersion, createdAt, scope[], tag, fileCount,
  //         totalSize, archiveSize, checksumOk, rowCounts }
  validate: (sourcePath) =>
    ipcRenderer.invoke("bootstrap-restore:validate", sourcePath),

  // Performs the restore. Resolves to { ok, restored?, scope?, error? }
  // payload: { sourcePath: string, scopeFilter: string[] }
  run: (payload) => ipcRenderer.invoke("bootstrap-restore:run", payload),

  // Aborts the wizard.
  cancel: () => ipcRenderer.invoke("bootstrap-restore:cancel"),

  // Reports completion to the main process so it can decide whether to
  // app.relaunch().  payload: { restored?, canceled?, error?, scope? }
  complete: (payload) => ipcRenderer.send("bootstrap-restore:complete", payload),
});
