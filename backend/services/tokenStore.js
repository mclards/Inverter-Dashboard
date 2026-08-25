"use strict";
/**
 * tokenStore.js — AES-256-GCM encrypted cloud credential storage.
 * Provider tokens and static credentials are encrypted at rest using a
 * machine-derived key so they cannot be trivially extracted from the data
 * directory.
 */

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { resolvedTokenFile } = require("./storagePaths");

const ALGORITHM = "aes-256-gcm";
const CONTEXT = "inverter-dashboard-cloud-tokens-v1";
const KEY_SALT_BASENAME = ".token-keyring";
const KEY_PBKDF2_ITERS = 200_000;

// T2.4 fix (Phase 5, 2026-04-14): the original deriveKey() used only
// hostname + platform + arch — values that any process on the same
// machine (or anyone reading basic system metadata from a backup
// manifest) could reproduce.  An attacker who exfiltrated the encrypted
// token file could derive the same key trivially.
//
// New derivation:
//   1. Read or generate a per-installation random 32-byte salt stored at
//      <dataDir>/.token-keyring with mode 0o600.  The salt file lives in
//      the same dataDir as the token file, so a full-dataDir exfiltration
//      still captures both.  The improvement is real only against PARTIAL
//      backup exfiltration (token file alone / older backup that pre-dates
//      the salt).  This is not "perfect" — Windows DPAPI / Electron
//      safeStorage would be — but those require an IPC roundtrip on every
//      cold start.  Filed as v2.9.0 follow-up.
//   2. PBKDF2(machine_fingerprint, salt, 200_000 iters, SHA-256) -> key.
//   3. Backward-compat: if decrypt with the new key fails, retry with the
//      legacy bare-hash key; if THAT works, re-encrypt with the new key on
//      the next save (handled in TokenStore._load / _save).

function _machineFingerprint() {
  return [os.hostname(), os.platform(), os.arch(), CONTEXT].join("|");
}

function _legacyDeriveKey() {
  return crypto.createHash("sha256").update(_machineFingerprint()).digest();
}

function _readOrCreateSalt(saltPath) {
  try {
    if (fs.existsSync(saltPath)) {
      const buf = fs.readFileSync(saltPath);
      if (buf.length >= 16) return buf.slice(0, 32);
    }
  } catch (err) {
    console.warn("[tokenStore] Could not read salt file, regenerating:", err.message);
  }
  const salt = crypto.randomBytes(32);
  try {
    fs.mkdirSync(path.dirname(saltPath), { recursive: true });
    fs.writeFileSync(saltPath, salt, { mode: 0o600 });
  } catch (err) {
    console.warn(
      "[tokenStore] Could not persist salt file (" + err.message + "); " +
      "falling back to ephemeral salt — tokens encrypted this session will " +
      "be unreadable next session.",
    );
  }
  return salt;
}

function deriveKey(saltPath) {
  if (!saltPath) return _legacyDeriveKey();
  const salt = _readOrCreateSalt(saltPath);
  return crypto.pbkdf2Sync(_machineFingerprint(), salt, KEY_PBKDF2_ITERS, 32, "sha256");
}

function encrypt(plaintext, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}

function decrypt(payload, key) {
  const parts = payload.split(":");
  if (parts.length !== 3) throw new Error("Invalid encrypted payload");
  const [ivHex, tagHex, encHex] = parts;
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const enc = Buffer.from(encHex, "hex");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

class TokenStore {
  constructor(dataDir) {
    this._storeFile = resolvedTokenFile(dataDir);
    // T2.4 fix: derive key from a per-install random salt mixed via PBKDF2.
    // Salt lives next to the token file in the resolved dataDir.
    this._saltFile = path.join(path.dirname(this._storeFile), KEY_SALT_BASENAME);
    this._key = deriveKey(this._saltFile);
    this._legacyKey = _legacyDeriveKey();
    this._cache = {};
    this._needsReencrypt = false;
    this._load();
    // If we successfully loaded with the legacy key, re-save under the new
    // key so future loads use the salt-derived path exclusively.
    if (this._needsReencrypt) {
      try {
        this._save();
        console.log("[tokenStore] Migrated existing token cache to salt-derived key (T2.4).");
      } catch (err) {
        console.warn("[tokenStore] Re-encryption migration deferred:", err.message);
      }
    }
  }

  _load() {
    try {
      if (!fs.existsSync(this._storeFile)) return;
      const raw = fs.readFileSync(this._storeFile, "utf8").trim();
      if (!raw) return;
      try {
        this._cache = JSON.parse(decrypt(raw, this._key));
      } catch (newKeyErr) {
        // T2.4 fix: backward-compat with files written by v2.8.8 and earlier
        // that used the bare-hash key.  Try the legacy key; if it works, mark
        // for re-encryption with the new salted key.
        try {
          this._cache = JSON.parse(decrypt(raw, this._legacyKey));
          this._needsReencrypt = true;
        } catch (_legacyErr) {
          throw newKeyErr;
        }
      }
    } catch (err) {
      console.warn("[tokenStore] Failed to load tokens:", err.message);
      this._cache = {};
    }
  }

  _save() {
    try {
      const json = JSON.stringify(this._cache);
      const encrypted = encrypt(json, this._key);
      fs.writeFileSync(this._storeFile, encrypted, { mode: 0o600 });
    } catch (err) {
      console.error("[tokenStore] Failed to save tokens:", err.message);
    }
  }

  /** Store token data for a provider. Never log these values. */
  set(provider, tokenData) {
    if (!provider || typeof tokenData !== "object" || tokenData === null) return;
    this._cache[provider] = { ...tokenData, _storedAt: Date.now() };
    this._save();
  }

  /** Get token data for a provider, or null if not stored. */
  get(provider) {
    return this._cache[provider] || null;
  }

  /** Remove stored token for a provider (disconnect). */
  delete(provider) {
    delete this._cache[provider];
    this._save();
  }

  /**
   * Returns true if access token is expired or missing.
   * Considers a 90-second buffer to avoid edge-case expiry during upload.
   */
  isExpired(provider) {
    const t = this._cache[provider];
    if (!t) return true;
    if (t.accessKeyId && t.secretAccessKey) return false;
    if (!t.access_token) return true;
    if (!t.expires_at) return false; // no expiry info, assume valid
    return Date.now() >= Number(t.expires_at) - 90_000;
  }

  /** Returns true if a token is stored (connected), regardless of expiry. */
  isConnected(provider) {
    const entry = this._cache[provider];
    return !!(
      entry?.access_token ||
      (entry?.accessKeyId && entry?.secretAccessKey)
    );
  }

  /** Summary of connected providers (no token values exposed). */
  listConnected() {
    return Object.keys(this._cache).map((p) => ({
      provider: p,
      connectedAt: this._cache[p]._storedAt || null,
      expired: this.isExpired(p),
    }));
  }
}

module.exports = TokenStore;
