"use strict";
/**
 * onedrive.js — Microsoft OneDrive adapter using Microsoft Graph API.
 * Uses OAuth 2.0 Authorization Code flow with PKCE (no client secret required
 * for public/desktop client registrations in Azure AD).
 *
 * Setup: Register an app in Azure Active Directory:
 *   https://portal.azure.com → App registrations → New registration
 *   - Account types: "Accounts in any organizational directory and personal Microsoft accounts"
 *   - Redirect URI: "Mobile and desktop applications" → http://localhost:3500/oauth/callback/onedrive
 *   - API permissions: Files.ReadWrite, offline_access, User.Read (all delegated)
 *   - No client secret required (public client).
 * Copy the Application (client) ID into the Cloud Backup settings.
 */

const _nodeFetch = require("node-fetch");
const fs = require("fs");
const crypto = require("crypto");
const zlib = require("zlib");
const { pipeline } = require("stream");
const { promisify } = require("util");

const pipelineAsync = promisify(pipeline);

// BR-M3 (audit 2026-05-28 §3) — bound every Graph request so a network
// partition or unreachable endpoint can't block the backup mutex forever.
// node-fetch v2's `timeout` aborts a request that takes longer than N ms.
// 120 s is generous enough for a 5 MB resumable chunk on a slow-but-alive
// link while still capping a true partition. Callers that pass their own
// `timeout` keep it.
const REQUEST_TIMEOUT_MS = 120000;
function fetch(url, opts = {}) {
  return _nodeFetch(url, opts.timeout ? opts : { ...opts, timeout: REQUEST_TIMEOUT_MS });
}

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const SCOPES = "Files.ReadWrite offline_access User.Read";
const PROVIDER_FOLDER = "InverterDashboardBackups";

function encodeGraphPath(pathText) {
  return String(pathText || "")
    .split("/")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => encodeURIComponent(x))
    .join("/");
}

class OneDriveProvider {
  constructor(tokenStore) {
    this.tokenStore = tokenStore;
    this.PROVIDER = "onedrive";
  }

  /** Generate PKCE code verifier + challenge pair. */
  static generatePKCE() {
    const verifier = crypto.randomBytes(48).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    return { verifier, challenge };
  }

