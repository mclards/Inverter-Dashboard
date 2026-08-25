"use strict";
/**
 * gdrive.js — Google Drive adapter using Google Drive API v3.
 * Uses OAuth 2.0 Authorization Code flow for installed applications.
 *
 * Setup: Create a project in Google Cloud Console:
 *   https://console.cloud.google.com → APIs & Services → Credentials
 *   - Enable "Google Drive API"
 *   - Create OAuth 2.0 Client ID → Application type: "Desktop app"
 *   - Download the client ID and client secret
 *   - Authorized redirect URIs: http://localhost:3500/oauth/callback/gdrive
 * Enter the Client ID and Client Secret in Cloud Backup settings.
 * Note: Client secret for "Desktop app" type is not a true secret (embedded in
 * app), but is required by Google's OAuth implementation for this flow.
 */

const _nodeFetch = require("node-fetch");
const fs = require("fs");

// BR-M3 (audit 2026-05-28 §3) — bound every Drive request so a network
// partition or unreachable endpoint can't block the backup mutex forever.
// node-fetch v2's `timeout` aborts a request that exceeds N ms; 120 s caps a
// true partition while leaving room for a slow-but-alive resumable chunk.
const REQUEST_TIMEOUT_MS = 120000;
function fetch(url, opts = {}) {
  return _nodeFetch(url, opts.timeout ? opts : { ...opts, timeout: REQUEST_TIMEOUT_MS });
}

const DRIVE_BASE = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const SCOPES = "https://www.googleapis.com/auth/drive.file";
const PROVIDER_FOLDER_NAME = "InverterDashboardBackups";

function escapeDriveQueryValue(v) {
  return String(v || "")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'");
}

async function parseGoogleApiError(response) {
  const body = await response.text().catch(() => "");
  const compact = String(body || "").replace(/\s+/g, " ").trim();
  if (!compact) return { reason: "", message: "" };
  try {
    const j = JSON.parse(compact);
    const err = j?.error || {};
    const first = Array.isArray(err.errors) ? err.errors[0] : null;
    return {
      reason: String(first?.reason || "").trim(),
      message: String(err.message || compact).replace(/\s+/g, " ").trim(),
    };
  } catch {
    return { reason: "", message: compact };
  }
}

function googleApiFixHint(status, reason, message) {
  const r = String(reason || "").toLowerCase();
  const m = String(message || "").toLowerCase();
  if (status === 403 && (r === "accessnotconfigured" || m.includes("api has not been used") || m.includes("is disabled"))) {
    return "Enable Google Drive API in Google Cloud Console for the same project as this OAuth client, then wait 5-10 minutes.";
  }
  if (status === 403 && (r === "insufficientpermissions" || r === "forbidden" || m.includes("insufficient permission"))) {
    return "Disconnect then reconnect Google Drive in Dashboard, and make sure OAuth consent and required scope are granted.";
  }
  if (status === 401 || m.includes("invalid credentials")) {
    return "Disconnect then reconnect Google Drive to refresh stored tokens.";
  }
  return "";
}

async function throwGoogleApiError(response, action) {
  const { reason, message } = await parseGoogleApiError(response);
  const reasonPart = reason ? `, ${reason}` : "";
  const messagePart = message ? `: ${message}` : "";
  const hint = googleApiFixHint(response.status, reason, message);
  const hintPart = hint ? ` | Fix: ${hint}` : "";
  throw new Error(`Google Drive ${action} failed (${response.status}${reasonPart})${messagePart}${hintPart}`);
}

class GDriveProvider {
  constructor(tokenStore) {
    this.tokenStore = tokenStore;
    this.PROVIDER = "gdrive";
    this._folderIdCache = null;
    this._subFolderCache = new Map();
  }

