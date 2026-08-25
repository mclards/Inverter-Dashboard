"use strict";

const THUMBPRINT_RE = /^[0-9A-F]{40}$/;

function parsePinnedThumbprint(rawValue) {
  const value = String(rawValue == null ? "" : rawValue).trim().toUpperCase();
  if (!THUMBPRINT_RE.test(value)) {
    throw new Error(
      "codesign thumbprint pin must contain exactly 40 hexadecimal characters"
    );
  }
  return value;
}

function cleanupInstalledBackup(backupPath, artifactLabel, fsApi, logger = console) {
  if (!fsApi.existsSync(backupPath)) return true;
  try {
    fsApi.rmSync(backupPath, { force: true });
    return true;
  } catch (error) {
    logger.warn(
      "[user-guide-pdf] WARNING: new " + artifactLabel + " is installed, but its recovery backup " +
      "could not be removed: " + backupPath + " (" + error.message + ")"
    );
    return false;
  }
}

function cleanupInstalledPdfBackup(backupPath, fsApi, logger = console) {
  return cleanupInstalledBackup(backupPath, "PDF", fsApi, logger);
}

module.exports = { cleanupInstalledBackup, cleanupInstalledPdfBackup, parsePinnedThumbprint };