  /** Build the authorization URL. clientId must be provided by caller. */
  getAuthUrl(clientId, redirectUri, state, codeChallenge) {
    if (!clientId) throw new Error("OneDrive Client ID not configured");
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: SCOPES,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      prompt: "select_account",
    });
    return `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params}`;
  }

  /** Exchange authorization code + PKCE verifier for tokens. Stores result. */
  async exchangeCode(clientId, code, redirectUri, codeVerifier) {
    const params = new URLSearchParams({
      client_id: clientId,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    });
    const r = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      throw new Error(`OneDrive token exchange failed (${r.status}): ${body}`);
    }
    const tok = await r.json();
    const tokenData = {
      access_token: tok.access_token,
      refresh_token: tok.refresh_token,
      expires_at: Date.now() + Number(tok.expires_in || 3600) * 1000,
      client_id: clientId,
    };
    this.tokenStore.set(this.PROVIDER, tokenData);
    return tokenData;
  }

  /** Refresh expired access token using stored refresh token. */
  async refreshToken() {
    const stored = this.tokenStore.get(this.PROVIDER);
    if (!stored?.refresh_token) throw new Error("No OneDrive refresh token stored");
    const params = new URLSearchParams({
      client_id: stored.client_id,
      grant_type: "refresh_token",
      refresh_token: stored.refresh_token,
      scope: SCOPES,
    });
    const r = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      throw new Error(`OneDrive refresh failed (${r.status}): ${body}`);
    }
    const tok = await r.json();
    const tokenData = {
      access_token: tok.access_token,
      refresh_token: tok.refresh_token || stored.refresh_token,
      expires_at: Date.now() + Number(tok.expires_in || 3600) * 1000,
      client_id: stored.client_id,
    };
    this.tokenStore.set(this.PROVIDER, tokenData);
    return tokenData;
  }

  async getAccessToken() {
    if (!this.tokenStore.isConnected(this.PROVIDER)) {
      throw new Error("OneDrive not connected. Complete OAuth setup first.");
    }
    if (this.tokenStore.isExpired(this.PROVIDER)) {
      const refreshed = await this.refreshToken();
      return refreshed.access_token;
    }
    return this.tokenStore.get(this.PROVIDER).access_token;
  }

  isConnected() {
    return this.tokenStore.isConnected(this.PROVIDER);
  }

  /** Ensure the app folder exists on OneDrive; returns its ID. */
  async ensureFolder(accessToken) {
    // Try to create the folder (or get it if it already exists).
    const r = await fetch(
      `${GRAPH_BASE}/me/drive/special/approot/children`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: PROVIDER_FOLDER,
          folder: {},
          "@microsoft.graph.conflictBehavior": "replace",
        }),
      },
    );
    const json = await r.json().catch(() => ({}));
    if (!r.ok && r.status !== 409) {
      throw new Error(`OneDrive folder create failed (${r.status}): ${JSON.stringify(json)}`);
    }
    if (json.id) return json.id;
    // 409 = already exists; fetch it.
    const r2 = await fetch(
      `${GRAPH_BASE}/me/drive/special/approot:/${PROVIDER_FOLDER}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    const j2 = await r2.json();
    if (!r2.ok) throw new Error(`OneDrive folder fetch failed: ${r2.status}`);
    return j2.id;
  }

  async getItemByPath(accessToken, relativePath) {
    const encoded = encodeGraphPath(relativePath);
    const r = await fetch(
      `${GRAPH_BASE}/me/drive/special/approot:/${encoded}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (r.status === 404) return null;
    if (!r.ok) {
      throw new Error(`OneDrive item fetch failed: ${r.status}`);
    }
    return r.json();
  }

  /** Ensure nested folder path exists under provider root; returns final relative path. */
  async ensureFolderPath(accessToken, pathSegments) {
    const segments = Array.isArray(pathSegments)
      ? pathSegments.map((x) => String(x || "").trim()).filter(Boolean)
      : String(pathSegments || "")
          .split("/")
          .map((x) => x.trim())
          .filter(Boolean);
    await this.ensureFolder(accessToken);
    if (!segments.length) return PROVIDER_FOLDER;

    let current = PROVIDER_FOLDER;
    for (const seg of segments) {
      const next = `${current}/${seg}`;
      const existing = await this.getItemByPath(accessToken, next);
      if (existing?.folder) {
        current = next;
        continue;
      }
      const r = await fetch(
        `${GRAPH_BASE}/me/drive/special/approot:/${encodeGraphPath(current)}:/children`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: seg,
            folder: {},
            "@microsoft.graph.conflictBehavior": "replace",
          }),
        },
      );
      if (!r.ok && r.status !== 409) {
        const body = await r.text().catch(() => "");
        throw new Error(`OneDrive folder create failed (${r.status}): ${body}`);
      }
      current = next;
    }
    return current;
  }

  /**
   * Upload a single file to OneDrive.
   * Uses direct PUT for small files (<4 MB) and resumable upload for larger.
   * @param {string} localPath  Absolute path to local file
   * @param {string} remoteName  Remote file name within the app folder
   * @param {Function} [onProgress]  progress(0-100)
   */
  async uploadFile(localPath, remoteName, onProgress) {
    const accessToken = await this.getAccessToken();
    const stats = fs.statSync(localPath);
    const fileSize = stats.size;
    const cleanRemote = String(remoteName || "")
      .split("/")
      .map((x) => x.trim())
      .filter(Boolean);
    const uploadName = cleanRemote.length ? cleanRemote.pop() : "backup.bin";
    if (cleanRemote.length > 0) {
      await this.ensureFolderPath(accessToken, cleanRemote);
    } else {
      await this.ensureFolder(accessToken);
    }
    const remotePath = `${PROVIDER_FOLDER}${cleanRemote.length ? `/${cleanRemote.join("/")}` : ""}/${uploadName}`;
    const encodedRemotePath = encodeGraphPath(remotePath);

    if (fileSize < 4 * 1024 * 1024) {
      // Small file: direct PUT.
      const fileData = fs.readFileSync(localPath);
      const r = await fetch(
        `${GRAPH_BASE}/me/drive/special/approot:/${encodedRemotePath}:/content`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/octet-stream",
          },
          body: fileData,
        },
      );
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        throw new Error(`OneDrive upload failed (${r.status}): ${body}`);
      }
      const item = await r.json();
      if (onProgress) onProgress(100);
      return { id: item.id, name: item.name, size: item.size };
    }

    // Large file: resumable upload session.
    const sessionR = await fetch(
      `${GRAPH_BASE}/me/drive/special/approot:/${encodedRemotePath}:/createUploadSession`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          item: { "@microsoft.graph.conflictBehavior": "replace" },
        }),
      },
    );
    if (!sessionR.ok) {
      throw new Error(`OneDrive upload session failed: ${sessionR.status}`);
    }
    const { uploadUrl } = await sessionR.json();

    const CHUNK = 5 * 1024 * 1024; // 5 MB chunks (must be multiple of 320 KiB)
    const fd = fs.openSync(localPath, "r");
    let uploaded = 0;
    let lastItem = null;
    try {
      while (uploaded < fileSize) {
        const end = Math.min(uploaded + CHUNK, fileSize);
        const len = end - uploaded;
        const buf = Buffer.allocUnsafe(len);
        fs.readSync(fd, buf, 0, len, uploaded);
        const r2 = await fetch(uploadUrl, {
          method: "PUT",
          headers: {
            "Content-Length": String(len),
            "Content-Range": `bytes ${uploaded}-${end - 1}/${fileSize}`,
          },
          body: buf,
        });
        uploaded = end;
        if (onProgress) onProgress(Math.round((uploaded / fileSize) * 100));
        if (r2.status === 200 || r2.status === 201) {
          lastItem = await r2.json();
        } else if (r2.status !== 202) {
          throw new Error(`OneDrive chunk upload failed: ${r2.status}`);
        }
      }
    } finally {
      fs.closeSync(fd);
    }
    return lastItem
      ? { id: lastItem.id, name: lastItem.name, size: lastItem.size }
      : { name: remoteName, size: fileSize };
  }

  /** List backup entries (folders) in the app folder. */
  async listBackups() {
    const accessToken = await this.getAccessToken();
    const r = await fetch(
      `${GRAPH_BASE}/me/drive/special/approot:/${PROVIDER_FOLDER}:/children`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!r.ok) {
      if (r.status === 404) return []; // folder doesn't exist yet
      throw new Error(`OneDrive list failed: ${r.status}`);
    }
    const { value } = await r.json();
    return (value || []).filter(
      (f) => f.name.startsWith("inverter-backup-") && f.folder,
    );
  }

  /** Download a file from OneDrive by item ID. */
  async downloadFile(remoteItemId, localPath, onProgress) {
    const accessToken = await this.getAccessToken();
    const r = await fetch(
      `${GRAPH_BASE}/me/drive/items/${remoteItemId}/content`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!r.ok) throw new Error(`OneDrive download failed: ${r.status}`);
    const buf = await r.buffer();
    fs.writeFileSync(localPath, buf);
    if (onProgress) onProgress(100);
    return { size: buf.length };
  }

  /** Get user display name for confirmation display. */
  async getUserInfo() {
    try {
      const accessToken = await this.getAccessToken();
      const r = await fetch(`${GRAPH_BASE}/me?$select=displayName,mail`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!r.ok) return null;
      const j = await r.json();
      return { name: j.displayName, email: j.mail };
    } catch {
      return null;
    }
  }

  disconnect() {
    this.tokenStore.delete(this.PROVIDER);
  }
}

module.exports = OneDriveProvider;
