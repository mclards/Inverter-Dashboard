"use strict";

const fs = require("fs");
const path = require("path");
const { pipeline } = require("stream/promises");
const { promisify } = require("util");
const yauzl = require("yauzl");

const openZip = promisify(yauzl.open);
const MAX_ENTRIES = 1_000_000;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024 * 1024;
const UNIX_TYPE_MASK = 0xf000;
const UNIX_SYMLINK = 0xa000;
const UNIX_DIRECTORY = 0x4000;

function validateEntry(entry, rootDir, counters) {
  const name = String(entry?.fileName || "");
  if (!name || name.includes("\0")) throw new Error("ZIP contains an invalid empty/NUL entry name");
  if (name.includes("\\")) throw new Error(`ZIP entry uses unsupported backslashes: ${name}`);
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) {
    throw new Error(`ZIP entry is absolute: ${name}`);
  }
  const segments = name.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error(`ZIP entry escapes its extraction root: ${name}`);
  }

  const mode = (Number(entry.externalFileAttributes || 0) >>> 16) & 0xffff;
  if ((mode & UNIX_TYPE_MASK) === UNIX_SYMLINK) {
    throw new Error(`ZIP symbolic links are not allowed: ${name}`);
  }

  const size = Number(entry.uncompressedSize || 0);
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ENTRY_BYTES) {
    throw new Error(`ZIP entry exceeds the extraction limit: ${name}`);
  }
  counters.entries += 1;
  counters.bytes += size;
  if (counters.entries > MAX_ENTRIES || counters.bytes > MAX_TOTAL_BYTES) {
    throw new Error("ZIP archive exceeds the extraction entry/size limits");
  }

  const destination = path.resolve(rootDir, ...segments);
  if (destination !== rootDir && !destination.startsWith(`${rootDir}${path.sep}`)) {
    throw new Error(`ZIP entry escapes its extraction root: ${name}`);
  }
  const isDirectory = name.endsWith("/") || (mode & UNIX_TYPE_MASK) === UNIX_DIRECTORY;
  return { destination, isDirectory };
}

async function assertNoSymlinkParents(rootDir, destination) {
  const relative = path.relative(rootDir, path.dirname(destination));
  let current = rootDir;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = await fs.promises.lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`Extraction parent is a symbolic link: ${current}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

async function safeExtractZip(zipPath, options = {}) {
  if (!path.isAbsolute(String(options.dir || ""))) {
    throw new Error("ZIP extraction target must be an absolute path");
  }
  const requestedRoot = path.resolve(options.dir);
  await fs.promises.mkdir(requestedRoot, { recursive: true, mode: 0o700 });
  const rootDir = await fs.promises.realpath(requestedRoot);
  const zipfile = await openZip(zipPath, {
    lazyEntries: true,
    decodeStrings: true,
    validateEntrySizes: true,
  });
  const counters = { entries: 0, bytes: 0 };

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      try { zipfile.close(); } catch (_) {}
      reject(error);
    };

    zipfile.once("error", fail);
    zipfile.once("end", () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    zipfile.on("entry", (entry) => {
      (async () => {
        const { destination, isDirectory } = validateEntry(entry, rootDir, counters);
        await assertNoSymlinkParents(rootDir, destination);
        if (isDirectory) {
          await fs.promises.mkdir(destination, { recursive: true, mode: 0o700 });
          zipfile.readEntry();
          return;
        }
        await fs.promises.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        await assertNoSymlinkParents(rootDir, destination);
        const readStream = await promisify(zipfile.openReadStream.bind(zipfile))(entry);
        await pipeline(readStream, fs.createWriteStream(destination, { flags: "w", mode: 0o600 }));
        zipfile.readEntry();
      })().catch(fail);
    });
    zipfile.readEntry();
  });
}

module.exports = { safeExtractZip, validateEntry };
