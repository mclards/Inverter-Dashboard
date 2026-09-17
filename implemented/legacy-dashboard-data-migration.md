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

## In-Installer Execution & Startup Freeze Fix (2026-09-04)

### Problem Corrected
Previously, when the operator accepted legacy migration, NSIS wrote `legacy-import-request-v1.txt` and immediately advanced to the "Finish" page. On initial app launch, `runInstallerRequestedLegacyMigration()` executed synchronously on Node's main thread before opening any window. For large multi-gigabyte archives (e.g. `2026-03.db`, 1.38 GB, 17.9M rows) and `adsi.db` (325 MB), redundant `PRAGMA quick_check(1)` runs, full file backups, and SHA-256 hashing locked the event loop for ~3 minutes with 0 windows visible. Believing the app failed to launch, operators clicked the desktop shortcut again, spawning multiple processes in Task Manager.

### Refined Architecture
1. **In-Installer Execution (`--migrate-now`):**
   - NSIS invokes `"$INSTDIR\Inverter Dashboard.exe" --migrate-now` using `ExecWait`.
   - The installer progress page stays open while migration runs and only advances to "Finish" once migration is complete.
   - Electron acquires the single-instance lock early so any concurrent desktop launches cannot interfere.
2. **Dedicated Migration Progress Window (`migrationWin`):**
   - Opens a 480×250 dark-themed (`#050c17`, `#0c1526`, `#2d7ef7`) window loading `public/migration.html` (mirrored in `frontend/public/migration.html`).
   - Displays animated CSS progress bar and descriptive status.
   - Waits for renderer `ready-to-show` and event-loop tick to prevent paint starvation during synchronous SQLite queries.
   - Completion dialog is attached modally to `migrationWin` with a `"Continue"` action that unblocks NSIS.
3. **Database Migration Performance Optimization:**
   - **Identical Database Fast-Path:** When destination exists, checks if `source.size === destination.size` and neither has an uncheckpointed `-wal` file. If sizes and SHA-256 match, returns `action: "identical"` immediately without writing snapshots/backups or running 5 redundant `quick_check` passes (slashes 1.38 GB archive processing from ~189s to ~3s).
   - **Fresh Copy Optimization:** When destination does not exist, snapshots directly to `destinationPath` without creating and copying an intermediate temporary snapshot.
   - **Table Fast-Paths:** If `sourceCount === 0`, returns immediately. If `destinationBefore === 0`, inserts all rows directly without `differs` join. If `sourceCount === inserted`, skips `differs` join because all PKs were unique.
4. **Fallback UI for Standard Launch:**
   - If an unexpected request file remains during normal boot, `main.js` opens `migrationWin` with visible UI before migrating, preventing silent freezes.

## Files changed

- `scripts/installer.nsh` — executes `Inverter Dashboard.exe --migrate-now` in `queueLegacyMigration` and refines prompt wording.
- `electron/main.js` — handles `MIGRATION_STANDALONE`, acquires single-instance lock, manages `migrationWin`, and provides fallback progress UI on standard launch.
- `electron/legacyDataMigration.js` — adds `hasActiveWal`, fast-path identical database detection, optimized fresh copy, and table merge fast paths.
- `public/migration.html` & `frontend/public/migration.html` — dedicated dark-themed progress UI with compositor-driven CSS animation.
- `server/tests/legacyDataMigration.test.js` — verifies `testIdenticalDatabaseFastPath`, installer execution wiring, and startup contracts.
- `implemented/legacy-dashboard-data-migration.md` — consolidated architecture and verification record.

## Verification

Focused automated coverage verifies:

- a same-named main database imports distinct historical rows instead of being skipped;
- integer-key collisions in append-only history retain both distinct rows;
- current settings/state win conflicting legacy keys while missing settings are imported;
- same-named archive shards are merged by row content;
- identical databases take the fast-path without writing unnecessary backups;
- current topology records are preserved, missing records are added across all four maps, and an explicitly empty node list stays disabled;
- identical ordinary files are recognized by content;
- differing same-named files preserve both current and legacy copies;
- a corrupt source database does not change the destination and leaves the request retryable;
- a table/schema failure rolls back all earlier changes for that database;
- existing destination databases have rollback snapshots;
- NSIS executes `--migrate-now` during installation;
- `main.js` implements `MIGRATION_STANDALONE` and `runMigrationStandalone()`; and
- packaged startup invokes migration before login can start local services.
