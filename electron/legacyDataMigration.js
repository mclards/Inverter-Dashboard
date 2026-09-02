"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const MIGRATION_VERSION = 1;
const REQUEST_FILE_NAME = "legacy-import-request-v1.txt";
const MANIFEST_SCHEMA_VERSION = 1;

// These are append-only event/history tables whose INTEGER PRIMARY KEY values
// are local surrogate identifiers. If an independently-written legacy DB used
// the same id for different content, retaining both rows under distinct ids is
// safer than silently dropping the legacy row.
const SAFE_INTEGER_PK_REMAP_TABLES = new Set([
  "readings",
  "energy_5min",
  "alarms",
  "audit_log",
  "chat_messages",
  "daily_report",
  "scheduled_maintenance",
  "inverter_clock_sync_log",
  "inverter_stop_reasons",
  "inverter_stop_histogram",
  "inverter_stop_reasons_std",
  "serial_change_log",
  "firmware_drift_log",
  "inverter_critical_blocks",
  "calibration_write_log",
  "calibration_snapshot",
  "apc_verify_log",
  "grid_control_verify_log",
]);

function nowRunId(now = Date.now()) {
  return new Date(now).toISOString().replace(/[-:.]/g, "");
}

function quoteIdent(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function quoteString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function ensureInside(root, candidate) {
  const base = path.resolve(root);
  const resolved = path.resolve(candidate);
  const relative = path.relative(base, resolved);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return resolved;
  throw new Error(`Migration path escapes target root: ${candidate}`);
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let read = 0;
    do {
      read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read > 0) hash.update(buffer.subarray(0, read));
    } while (read > 0);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function atomicCopyFile(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temp = `${destination}.migration-${process.pid}-${Date.now()}.tmp`;
  try {
    fs.copyFileSync(source, temp);
    const sourceSize = fs.statSync(source).size;
    const copiedSize = fs.statSync(temp).size;
    if (sourceSize !== copiedSize) {
      throw new Error(`copied size ${copiedSize} does not match source size ${sourceSize}`);
    }
    fs.renameSync(temp, destination);
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch (_) {}
    throw error;
  }
}

function atomicWriteJson(destination, value) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temp = `${destination}.migration-${process.pid}-${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.renameSync(temp, destination);
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch (_) {}
    throw error;
  }
}

function canonicalFingerprintValue(value) {
  if (value === null || value === undefined) return "n:";
  if (Buffer.isBuffer(value)) return `b:${value.toString("base64")}`;
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "d:nan";
    if (!Number.isFinite(value)) return `d:${value > 0 ? "inf" : "-inf"}`;
    return `d:${Object.is(value, -0) ? "-0" : String(value)}`;
  }
  if (typeof value === "bigint") return `i:${value.toString()}`;
  return `s:${String(value)}`;
}

function rowFingerprint(...values) {
  const hash = crypto.createHash("sha256");
  for (const value of values) {
    const encoded = canonicalFingerprintValue(value);
    hash.update(String(Buffer.byteLength(encoded)), "utf8");
    hash.update(":", "utf8");
    hash.update(encoded, "utf8");
    hash.update(";", "utf8");
  }
  return hash.digest("hex");
}

function quickCheck(Database, databasePath) {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const result = String(db.prepare("PRAGMA quick_check(1)").pluck().get() || "").trim().toLowerCase();
    if (result !== "ok") throw new Error(`SQLite quick_check failed: ${result || "unknown"}`);
    return "ok";
  } finally {
    db.close();
  }
}

function countUserRows(Database, databasePath) {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).pluck().all();
    return tables.reduce((sum, tableName) => {
      return sum + Number(db.prepare(`SELECT COUNT(*) FROM ${quoteIdent(tableName)}`).pluck().get() || 0);
    }, 0);
  } finally {
    db.close();
  }
}

async function snapshotDatabase(Database, sourcePath, snapshotPath) {
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
  try { fs.rmSync(snapshotPath, { force: true }); } catch (_) {}
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    const sourceCheck = String(source.prepare("PRAGMA quick_check(1)").pluck().get() || "").trim().toLowerCase();
    if (sourceCheck !== "ok") throw new Error(`source SQLite quick_check failed: ${sourceCheck || "unknown"}`);
    await source.backup(snapshotPath);
  } finally {
    source.close();
  }
  quickCheck(Database, snapshotPath);
  return snapshotPath;
}

function tableInfo(db, schema, tableName) {
  return db.prepare(`PRAGMA ${quoteIdent(schema)}.table_info(${quoteString(tableName)})`).all();
}

function tableExists(db, schema, tableName) {
  return Boolean(db.prepare(
    `SELECT 1 FROM ${quoteIdent(schema)}.sqlite_master WHERE type='table' AND name=?`,
  ).get(tableName));
}

function tableSql(db, schema, tableName) {
  return String(db.prepare(
    `SELECT sql FROM ${quoteIdent(schema)}.sqlite_master WHERE type='table' AND name=?`,
  ).pluck().get(tableName) || "");
}

function nullSafeDifference(leftAlias, rightAlias, columns) {
  return columns.length
    ? columns.map((column) => `${leftAlias}.${quoteIdent(column)} IS NOT ${rightAlias}.${quoteIdent(column)}`).join(" OR ")
    : "0";
}

function primaryKeyJoin(leftAlias, rightAlias, columns) {
  return columns.map((column) => `${leftAlias}.${quoteIdent(column)} IS ${rightAlias}.${quoteIdent(column)}`).join(" AND ");
}

function createFingerprintTempTable(db, tableName, columns) {
  const tempName = `_legacy_fp_${crypto.createHash("sha1").update(tableName).digest("hex").slice(0, 12)}`;
  db.exec(`DROP TABLE IF EXISTS temp.${quoteIdent(tempName)}`);
  db.exec(`CREATE TEMP TABLE ${quoteIdent(tempName)} (fp TEXT PRIMARY KEY)`);
  const args = columns.map((column) => `d.${quoteIdent(column)}`).join(", ");
  db.exec(
    `INSERT OR IGNORE INTO temp.${quoteIdent(tempName)} (fp) ` +
    `SELECT legacy_migration_fp(${args}) FROM main.${quoteIdent(tableName)} d`,
  );
  return tempName;
}

function mergeTable(db, tableName) {
  const sourceInfo = tableInfo(db, "legacy", tableName);
  if (!sourceInfo.length) return { table: tableName, action: "skipped", reason: "no-source-columns" };

  if (!tableExists(db, "main", tableName)) {
    const createSql = tableSql(db, "legacy", tableName);
    if (!createSql) throw new Error(`source table ${tableName} has no CREATE TABLE SQL`);
    const copyNewTable = db.transaction(() => {
      db.exec(createSql);
      const columns = sourceInfo.map((column) => column.name);
      const names = columns.map(quoteIdent).join(", ");
      const result = db.prepare(
        `INSERT INTO main.${quoteIdent(tableName)} (${names}) ` +
        `SELECT ${names} FROM legacy.${quoteIdent(tableName)}`,
      ).run();
      return Number(result.changes || 0);
    });
    return { table: tableName, action: "created", inserted: copyNewTable(), conflicts: 0, remapped: 0 };
  }

  const destinationInfo = tableInfo(db, "main", tableName);
  const destinationColumns = new Set(destinationInfo.map((column) => column.name));
  const common = sourceInfo.map((column) => column.name).filter((name) => destinationColumns.has(name));
  const sourceOnly = sourceInfo.map((column) => column.name).filter((name) => !destinationColumns.has(name));
  if (!common.length) throw new Error(`table ${tableName} has no columns shared with destination`);

  const pkColumns = destinationInfo
    .filter((column) => Number(column.pk) > 0 && common.includes(column.name))
    .sort((a, b) => Number(a.pk) - Number(b.pk))
    .map((column) => column.name);
  const commonSql = common.map(quoteIdent).join(", ");
  const sourceCount = Number(db.prepare(`SELECT COUNT(*) FROM legacy.${quoteIdent(tableName)}`).pluck().get() || 0);
  const destinationBefore = Number(db.prepare(`SELECT COUNT(*) FROM main.${quoteIdent(tableName)}`).pluck().get() || 0);
  let inserted = 0;
  let conflicts = 0;
  let remapped = 0;
  let conflictKeys = [];

  const merge = db.transaction(() => {
    if (!pkColumns.length) {
      const fpTable = createFingerprintTempTable(db, tableName, common);
      const fpArgs = common.map((column) => `s.${quoteIdent(column)}`).join(", ");
      const result = db.prepare(
        `INSERT INTO main.${quoteIdent(tableName)} (${commonSql}) ` +
        `SELECT ${common.map((column) => `s.${quoteIdent(column)}`).join(", ")} ` +
        `FROM legacy.${quoteIdent(tableName)} s ` +
        `LEFT JOIN temp.${quoteIdent(fpTable)} f ON f.fp=legacy_migration_fp(${fpArgs}) ` +
        `WHERE f.fp IS NULL GROUP BY legacy_migration_fp(${fpArgs})`,
      ).run();
      inserted += Number(result.changes || 0);
      db.exec(`DROP TABLE IF EXISTS temp.${quoteIdent(fpTable)}`);
      return;
    }

    const pkJoin = primaryKeyJoin("d", "s", pkColumns);
    const result = db.prepare(
      `INSERT INTO main.${quoteIdent(tableName)} (${commonSql}) ` +
      `SELECT ${common.map((column) => `s.${quoteIdent(column)}`).join(", ")} ` +
      `FROM legacy.${quoteIdent(tableName)} s ` +
      `WHERE NOT EXISTS (` +
        `SELECT 1 FROM main.${quoteIdent(tableName)} d WHERE ${pkJoin}` +
      `)`,
    ).run();
    inserted += Number(result.changes || 0);

    const nonPkColumns = common.filter((column) => !pkColumns.includes(column));
    if (!nonPkColumns.length) return;
    const differs = nullSafeDifference("d", "s", nonPkColumns);
    conflicts = Number(db.prepare(
      `SELECT COUNT(*) FROM legacy.${quoteIdent(tableName)} s ` +
      `JOIN main.${quoteIdent(tableName)} d ON ${pkJoin} WHERE (${differs})`,
    ).pluck().get() || 0);
    if (conflicts > 0) {
      conflictKeys = db.prepare(
        `SELECT ${pkColumns.map((column) => `s.${quoteIdent(column)} AS ${quoteIdent(column)}`).join(", ")} ` +
        `FROM legacy.${quoteIdent(tableName)} s ` +
        `JOIN main.${quoteIdent(tableName)} d ON ${pkJoin} WHERE (${differs}) LIMIT 100`,
      ).all();
    }

    const pkInfo = destinationInfo.filter((column) => pkColumns.includes(column.name));
    const canRemap = pkColumns.length === 1
      && /INT/i.test(String(pkInfo[0]?.type || ""))
      && SAFE_INTEGER_PK_REMAP_TABLES.has(tableName);
    if (!canRemap || conflicts === 0) return;

    const fpTable = createFingerprintTempTable(db, tableName, nonPkColumns);
    const sourceFpArgs = nonPkColumns.map((column) => `s.${quoteIdent(column)}`).join(", ");
    const nonPkSql = nonPkColumns.map(quoteIdent).join(", ");
    const remapResult = db.prepare(
      `INSERT OR IGNORE INTO main.${quoteIdent(tableName)} (${nonPkSql}) ` +
      `SELECT ${nonPkColumns.map((column) => `s.${quoteIdent(column)}`).join(", ")} ` +
      `FROM legacy.${quoteIdent(tableName)} s ` +
      `JOIN main.${quoteIdent(tableName)} d ON ${pkJoin} ` +
      `LEFT JOIN temp.${quoteIdent(fpTable)} f ON f.fp=legacy_migration_fp(${sourceFpArgs}) ` +
      `WHERE (${differs}) AND f.fp IS NULL ` +
      `GROUP BY legacy_migration_fp(${sourceFpArgs})`,
    ).run();
    remapped = Number(remapResult.changes || 0);
    inserted += remapped;
    db.exec(`DROP TABLE IF EXISTS temp.${quoteIdent(fpTable)}`);
  });

  merge();
  const destinationAfter = Number(db.prepare(`SELECT COUNT(*) FROM main.${quoteIdent(tableName)}`).pluck().get() || 0);
  return {
    table: tableName,
    action: "merged",
    sourceRows: sourceCount,
    destinationRowsBefore: destinationBefore,
    destinationRowsAfter: destinationAfter,
    inserted,
    conflicts,
    remapped,
    unresolvedConflicts: Math.max(0, conflicts - remapped),
    conflictKeys,
    conflictKeysTruncated: conflicts > conflictKeys.length,
    sourceOnlyColumns: sourceOnly,
  };
}

async function mergeDatabase(options) {
  const {
    Database,
    sourcePath,
    destinationPath,
    snapshotPath,
    backupPath,
  } = options;
  const result = {
    kind: "sqlite",
    source: sourcePath,
    destination: destinationPath,
    action: "pending",
    tables: [],
    errors: [],
  };

  if (!fs.existsSync(sourcePath)) {
    result.action = "missing-source";
    return result;
  }

  await snapshotDatabase(Database, sourcePath, snapshotPath);
  result.sourceSnapshot = snapshotPath;
  result.sourceSha256 = sha256File(snapshotPath);

  if (!fs.existsSync(destinationPath)) {
    atomicCopyFile(snapshotPath, destinationPath);
    quickCheck(Database, destinationPath);
    result.insertedRows = countUserRows(Database, destinationPath);
    result.destinationSha256 = sha256File(destinationPath);
    result.action = "copied-new";
    try { fs.rmSync(snapshotPath, { force: true }); } catch (_) {}
    delete result.sourceSnapshot;
    return result;
  }

  quickCheck(Database, destinationPath);
  await snapshotDatabase(Database, destinationPath, backupPath);
  result.destinationBackup = backupPath;
  result.destinationSha256Before = sha256File(backupPath);
  if (result.sourceSha256 === result.destinationSha256Before) {
    result.action = "identical";
    result.destinationSha256 = result.destinationSha256Before;
    try { fs.rmSync(snapshotPath, { force: true }); } catch (_) {}
    delete result.sourceSnapshot;
    return result;
  }

  const destination = new Database(destinationPath);
  let rolledBack = false;
  try {
    destination.pragma("busy_timeout = 5000");
    destination.pragma("foreign_keys = OFF");
    destination.function("legacy_migration_fp", { deterministic: true, varargs: true }, rowFingerprint);
    destination.prepare("ATTACH DATABASE ? AS legacy").run(snapshotPath);
    try {
      const mergeAllTables = destination.transaction(() => {
        const tables = destination.prepare(
          "SELECT name FROM legacy.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        ).pluck().all();
        for (const rawName of tables) {
          const tableName = String(rawName || "");
          if (!tableName) continue;
          try {
            result.tables.push(mergeTable(destination, tableName));
          } catch (error) {
            result.errors.push({ table: tableName, error: String(error.message || error) });
          }
        }
        if (result.errors.length) {
          throw new Error("one or more tables could not be merged; database merge rolled back");
        }
        const foreignKeyViolations = destination.prepare("PRAGMA foreign_key_check").all();
        if (foreignKeyViolations.length) {
          result.errors.push({
            database: destinationPath,
            error: `foreign_key_check found ${foreignKeyViolations.length} violation(s)`,
          });
          throw new Error("foreign-key validation failed; database merge rolled back");
        }
      });
      try {
        mergeAllTables();
      } catch (error) {
        rolledBack = true;
        if (!result.errors.length) {
          result.errors.push({ database: destinationPath, error: String(error.message || error) });
        }
      }
    } finally {
      try { destination.exec("DETACH DATABASE legacy"); } catch (_) {}
    }
    const check = String(destination.prepare("PRAGMA quick_check(1)").pluck().get() || "").trim().toLowerCase();
    if (check !== "ok") throw new Error(`destination SQLite quick_check failed after merge: ${check || "unknown"}`);
  } catch (error) {
    result.errors.push({ database: destinationPath, error: String(error.message || error) });
  } finally {
    destination.close();
  }

  result.destinationSha256 = sha256File(destinationPath);
  result.action = result.errors.length ? "failed-rolled-back" : "merged";
  result.rolledBack = rolledBack;
  result.insertedRows = rolledBack
    ? 0
    : result.tables.reduce((sum, table) => sum + Number(table.inserted || 0), 0);
  result.conflictingRows = result.tables.reduce((sum, table) => sum + Number(table.conflicts || 0), 0);
  result.remappedRows = result.tables.reduce((sum, table) => sum + Number(table.remapped || 0), 0);
  result.unresolvedConflicts = result.tables.reduce(
    (sum, table) => sum + Number(table.unresolvedConflicts || 0) + Number(table.sourceOnlyColumns?.length || 0),
    0,
  );
  return result;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validIpv4(value) {
  const parts = String(value || "").trim().split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

function validateTopology(value) {
  if (!isPlainObject(value)) return { ok: false, error: "topology root must be an object" };
  for (const key of ["inverters", "poll_interval", "units", "losses"]) {
    if (!isPlainObject(value[key])) return { ok: false, error: `topology ${key} must be an object map` };
  }
  const inverterKeys = Object.keys(value.inverters).sort();
  for (const mapName of ["poll_interval", "units", "losses"]) {
    const mapKeys = Object.keys(value[mapName]).sort();
    if (JSON.stringify(mapKeys) !== JSON.stringify(inverterKeys)) {
      return { ok: false, error: `topology ${mapName} keys must match inverters keys` };
    }
  }
  for (const [key, ip] of Object.entries(value.inverters)) {
    if (!/^\d+$/.test(key) || Number(key) < 1 || Number(key) > 27 || !validIpv4(ip)) {
      return { ok: false, error: `invalid inverter entry ${key}` };
    }
    if (!Array.isArray(value.units[key])) return { ok: false, error: `units.${key} must be an array` };
    if (!value.units[key].every((unit) => Number.isInteger(unit) && unit >= 1 && unit <= 4)) {
      return { ok: false, error: `units.${key} contains an invalid N1-N4 node` };
    }
    if (new Set(value.units[key]).size !== value.units[key].length) {
      return { ok: false, error: `units.${key} contains duplicate nodes` };
    }
    const poll = Number(value.poll_interval[key]);
    const loss = Number(value.losses[key]);
    if (!Number.isFinite(poll) || poll <= 0) return { ok: false, error: `poll_interval.${key} is invalid` };
    if (!Number.isFinite(loss) || loss < 0) return { ok: false, error: `losses.${key} is invalid` };
  }
  return { ok: true };
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function copyConflict(source, targetRoot, conflictRoot, destinationPath) {
  const relative = path.relative(targetRoot, destinationPath);
  const safeRelative = relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? relative
    : path.basename(destinationPath);
  const hash = sha256File(source);
  const conflictPath = ensureInside(conflictRoot, path.join(conflictRoot, `${safeRelative}.legacy-${hash.slice(0, 12)}`));
  atomicCopyFile(source, conflictPath);
  return { conflictPath, sourceSha256: hash };
}

function migrateTopology(source, destination, context) {
  const item = { kind: "topology", source, destination, action: "pending" };
  let sourceValue;
  try {
    sourceValue = readJsonFile(source);
  } catch (error) {
    item.action = "invalid-source";
    item.error = `invalid JSON: ${error.message}`;
    return item;
  }
  const sourceValidation = validateTopology(sourceValue);
  if (!sourceValidation.ok) {
    item.action = "invalid-source";
    item.error = sourceValidation.error;
    return item;
  }
  if (!fs.existsSync(destination)) {
    atomicWriteJson(destination, sourceValue);
    item.action = "copied-new";
    item.sourceSha256 = sha256File(source);
    item.destinationSha256 = sha256File(destination);
    return item;
  }
  const sourceHash = sha256File(source);
  const destinationHash = sha256File(destination);
  item.sourceSha256 = sourceHash;
  item.destinationSha256Before = destinationHash;
  if (sourceHash === destinationHash) {
    item.action = "identical";
    return item;
  }
  let destinationValue;
  try {
    destinationValue = readJsonFile(destination);
  } catch (error) {
    const conflict = copyConflict(source, context.targetRoot, context.conflictRoot, destination);
    item.action = "conflict-preserved";
    item.error = `destination JSON is invalid: ${error.message}`;
    Object.assign(item, conflict);
    return item;
  }
  const destinationValidation = validateTopology(destinationValue);
  if (!destinationValidation.ok) {
    const conflict = copyConflict(source, context.targetRoot, context.conflictRoot, destination);
    item.action = "conflict-preserved";
    item.error = `destination topology is invalid: ${destinationValidation.error}`;
    Object.assign(item, conflict);
    return item;
  }

  const merged = JSON.parse(JSON.stringify(destinationValue));
  const added = [];
  const conflicts = [];
  for (const key of Object.keys(sourceValue.inverters)) {
    if (!Object.prototype.hasOwnProperty.call(merged.inverters, key)) {
      merged.inverters[key] = sourceValue.inverters[key];
      merged.poll_interval[key] = sourceValue.poll_interval[key];
      merged.units[key] = sourceValue.units[key];
      merged.losses[key] = sourceValue.losses[key];
      added.push(key);
      continue;
    }
    const fields = ["inverters", "poll_interval", "units", "losses"];
    if (fields.some((field) => JSON.stringify(merged[field][key]) !== JSON.stringify(sourceValue[field][key]))) {
      conflicts.push(key);
    }
  }
  if (added.length) {
    const backup = ensureInside(
      context.backupRoot,
      path.join(context.backupRoot, `ipconfig-before-${context.runId}.json`),
    );
    atomicCopyFile(destination, backup);
    atomicWriteJson(destination, merged);
    item.destinationBackup = backup;
  }
  if (conflicts.length) {
    Object.assign(item, copyConflict(source, context.targetRoot, context.conflictRoot, destination));
  }
  item.action = conflicts.length ? "merged-with-conflicts" : added.length ? "merged" : "different-no-missing-records";
  item.addedInverters = added;
  item.conflictingInverters = conflicts;
  item.destinationSha256 = sha256File(destination);
  return item;
}

function migrateOrdinaryFile(source, destination, context) {
  const item = { kind: "file", source, destination, action: "pending" };
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
    item.action = "missing-source";
    return item;
  }
  item.sourceSha256 = sha256File(source);
  if (!fs.existsSync(destination)) {
    atomicCopyFile(source, destination);
    item.action = "copied-new";
    item.destinationSha256 = sha256File(destination);
    return item;
  }
  item.destinationSha256Before = sha256File(destination);
  if (item.sourceSha256 === item.destinationSha256Before) {
    item.action = "identical";
    item.destinationSha256 = item.destinationSha256Before;
    return item;
  }
  Object.assign(item, copyConflict(source, context.targetRoot, context.conflictRoot, destination));
  item.action = "conflict-preserved";
  item.destinationSha256 = item.destinationSha256Before;
  return item;
}

function walkFiles(root) {
  if (!fs.existsSync(root)) return [];
  const output = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) output.push(full);
    }
  };
  visit(root);
  return output.sort((a, b) => a.localeCompare(b));
}

function firstExisting(paths) {
  return paths.find((candidate) => fs.existsSync(candidate)) || "";
}

function legacyInventory(sourceRoot) {
  if (!fs.existsSync(sourceRoot)) return [];
  return walkFiles(sourceRoot).filter((file) => !/-wal$|-shm$/i.test(file));
}

function processIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function acquireMigrationLock(lockPath) {
  const open = () => {
    const fd = fs.openSync(lockPath, "wx");
    fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, startedAt: Date.now() })}\n`, "utf8");
    fs.fsyncSync(fd);
    return fd;
  };
  try {
    return { fd: open(), recoveredStaleLock: false };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let owner = null;
    try { owner = JSON.parse(fs.readFileSync(lockPath, "utf8")); } catch (_) {}
    if (owner && processIsRunning(Number(owner.pid))) {
      return { fd: null, recoveredStaleLock: false, busyOwnerPid: Number(owner.pid) };
    }
    // The previous process died before clearing the lock. The request marker
    // and its source/destination snapshots make this retryable.
    fs.rmSync(lockPath, { force: true });
    return { fd: open(), recoveredStaleLock: true };
  }
}

