# Legacy Dashboard Data Migration

## Status

Implemented for the Windows NSIS installer and packaged Electron startup.

## Problem corrected

The former `scripts/installer.nsh` migration treated a destination filename as proof that its data had already been migrated. It therefore skipped a legacy `adsi.db`, monthly archive shard, `ipconfig.json`, forecast artifact, weather cache, license file, or authentication file whenever the new root contained a file with the same name. It did not compare file content, merge SQLite rows, validate topology, take consistent WAL snapshots, verify copy results, or provide rollback/audit evidence.

Direct `CopyFiles` operations in NSIS are not suitable for merging live SQLite databases. Copying an `adsi.db` and its `-wal`/`-shm` files independently can also produce a database snapshot from different points in time.

## Implemented architecture

The installer and application now have separate responsibilities:

1. Interactive NSIS installation detects supported legacy artifacts under `%PROGRAMDATA%\InverterDashboard` and asks the operator whether to import them.
2. If accepted, NSIS writes `%PROGRAMDATA%\Inverter-Dashboard\migration\legacy-import-request-v1.txt`. It does not copy or merge legacy data.
3. On the next packaged Windows launch, Electron processes the request before showing the login window or starting local services. Portable and explicitly overridden data directories are excluded.
4. `electron/legacyDataMigration.js` snapshots, validates, compares, merges, backs up, and audits the content.
5. The request is removed only after a complete, complete-with-conflicts, or nothing-to-import result. A failure leaves it in place for a safe retry.

Silent installation deliberately does not create a new import request because importing data from another product root requires an explicit operator decision. An already-created request remains available across a silent update.

## Content-aware merge rules

### SQLite databases

- The main database is discovered at legacy `db\adsi.db`, with root `adsi.db` as a fallback.
- Archive databases are discovered recursively in both legacy `db\archive` and `archive`.
- Every source database is first checked with SQLite `quick_check` and captured with the `better-sqlite3` online-backup API. This includes committed WAL content without copying `-wal` or `-shm` files directly.
- A missing destination receives the validated snapshot.
- An existing destination is also checked and backed up before any merge.
- Identical source and destination snapshots are detected by SHA-256 and skipped as identical.
- Missing tables and missing primary-key rows are imported.
- Existing primary-key rows remain authoritative. Same-key rows with different content are reported as conflicts rather than silently treated as migrated.
- For allow-listed append-only event/history tables with an integer surrogate key, a same-key/different-content source row is retained under a new generated key when its non-key content is not already present.
- Tables without a primary key use deterministic full-row fingerprints for content deduplication.
- Source-only schema columns and non-remappable key conflicts are recorded. The validated source snapshot remains available for inspection.
- All table changes for one destination database run in one transaction. Any table error or foreign-key violation rolls the whole database merge back.
- The result is checked again with SQLite `quick_check`.

Current configuration/state rows win key conflicts. This prevents a legacy database from silently changing current gateway, remote-client, authentication, service, or plant settings.

### Inverter topology

Legacy `ipconfig.json` candidates are checked in `db`, `config`, then the legacy root. The importer requires:

- the four scalar maps `inverters`, `poll_interval`, `units`, and `losses`;
- matching inverter keys across all four maps;
- inverter numbers in the supported `1` through `27` range;
- valid IPv4 strings;
- positive polling intervals and non-negative loss values; and
- unique integer node assignments in the supported `N1` through `N4` range.

For an existing valid destination, the four values for every existing inverter are preserved together. Only completely missing inverter records are added from the source. Explicitly empty `units` arrays remain empty and are never converted into four enabled nodes. Differing legacy records are retained in the run's conflict area.

### Other files

- Files are compared by SHA-256, not by name.
- A missing destination is copied through a same-directory temporary file and verified by size before publication.
- Identical content is recorded as identical.
- If the same destination name has different content, the current file is preserved and the legacy file is copied to `migration\conflicts\<run-id>` with its source hash in the filename.
- Forecast, weather, license, and authentication trees are walked recursively.
- The legacy token keyring is mapped to the canonical `db\.token-keyring`; it is not duplicated under `auth`.
- Source files are never deleted or modified.

## Recovery and audit evidence

Each run creates a JSON manifest under:

`%PROGRAMDATA%\Inverter-Dashboard\migration\manifests\`

The manifest records source/destination paths, SHA-256 hashes, database table results, imported/remapped/conflicting row counts, file decisions, backups, errors, and timestamps. It does not record file contents or decrypted secrets.

Existing database backups are stored under:

`%PROGRAMDATA%\Inverter-Dashboard\db\backups\legacy-migration\`

Source database snapshots and differing non-database files are retained under the run-specific migration directories. A process-owned lock prevents simultaneous imports; a lock left by a dead process is recovered on retry.

## Files changed

- `scripts/installer.nsh` — replaces filename-only copying with explicit, versioned import consent/request while preserving installer ACL, compatibility-layer cleanup, and recovery-installer seeding.
- `electron/main.js` — runs the requested migration before login/local service startup and reports completion, conflicts, or retryable failure.
- `electron/legacyDataMigration.js` — content-aware migration, validation, SQLite snapshot/merge, rollback, conflict retention, locking, and manifest implementation.
- `server/tests/legacyDataMigration.test.js` — isolated migration tests using temporary roots only.
- `package-lock.json` — aligns the root package version with the already-committed `package.json` version (`1.0.9`) so installer inputs remain reproducible.

## Verification

Focused automated coverage verifies:

- a same-named main database imports distinct historical rows instead of being skipped;
- integer-key collisions in append-only history retain both distinct rows;
- current settings/state win conflicting legacy keys while missing settings are imported;
- same-named archive shards are merged by row content;
- current topology records are preserved, missing records are added across all four maps, and an explicitly empty node list stays disabled;
- identical ordinary files are recognized by content;
- differing same-named files preserve both current and legacy copies;
- a corrupt source database does not change the destination and leaves the request retryable;
- a table/schema failure rolls back all earlier changes for that database;
- existing destination databases have rollback snapshots;
- NSIS contains no direct legacy-data `CopyFiles` operation; and
- packaged startup invokes migration before login can start local services.

The tests operate only on temporary directories. No production files under either ProgramData root are read, changed, copied, or deleted by the verification suite.

Verification completed on 2026-09-02:

- `node --check electron/legacyDataMigration.js`
- `node --check electron/main.js`
- `node --check server/tests/legacyDataMigration.test.js`
- focused migration test through Electron 29 / its production `better-sqlite3` ABI: pass
- NSIS 3.04 compile of a minimal installer harness containing both custom macros: pass (one expected harness-only warning because it did not emit an uninstaller)
- `node scripts/smoke-all.js --skip-python --no-rebuild`: **119/119 Node test files passed**
- `git diff --check`: pass
- repository `server/ipconfig.json` and `deploy/linux/default/ipconfig.json`: JSON parsing confirmed; neither file was modified

Python tests were not run because this change has no Python boundary. The signed production installer must be built from the commit containing these changes before the new migration can run on an operator workstation.