  /** Build the Google authorization URL. */
  getAuthUrl(clientId, redirectUri, state) {
    if (!clientId) throw new Error("Google Drive Client ID not configured");
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: SCOPES,
      access_type: "offline",
      prompt: "consent select_account",
      state,
    });
    return `${AUTH_URL}?${params}`;
  }

  /** Exchange authorization code for tokens. Stores result. */
  async exchangeCode(clientId, clientSecret, code, redirectUri) {
    const params = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    });
    const r = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      throw new Error(`Google Drive token exchange failed (${r.status}): ${body}`);
    }
    const tok = await r.json();
    const tokenData = {
      access_token: tok.access_token,
      refresh_token: tok.refresh_token,
      expires_at: Date.now() + Number(tok.expires_in || 3600) * 1000,
      client_id: clientId,
      client_secret: clientSecret,
    };
    this.tokenStore.set(this.PROVIDER, tokenData);
    return tokenData;
  }

  /** Refresh expired access token. */
  async refreshToken() {
    const stored = this.tokenStore.get(this.PROVIDER);
    if (!stored?.refresh_token) throw new Error("No Google Drive refresh token stored");
    const params = new URLSearchParams({
      client_id: stored.client_id,
      client_secret: stored.client_secret,
      refresh_token: stored.refresh_token,
      grant_type: "refresh_token",
    });
    const r = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      throw new Error(`Google Drive refresh failed (${r.status}): ${body}`);
    }
    const tok = await r.json();
    const tokenData = {
      access_token: tok.access_token,
      refresh_token: tok.refresh_token || stored.refresh_token,
      expires_at: Date.now() + Number(tok.expires_in || 3600) * 1000,
      client_id: stored.client_id,
      client_secret: stored.client_secret,
    };
    this.tokenStore.set(this.PROVIDER, tokenData);
    return tokenData;
  }

  async getAccessToken() {
    if (!this.tokenStore.isConnected(this.PROVIDER)) {
      throw new Error("Google Drive not connected. Complete OAuth setup first.");
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

  /** Ensure the app folder exists in Google Drive root; return its ID. */
  async ensureFolder() {
    if (this._folderIdCache) return this._folderIdCache;
    const accessToken = await this.getAccessToken();

    // Search for existing folder.
    const q = encodeURIComponent(
      `mimeType='application/vnd.google-apps.folder' and name='${PROVIDER_FOLDER_NAME}' and trashed=false`,
    );
    const r = await fetch(`${DRIVE_BASE}/files?q=${q}&fields=files(id,name)`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!r.ok) await throwGoogleApiError(r, "folder search");
    const { files } = await r.json();

    if (files && files.length > 0) {
      this._folderIdCache = files[0].id;
      return files[0].id;
    }

    // Create folder.
    const cr = await fetch(`${DRIVE_BASE}/files`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: PROVIDER_FOLDER_NAME,
        mimeType: "application/vnd.google-apps.folder",
      }),
    });
    if (!cr.ok) await throwGoogleApiError(cr, "folder create");
    const folder = await cr.json();
    this._folderIdCache = folder.id;
    return folder.id;
  }

  /** Ensure nested folder path under app root exists; returns deepest folder ID. */
  async ensureFolderPath(pathSegments) {
    const segments = Array.isArray(pathSegments)
      ? pathSegments.map((x) => String(x || "").trim()).filter(Boolean)
      : String(pathSegments || "")
          .split("/")
          .map((x) => x.trim())
          .filter(Boolean);
    let parentId = await this.ensureFolder();
    if (!segments.length) return parentId;

    let relPath = "";
    for (const seg of segments) {
      relPath = relPath ? `${relPath}/${seg}` : seg;
      const cached = this._subFolderCache.get(relPath);
      if (cached) {
        parentId = cached;
        continue;
      }

      const q = encodeURIComponent(
        `mimeType='application/vnd.google-apps.folder' and name='${escapeDriveQueryValue(seg)}' and '${parentId}' in parents and trashed=false`,
      );
      const sr = await fetch(`${DRIVE_BASE}/files?q=${q}&fields=files(id,name)`, {
        headers: { Authorization: `Bearer ${await this.getAccessToken()}` },
      });
      if (!sr.ok) {
        await throwGoogleApiError(sr, "folder search");
      }
      const sj = await sr.json();
      if (Array.isArray(sj?.files) && sj.files.length > 0) {
        parentId = sj.files[0].id;
        this._subFolderCache.set(relPath, parentId);
        continue;
      }

      const cr = await fetch(`${DRIVE_BASE}/files`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${await this.getAccessToken()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: seg,
          mimeType: "application/vnd.google-apps.folder",
          parents: [parentId],
        }),
      });
      if (!cr.ok) {
        await throwGoogleApiError(cr, "folder create");
      }
      const created = await cr.json();
      parentId = created.id;
      this._subFolderCache.set(relPath, parentId);
    }
    return parentId;
  }

  /**
   * Upload a single file to Google Drive using resumable upload.
   * @param {string} localPath  Absolute path to local file
   * @param {string} remoteName  Remote file name in the app folder
   * @param {Function} [onProgress]  progress(0-100)
   */
  async uploadFile(localPath, remoteName, onProgress) {
    const accessToken = await this.getAccessToken();
    const cleanRemote = String(remoteName || "")
      .split("/")
      .map((x) => x.trim())
      .filter(Boolean);
    const uploadName = cleanRemote.length ? cleanRemote.pop() : "backup.bin";
    const folderId = cleanRemote.length
      ? await this.ensureFolderPath(cleanRemote)
      : await this.ensureFolder();
    const stats = fs.statSync(localPath);
    const fileSize = stats.size;

    // Check if file already exists to overwrite.
    const q = encodeURIComponent(
      `name='${escapeDriveQueryValue(uploadName)}' and '${folderId}' in parents and trashed=false`,
    );
    const existR = await fetch(`${DRIVE_BASE}/files?q=${q}&fields=files(id)`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const { files: existFiles } = existR.ok ? await existR.json() : { files: [] };
    const existId = existFiles?.[0]?.id;

    // Initiate resumable upload session.
    const uploadUrl = existId
      ? `${DRIVE_UPLOAD_BASE}/files/${existId}?uploadType=resumable`
      : `${DRIVE_UPLOAD_BASE}/files?uploadType=resumable`;
    const method = existId ? "PATCH" : "POST";
    const meta = existId
      ? { name: uploadName }
      : { name: uploadName, parents: [folderId] };

    const sessionR = await fetch(uploadUrl, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": "application/octet-stream",
        "X-Upload-Content-Length": String(fileSize),
      },
      body: JSON.stringify(meta),
    });
    if (!sessionR.ok) {
      await throwGoogleApiError(sessionR, "upload session");
    }
    const sessionUri = sessionR.headers.get("location");
    if (!sessionUri) throw new Error("Google Drive: no upload session URI");

    const CHUNK = 5 * 1024 * 1024;
    const fd = fs.openSync(localPath, "r");
    let uploaded = 0;
    let lastId = existId || null;
    try {
      while (uploaded < fileSize) {
        const end = Math.min(uploaded + CHUNK, fileSize);
        const len = end - uploaded;
        const buf = Buffer.allocUnsafe(len);
        fs.readSync(fd, buf, 0, len, uploaded);
        const r2 = await fetch(sessionUri, {
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
          const j = await r2.json();
          lastId = j.id;
        } else if (r2.status !== 308) {
          throw new Error(`Google Drive chunk upload failed: ${r2.status}`);
        }
      }
    } finally {
      fs.closeSync(fd);
    }
    return { id: lastId, name: remoteName, size: fileSize };
  }

  /** List backup subfolders in the app folder. */
  async listBackups() {
    const accessToken = await this.getAccessToken();
    let folderId;
    try {
      folderId = await this.ensureFolder();
    } catch {
      return [];
    }
    const q = encodeURIComponent(
      `mimeType='application/vnd.google-apps.folder' and '${folderId}' in parents and trashed=false`,
    );
    const r = await fetch(
      `${DRIVE_BASE}/files?q=${q}&fields=files(id,name,createdTime,size)&orderBy=createdTime desc`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!r.ok) {
      const { reason, message } = await parseGoogleApiError(r);
      const reasonPart = reason ? `, reason=${reason}` : "";
      const messagePart = message ? `, message=${message}` : "";
      console.warn(`[GDrive] listBackups failed (${r.status}${reasonPart}${messagePart})`);
      return [];
    }
    const { files } = await r.json();
    return (files || []).filter((f) => f.name.startsWith("inverter-backup-"));
  }

  /** Download a file from Google Drive by file ID. */
  async downloadFile(remoteFileId, localPath, onProgress) {
    const accessToken = await this.getAccessToken();
    const r = await fetch(
      `${DRIVE_BASE}/files/${remoteFileId}?alt=media`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!r.ok) await throwGoogleApiError(r, "download");
    const buf = await r.buffer();
    fs.writeFileSync(localPath, buf);
    if (onProgress) onProgress(100);
    return { size: buf.length };
  }

  /** Get user display name for confirmation display. */
  async getUserInfo() {
    try {
      const accessToken = await this.getAccessToken();
      const r = await fetch(
        "https://www.googleapis.com/oauth2/v2/userinfo?fields=name,email",
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (!r.ok) return null;
      const j = await r.json();
      return { name: j.name, email: j.email };
    } catch {
      return null;
    }
  }

  disconnect() {
    this._folderIdCache = null;
    this._subFolderCache.clear();
    this.tokenStore.delete(this.PROVIDER);
  }
}

module.exports = GDriveProvider;