async function runRequestedLegacyMigration(options = {}) {
  const Database = options.Database;
  const rawSourceRoot = String(options.sourceRoot || "").trim();
  const rawTargetRoot = String(options.targetRoot || "").trim();
  if (!rawSourceRoot || !rawTargetRoot) {
    throw new Error("Distinct absolute sourceRoot and targetRoot are required");
  }
  const sourceRoot = path.resolve(rawSourceRoot);
  const targetRoot = path.resolve(rawTargetRoot);
  if (sourceRoot === targetRoot) {
    throw new Error("Distinct absolute sourceRoot and targetRoot are required");
  }
  const migrationRoot = ensureInside(targetRoot, path.join(targetRoot, "migration"));
  const requestPath = ensureInside(
    targetRoot,
    options.requestPath || path.join(migrationRoot, REQUEST_FILE_NAME),
  );
  if (!fs.existsSync(requestPath)) {
    return { attempted: false, status: "not-requested", requestPath };
  }
  if (typeof Database !== "function") {
    return { attempted: true, status: "failed", requestPath, errors: ["SQLite runtime unavailable"] };
  }

  const runId = nowRunId(options.now ? options.now() : Date.now());
  const manifestRoot = ensureInside(targetRoot, path.join(migrationRoot, "manifests"));
  const conflictRoot = ensureInside(targetRoot, path.join(migrationRoot, "conflicts", runId));
  const snapshotRoot = ensureInside(targetRoot, path.join(migrationRoot, "source-snapshots", runId));
  const backupRoot = ensureInside(targetRoot, path.join(targetRoot, "db", "backups", "legacy-migration"));
  const lockPath = ensureInside(targetRoot, path.join(migrationRoot, ".legacy-import.lock"));
  fs.mkdirSync(migrationRoot, { recursive: true });

  const lock = acquireMigrationLock(lockPath);
  if (lock.fd === null) {
    return {
      attempted: true,
      status: "busy",
      requestPath,
      lockPath,
      busyOwnerPid: lock.busyOwnerPid,
    };
  }
  const lockFd = lock.fd;

  const startedAt = Date.now();
  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    migrationVersion: MIGRATION_VERSION,
    runId,
    sourceRoot,
    targetRoot,
    startedAt,
    startedAtUtc: new Date(startedAt).toISOString(),
    status: "in-progress",
    inventoryCount: 0,
    databases: [],
    files: [],
    errors: [],
    recoveredStaleLock: lock.recoveredStaleLock,
  };
  const manifestPath = ensureInside(manifestRoot, path.join(manifestRoot, `legacy-import-${runId}.json`));

  try {
    const inventory = legacyInventory(sourceRoot);
    manifest.inventoryCount = inventory.length;
    if (!inventory.length) {
      manifest.status = "nothing-to-import";
    } else {
      fs.mkdirSync(snapshotRoot, { recursive: true });
      fs.mkdirSync(backupRoot, { recursive: true });
      const context = { targetRoot, conflictRoot, backupRoot, runId };

      const sourceMain = firstExisting([
        path.join(sourceRoot, "db", "adsi.db"),
        path.join(sourceRoot, "adsi.db"),
      ]);
      if (sourceMain) {
        try {
          manifest.databases.push(await mergeDatabase({
            Database,
            sourcePath: sourceMain,
            destinationPath: path.join(targetRoot, "db", "adsi.db"),
            snapshotPath: path.join(snapshotRoot, "adsi.db"),
            backupPath: path.join(backupRoot, `adsi-before-${runId}.db`),
          }));
        } catch (error) {
          manifest.errors.push({ artifact: "adsi.db", error: String(error.message || error) });
        }
      }

      const seenArchiveSources = new Set();
      for (const archiveRoot of [path.join(sourceRoot, "db", "archive"), path.join(sourceRoot, "archive")]) {
        if (!fs.existsSync(archiveRoot)) continue;
        for (const sourceArchive of walkFiles(archiveRoot).filter((file) => /\.db$/i.test(file))) {
          const sourceKey = path.resolve(sourceArchive).toLowerCase();
          if (seenArchiveSources.has(sourceKey)) continue;
          seenArchiveSources.add(sourceKey);
          const name = path.basename(sourceArchive);
          try {
            manifest.databases.push(await mergeDatabase({
              Database,
              sourcePath: sourceArchive,
              destinationPath: path.join(targetRoot, "db", "archive", name),
              snapshotPath: path.join(snapshotRoot, `archive-${seenArchiveSources.size}-${name}`),
              backupPath: path.join(backupRoot, `${name}.before-${runId}-${seenArchiveSources.size}.db`),
            }));
          } catch (error) {
            manifest.errors.push({ artifact: `archive/${name}`, error: String(error.message || error) });
          }
        }
      }

      const sourceTopology = firstExisting([
        path.join(sourceRoot, "db", "ipconfig.json"),
        path.join(sourceRoot, "config", "ipconfig.json"),
        path.join(sourceRoot, "ipconfig.json"),
      ]);
      if (sourceTopology) {
        const topologyResult = migrateTopology(
          sourceTopology,
          path.join(targetRoot, "db", "ipconfig.json"),
          context,
        );
        manifest.files.push(topologyResult);
        if (topologyResult.action === "invalid-source") manifest.errors.push(topologyResult);
      }

      const directFiles = [
        [path.join(sourceRoot, "autoreset.json"), path.join(targetRoot, "autoreset.json")],
        [path.join(sourceRoot, "server-service-config.json"), path.join(targetRoot, "server-service-config.json")],
        [path.join(sourceRoot, "backup_history.json"), path.join(targetRoot, "backup_history.json")],
        [path.join(sourceRoot, "db", "backupHealth.json"), path.join(targetRoot, "db", "backupHealth.json")],
        [path.join(sourceRoot, "cloud_tokens.enc"), path.join(targetRoot, "auth", "cloud_tokens.enc")],
      ];
      for (const [source, destination] of directFiles) {
        if (fs.existsSync(source)) manifest.files.push(migrateOrdinaryFile(source, destination, context));
      }

      const sourceKeyring = firstExisting([
        path.join(sourceRoot, "auth", ".token-keyring"),
        path.join(sourceRoot, "db", ".token-keyring"),
      ]);
      if (sourceKeyring) {
        manifest.files.push(migrateOrdinaryFile(
          sourceKeyring,
          path.join(targetRoot, "db", ".token-keyring"),
          context,
        ));
      }

      for (const [sourceDir, destinationDir] of [
        [path.join(sourceRoot, "forecast"), path.join(targetRoot, "forecast")],
        [path.join(sourceRoot, "weather"), path.join(targetRoot, "weather")],
        [path.join(sourceRoot, "license"), path.join(targetRoot, "license")],
        [path.join(sourceRoot, "auth"), path.join(targetRoot, "auth")],
      ]) {
        for (const source of walkFiles(sourceDir)) {
          if (path.basename(source).toLowerCase() === ".token-keyring") continue;
          const relative = path.relative(sourceDir, source);
          manifest.files.push(migrateOrdinaryFile(source, path.join(destinationDir, relative), context));
        }
      }

      for (const database of manifest.databases) {
        if (database.errors?.length) manifest.errors.push(...database.errors.map((error) => ({
          artifact: path.basename(database.destination || database.source || "database"),
          ...error,
        })));
      }
      const conflictCount = manifest.files.filter((item) => /conflict/.test(item.action)).length
        + manifest.databases.reduce((sum, item) => sum + Number(item.unresolvedConflicts || 0), 0);
      manifest.conflictCount = conflictCount;
      manifest.status = manifest.errors.length
        ? "failed"
        : conflictCount > 0
          ? "complete-with-conflicts"
          : "complete";
    }
  } catch (error) {
    manifest.errors.push({ error: String(error.stack || error.message || error) });
    manifest.status = "failed";
  } finally {
    manifest.completedAt = Date.now();
    manifest.completedAtUtc = new Date(manifest.completedAt).toISOString();
    try { atomicWriteJson(manifestPath, manifest); } catch (error) {
      manifest.status = "failed";
      manifest.errors.push({ manifest: manifestPath, error: String(error.message || error) });
    }
    try { fs.closeSync(lockFd); } catch (_) {}
    try { fs.rmSync(lockPath, { force: true }); } catch (_) {}
  }

  if (["complete", "complete-with-conflicts", "nothing-to-import"].includes(manifest.status)) {
    try { fs.rmSync(requestPath, { force: true }); } catch (error) {
      manifest.status = "failed";
      manifest.errors.push({ request: requestPath, error: `could not clear completed request: ${error.message}` });
      try { atomicWriteJson(manifestPath, manifest); } catch (_) {}
    }
  }
  return { attempted: true, manifestPath, ...manifest };
}

module.exports = {
  MANIFEST_SCHEMA_VERSION,
  MIGRATION_VERSION,
  REQUEST_FILE_NAME,
  SAFE_INTEGER_PK_REMAP_TABLES,
  atomicCopyFile,
  migrateOrdinaryFile,
  migrateTopology,
  mergeDatabase,
  rowFingerprint,
  runRequestedLegacyMigration,
  sha256File,
  validateTopology,
};
