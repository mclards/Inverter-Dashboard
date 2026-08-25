"use strict";
/**
 * recoveryDialog.js — v2.8.10 power-loss resilience (Phase A4)
 *
 * WHY: When Phase A3 (integrityGate) detects a torn/corrupt app.asar, or when
 * Phase A2 (safeRequire) collects one or more failed requires, the operator
 * needs a branded, actionable dialog — not Electron's cryptic default fatal
 * handler showing a raw SyntaxError path.
 *
 * WHAT: Shows a modal with three choices:
 *   1. Reinstall Now     — launches the stashed installer under
 *                          %PROGRAMDATA%\InverterDashboard\updates\
 *                          last-good-installer.exe in silent mode. The app
 *                          exits so NSIS can overwrite app.asar cleanly.
 *   2. Show Log          — opens a flat text log of the failure so the
 *                          operator can forward it to support.
 *   3. Quit              — exits the app.
 *
 * If the stashed installer is missing (e.g. first install predates v2.8.10),
 * the dialog still appears but with an explanation and the path to download
 * manually.
 *
 * DEPENDENCIES: Node core + electron core only. MUST NOT require any
 * third-party modules — they live in the damaged app.asar.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { dialog, app, shell } = require("electron");
const { spawn } = require("child_process");

function getProgramDataRoot() {
  return process.env.PROGRAMDATA || process.env.ALLUSERSPROFILE || "C:\\ProgramData";
}

function getStashedInstallerPath() {
  return path.join(
    getProgramDataRoot(),
    "InverterDashboard",
    "updates",
    "last-good-installer.exe",
  );
}

function getRecoveryLogPath() {
  return path.join(
    getProgramDataRoot(),
    "InverterDashboard",
    "logs",
    "recovery.log",
  );
}

function appendRecoveryLog(entry) {
  try {
    const logPath = getRecoveryLogPath();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const line = `[${new Date().toISOString()}] ${entry}\n`;
    fs.appendFileSync(logPath, line, "utf8");
  } catch (_) {
    /* ignore — we're already in a degraded state */
  }
}

function formatStartupFailures(failures = []) {
  if (!Array.isArray(failures) || failures.length === 0) return "";
  return failures
    .map((f, idx) => `  ${idx + 1}. require("${f.module}") -> ${f.error}`)
    .join("\n");
}

function describeIntegrityResult(result) {
  if (!result) return "";
  if (result.ok) return "";
  return `Integrity: ${result.reason} (mode=${result.mode})`;
}

/**
 * Show the recovery dialog synchronously, perform the chosen action, exit.
 *
 * This function NEVER returns under normal flow — it either spawns the
 * installer and exits, or calls app.exit(). Callers should treat it as
 * terminal.
 */
function showRecoveryDialogAndExit({ integrityResult, startupFailures = [], reason = "" } = {}) {
  const installerPath = getStashedInstallerPath();
  const hasInstaller = fs.existsSync(installerPath);

  const summaryLines = [
    "ADSI Inverter Dashboard could not start because application files are damaged.",
    "",
    "This usually happens after a sudden power loss while Windows was writing to disk.",
    "Your plant data under C:\\ProgramData\\InverterDashboard\\ is not affected and will",
    "be picked up automatically once the dashboard is reinstalled.",
  ];

  const detailLines = [];
  if (reason) detailLines.push(`Reason: ${reason}`);
  const integrityDesc = describeIntegrityResult(integrityResult);
  if (integrityDesc) detailLines.push(integrityDesc);
  const failureDesc = formatStartupFailures(startupFailures);
  if (failureDesc) detailLines.push("Failed requires:\n" + failureDesc);

  const logLine = `Recovery dialog shown — reason=${reason || "integrity"}; ` +
    `failures=${startupFailures.length}; installerStashed=${hasInstaller}`;
  appendRecoveryLog(logLine);
  if (failureDesc) appendRecoveryLog(failureDesc);
  if (integrityDesc) appendRecoveryLog(integrityDesc);

  const buttons = hasInstaller
    ? ["Reinstall Now", "Show Log", "Quit"]
    : ["Open Updates Folder", "Show Log", "Quit"];

  const detailMessage = hasInstaller
    ? `A verified installer is available locally:\n${installerPath}\n\n` +
      `Click "Reinstall Now" to run it silently. The dashboard will relaunch automatically ` +
      `once install completes (typically 30-60 seconds).`
    : `No local installer was found at:\n${installerPath}\n\n` +
      `Please download the latest installer from the GitHub releases page and run it ` +
      `manually, or contact support.`;

  let choice = 2;
  try {
    choice = dialog.showMessageBoxSync({
      type: "error",
      title: "ADSI Inverter Dashboard — Recovery",
      message: summaryLines.join("\n"),
      detail: detailMessage + (detailLines.length ? "\n\n" + detailLines.join("\n") : ""),
      buttons,
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
  } catch (err) {
    appendRecoveryLog(`Dialog failed to display: ${err.message}`);
    app.exit(1);
    return;
  }

  if (choice === 0) {
    if (hasInstaller) {
      appendRecoveryLog("User chose Reinstall Now — spawning silent installer");
      try {
        const child = spawn(installerPath, ["/S"], {
          detached: true,
          stdio: "ignore",
          windowsHide: false,
        });
        child.unref();
      } catch (err) {
        appendRecoveryLog(`Installer spawn failed: ${err.message}`);
      }
    } else {
      const updatesDir = path.dirname(installerPath);
      try {
        fs.mkdirSync(updatesDir, { recursive: true });
        shell.openPath(updatesDir);
      } catch (err) {
        appendRecoveryLog(`Opening updates folder failed: ${err.message}`);
      }
    }
    app.exit(0);
    return;
  }

  if (choice === 1) {
    try {
      shell.openPath(getRecoveryLogPath());
    } catch (_) { /* ignore */ }
    app.exit(0);
    return;
  }

  app.exit(0);
}

module.exports = {
  showRecoveryDialogAndExit,
  getStashedInstallerPath,
  getRecoveryLogPath,
  appendRecoveryLog,
};
