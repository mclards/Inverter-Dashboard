"use strict";
/**
 * s3.js — S3-compatible object storage adapter.
 *
 * Supports AWS S3 and S3-compatible providers such as Backblaze B2, Wasabi,
 * Cloudflare R2, IDrive e2, MinIO, and similar services.
 *
 * Authentication is static-key based, not OAuth.
 * Bucket lifecycle is operator-managed: this adapter validates and uses an
 * existing bucket/prefix but does not create or delete the bucket itself.
 */

const fs = require("fs");
const path = require("path");
const { promisify } = require("util");
const { pipeline } = require("stream");
const {
  S3Client,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");
const { NodeHttpHandler } = require("@smithy/node-http-handler");

const pipelineAsync = promisify(pipeline);
const PROVIDER_PREFIX_DEFAULT = "InverterDashboardBackups";

// BR-M3 (audit 2026-05-28 §3): bound every S3 request so a network partition
// or unreachable endpoint cannot block the backup mutex indefinitely.
// connectionTimeout bounds the TCP/TLS handshake; requestTimeout is a
// socket-inactivity (idle) timeout — it does NOT kill a slow-but-progressing
// transfer, only one that stalls with no bytes flowing.
const S3_CONNECTION_TIMEOUT_MS = 15000;
const S3_REQUEST_TIMEOUT_MS = 120000;

function normalizePrefix(prefix) {
  return String(prefix || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

function joinKey(prefix, relative) {
  const base = normalizePrefix(prefix);
  const rel = normalizePrefix(relative);
  if (base && rel) return `${base}/${rel}`;
  return base || rel;
}

function relativeKey(basePrefix, fullKey) {
  const base = normalizePrefix(basePrefix);
  const key = normalizePrefix(fullKey);
  if (!base) return key;
  if (key === base) return "";
  if (key.startsWith(`${base}/`)) return key.slice(base.length + 1);
  return key;
}

class S3CompatibleProvider {
  constructor(tokenStore, getSettings) {
    this.tokenStore = tokenStore;
    this.getSettings = typeof getSettings === "function" ? getSettings : () => ({});
    this.PROVIDER = "s3";
  }

  _getConfig() {
    const settings = this.getSettings() || {};
    const s3 = settings && typeof settings.s3 === "object" ? settings.s3 : {};
    const endpoint = String(s3.endpoint || "").trim();
    const region = String(s3.region || "").trim() || (endpoint ? "auto" : "us-east-1");
    const bucket = String(s3.bucket || "").trim();
    const prefix = normalizePrefix(s3.prefix || PROVIDER_PREFIX_DEFAULT);
    const forcePathStyle = Boolean(s3.forcePathStyle);
    return { endpoint, region, bucket, prefix, forcePathStyle };
  }

  _getStoredCredentials() {
    const creds = this.tokenStore.get(this.PROVIDER) || {};
    return {
      accessKeyId: String(creds.accessKeyId || "").trim(),
      secretAccessKey: String(creds.secretAccessKey || "").trim(),
    };
  }

  _requireSettings() {
    const cfg = this._getConfig();
    if (!cfg.bucket) throw new Error("S3 bucket not configured");
    return cfg;
  }

  _buildClient(config = null, credentials = null) {
    const cfg = config || this._requireSettings();
    const creds = credentials || this._getStoredCredentials();
    if (!creds.accessKeyId || !creds.secretAccessKey) {
      throw new Error("S3 access key ID and secret access key are required");
    }
    const clientConfig = {
      region: cfg.region,
      credentials: {
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
      },
      // BR-M3 — per-request connection + idle timeouts (see constants above).
      requestHandler: new NodeHttpHandler({
        connectionTimeout: S3_CONNECTION_TIMEOUT_MS,
        requestTimeout: S3_REQUEST_TIMEOUT_MS,
      }),
    };
    if (cfg.endpoint) clientConfig.endpoint = cfg.endpoint;
    if (cfg.forcePathStyle) clientConfig.forcePathStyle = true;
    return new S3Client(clientConfig);
  }

  isConnected() {
    const cfg = this._getConfig();
    const creds = this._getStoredCredentials();
    return Boolean(cfg.bucket && creds.accessKeyId && creds.secretAccessKey);
  }

  async connect({ accessKeyId, secretAccessKey }) {
    const cfg = this._requireSettings();
    const stored = this._getStoredCredentials();
    const nextAccessKeyId = String(accessKeyId || "").trim();
    const nextSecretAccessKey = String(secretAccessKey || "").trim();
    if ((nextAccessKeyId && !nextSecretAccessKey) || (!nextAccessKeyId && nextSecretAccessKey)) {
      throw new Error("Enter both S3 access key ID and secret access key, or leave both blank to keep the stored credentials");
    }
    const creds = {
      accessKeyId: nextAccessKeyId || stored.accessKeyId,
      secretAccessKey: nextSecretAccessKey || stored.secretAccessKey,
    };
    if (!creds.accessKeyId || !creds.secretAccessKey) {
      throw new Error("Missing S3 access key ID or secret access key");
    }
    const client = this._buildClient(cfg, creds);
    await client.send(new HeadBucketCommand({ Bucket: cfg.bucket }));

    // Validate write/delete access with a small probe object under the configured prefix.
    const probeKey = joinKey(
      cfg.prefix,
      `.adsi-connectivity-test-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
    );
    await client.send(
      new PutObjectCommand({
        Bucket: cfg.bucket,
        Key: probeKey,
        Body: Buffer.from("ok", "utf8"),
        ContentType: "text/plain",
      }),
    );
    await client.send(
      new DeleteObjectCommand({
        Bucket: cfg.bucket,
        Key: probeKey,
      }),
    );

    this.tokenStore.set(this.PROVIDER, {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
    });

    return {
      bucket: cfg.bucket,
      endpoint: cfg.endpoint || "aws-s3",
      prefix: cfg.prefix,
      region: cfg.region,
    };
  }

  async uploadFile(localPath, remoteName, onProgress) {
    const cfg = this._requireSettings();
    const key = joinKey(cfg.prefix, remoteName);
    const size = fs.statSync(localPath).size;
    const upload = new Upload({
      client: this._buildClient(cfg),
      params: {
        Bucket: cfg.bucket,
        Key: key,
        Body: fs.createReadStream(localPath),
      },
      queueSize: 3,
      partSize: Math.max(5 * 1024 * 1024, Math.min(size || 0, 16 * 1024 * 1024) || 5 * 1024 * 1024),
      leavePartsOnError: false,
    });
    if (typeof onProgress === "function") {
      upload.on("httpUploadProgress", (evt) => {
        const total = Number(evt?.total || size || 0);
        const loaded = Number(evt?.loaded || 0);
        if (total > 0) onProgress(Math.max(0, Math.min(100, Math.round((loaded / total) * 100))));
      });
    }
    await upload.done();
    if (typeof onProgress === "function") onProgress(100);
    return { id: key, name: path.basename(String(remoteName || "")), size };
  }

  async uploadBuffer(buffer, remoteName) {
    const cfg = this._requireSettings();
    const key = joinKey(cfg.prefix, remoteName);
    const body = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || "");
    await this._buildClient(cfg).send(
      new PutObjectCommand({
        Bucket: cfg.bucket,
        Key: key,
        Body: body,
      }),
    );
    return { id: key, name: path.basename(String(remoteName || "")), size: body.length };
  }

  async objectExists(remoteName) {
    const cfg = this._requireSettings();
    const key = joinKey(cfg.prefix, remoteName);
    try {
      await this._buildClient(cfg).send(
        new HeadObjectCommand({
          Bucket: cfg.bucket,
          Key: key,
        }),
      );
      return true;
    } catch (err) {
      const status = Number(err?.$metadata?.httpStatusCode || 0);
      const code = String(err?.name || err?.Code || "").trim();
      if (status === 404 || code === "NotFound" || code === "NoSuchKey") {
        return false;
      }
      throw err;
    }
  }

  async listBackups() {
    if (!this.isConnected()) return [];
    const cfg = this._requireSettings();
    const client = this._buildClient(cfg);
    const prefix = cfg.prefix ? `${cfg.prefix}/` : "";
    const manifestSuffix = "/manifest.json";
    const found = new Map();
    let continuationToken = undefined;
    do {
      const resp = await client.send(
        new ListObjectsV2Command({
          Bucket: cfg.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
          MaxKeys: 1000,
        }),
      );
      const contents = Array.isArray(resp?.Contents) ? resp.Contents : [];
      for (const entry of contents) {
        const key = String(entry?.Key || "");
        if (!key.endsWith(manifestSuffix)) continue;
        const rel = relativeKey(cfg.prefix, key);
        const backupName = rel.slice(0, -manifestSuffix.length);
        if (!backupName.startsWith("inverter-backup-")) continue;
        const prev = found.get(backupName);
        const nextTime = entry?.LastModified ? new Date(entry.LastModified).toISOString() : null;
        if (!prev || (nextTime && String(nextTime) > String(prev.createdTime || ""))) {
          found.set(backupName, {
            id: backupName,
            name: backupName,
            createdTime: nextTime,
            lastModifiedDateTime: nextTime,
          });
        }
      }
      continuationToken = resp?.IsTruncated ? resp?.NextContinuationToken : undefined;
    } while (continuationToken);
    return Array.from(found.values()).sort((a, b) => {
      const ta = Date.parse(a.createdTime || 0) || 0;
      const tb = Date.parse(b.createdTime || 0) || 0;
      return tb - ta;
    });
  }

  async listBackupFiles(backupId) {
    const cfg = this._requireSettings();
    const client = this._buildClient(cfg);
    const safeBackupId = normalizePrefix(backupId);
    const prefix = joinKey(cfg.prefix, `${safeBackupId}/`);
    const files = [];
    let continuationToken = undefined;
    do {
      const resp = await client.send(
        new ListObjectsV2Command({
          Bucket: cfg.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
          MaxKeys: 1000,
        }),
      );
      const contents = Array.isArray(resp?.Contents) ? resp.Contents : [];
      for (const entry of contents) {
        const key = String(entry?.Key || "");
        if (!key || key.endsWith("/")) continue;
        files.push({
          id: key,
          name: relativeKey(prefix, key),
        });
      }
      continuationToken = resp?.IsTruncated ? resp?.NextContinuationToken : undefined;
    } while (continuationToken);
    return files;
  }

  async downloadFile(remoteKey, localPath, onProgress) {
    const cfg = this._requireSettings();
    const client = this._buildClient(cfg);
    const resp = await client.send(
      new GetObjectCommand({
        Bucket: cfg.bucket,
        Key: String(remoteKey || ""),
      }),
    );
    const total = Number(resp?.ContentLength || 0);
    const body = resp?.Body;
    if (!body || typeof body.pipe !== "function") {
      throw new Error("S3 download body is not a readable stream");
    }
    let loaded = 0;
    if (typeof onProgress === "function") {
      body.on("data", (chunk) => {
        loaded += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk || ""));
        if (total > 0) onProgress(Math.max(0, Math.min(100, Math.round((loaded / total) * 100))));
      });
    }
    await pipelineAsync(body, fs.createWriteStream(localPath));
    if (typeof onProgress === "function") onProgress(100);
    return { size: total || fs.statSync(localPath).size };
  }

  async downloadBuffer(remoteKey) {
    const cfg = this._requireSettings();
    const client = this._buildClient(cfg);
    const resp = await client.send(
      new GetObjectCommand({
        Bucket: cfg.bucket,
        Key: String(remoteKey || ""),
      }),
    );
    const body = resp?.Body;
    if (!body) {
      throw new Error("S3 download body is missing");
    }
    const chunks = [];
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  disconnect() {
    this.tokenStore.delete(this.PROVIDER);
  }
}

module.exports = S3CompatibleProvider;
