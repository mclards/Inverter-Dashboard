# Implementation Plan: In-Installer Legacy Data Migration & Startup Freeze Fix

Fix the issue where Inverter Dashboard does not appear after installer finishes, the installer completes prematurely before migration finishes, and multiple frozen dashboard processes accumulate in Task Manager.

---

## Root Cause Analysis

1. **Installer finished prematurely:** `scripts/installer.nsh` only wrote `legacy-import-request-v1.txt` and immediately advanced to the "Finish" page. The user clicked "Finish", believing migration was complete.
2. **Silent 3-minute freeze on launch:** When `Inverter Dashboard.exe` was launched, it executed `runInstallerRequestedLegacyMigration()` synchronously **before creating any window**. On the user's system, legacy data included `archive/2026-03.db` (1.38 GB, 17.9M rows) and `db/adsi.db` (325 MB, 3.6M rows). Redundant SQLite backups, B-tree `PRAGMA quick_check` calls (22.5s each), and SHA-256 hashing locked the Node event loop for **189 seconds (over 3 minutes)** with **zero windows visible**.
3. **Multiple processes spawned:** Believing the app failed to launch, the user clicked the desktop shortcut again. Without a single-instance lock in `electron/main.js`, multiple instances spawned in Task Manager.
4. **Modal dialog blocked login:** After 3 minutes, a modal dialog (`Legacy Data Migration Completed With Conflicts`) popped up, blocking `showLoginWindow()` until acknowledged.

---

## Proposed Changes

### Component 1: In-Installer Migration Execution (`--migrate-now`)

#### [MODIFY] [scripts/installer.nsh](file:///d:/Inverter-Dashboard/scripts/installer.nsh)
- In macro `customInstall` under `queueLegacyMigration`:
  - After writing `legacy-import-request-v1.txt`, invoke the newly installed executable with `--migrate-now`:
    ```nsis
    DetailPrint "Migrating legacy data from $0\InverterDashboard..."
    DetailPrint "Validating databases and importing historical records..."
    ExecWait '"$INSTDIR\Inverter Dashboard.exe" --migrate-now' $2
    DetailPrint "Legacy data migration finished (code $2)."
    ```
  - The installer progress page remains open and active while migration executes. The installer will **not** advance to the "Finish" page until the migration window and dialog have completed.

---

### Component 2: Electron Standalone Migration Mode & Startup UI

#### [MODIFY] [electron/main.js](file:///d:/Inverter-Dashboard/electron/main.js)
1. **Single-Instance Enforcement:**
   - Call `app.requestSingleInstanceLock()` early in `main.js` (for non-`--migrate-now` launches).
   - If secondary instance is launched, focus the existing window (`loginWin` or `mainWin`) and exit the secondary process immediately (`app.exit(0)`).
2. **`--migrate-now` CLI Handler:**
   - Detect `const MIGRATION_STANDALONE = process.argv.includes("--migrate-now");`.
   - When present, in `app.whenReady()`:
     - Open a dedicated, sleek migration progress window:
       - Dimensions: 480x240, centered, dark theme matching dashboard design system (`#0b1329`, `#1e293b`).
       - Message: *"Migrating Legacy Data... Validating databases and importing configuration..."*
       - Progress spinner / pulsing indicator.
     - Call `await runInstallerRequestedLegacyMigration(migrationWin)`.
     - Completion dialog (`Legacy Data Migration Complete` / `Legacy Data Migration Completed With Conflicts`) is attached to `migrationWin`.
     - Upon user dismissal, close `migrationWin` and exit the process with `app.exit(0)`.
3. **Fallback UI for Standard App Launch:**
   - If started normally (without `--migrate-now`) but a pending `legacy-import-request-v1.txt` is found:
     - Display the migration progress window **before** starting `runInstallerRequestedLegacyMigration()`.
     - After migration is acknowledged, destroy the migration window and proceed to `showLoginWindow()`.
     - The user **never** encounters an invisible frozen process.
   - When no migration request exists (the standard case once the installer finishes), `showLoginWindow()` launches immediately in <1 second.

---

### Component 3: Database Migration Performance Optimization

#### [MODIFY] [electron/legacyDataMigration.js](file:///d:/Inverter-Dashboard/electron/legacyDataMigration.js)
1. **Fast-Path Identical Database Check (`mergeDatabase`):**
   - When `destinationPath` already exists:
     - Compare file sizes first: `fs.statSync(sourcePath).size === fs.statSync(destinationPath).size`.
     - If sizes match, compute SHA-256 hashes of `sourcePath` and `destinationPath` in place.
     - If hashes match:
       - Set `result.action = "identical"`.
       - Return immediately without creating multi-gigabyte snapshot files, without writing destination backups, and without running redundant `PRAGMA quick_check` runs.
       - **Result:** Drops archive processing time from **200 seconds to <5 seconds** (saving ~2.76 GB of useless disk writes on 1.38 GB files).
2. **Table Merge Fast-Paths (`mergeTable`):**
   - If `sourceCount === 0`: return immediately (`action: "skipped", reason: "source-table-empty"`).
   - If `destinationBefore === 0`: insert all rows directly (`conflicts: 0`) without executing the expensive `differs` Cartesian join.

---

## Verification Plan

### Automated Tests
1. **Existing Test Suites:**
   - Run complete Node smoke test matrix: `node scripts/smoke-all.js --skip-python --no-rebuild` (ensure 119/119 suites pass).
2. **Migration Unit Tests:**
   - Run `node test/legacyDataMigration.test.js` to ensure zero regressions in conflict detection, PK remapping, audit manifests, and rollback behavior.

### Verification of Fixes
1. **CLI Flag Verification:**
   - Test `electron . --migrate-now` behavior and confirm the progress window renders, migration completes, dialog appears, and process exits cleanly with code 0.
2. **Timing Verification:**
   - Measure `mergeDatabase` execution time on `archive/2026-03.db` (1.38 GB) to confirm fast-path identical completion in <5 seconds.
3. **Single Instance Verification:**
   - Launching a second instance focuses the first instance without spawning duplicate background processes in Task Manager.
4. **Installer Packaging & Verification:**
   - Build installer: `npm run dist`.
   - Verify the installer prompts for legacy migration, holds the progress bar during migration execution, displays the completion dialog, and upon clicking "Finish", launches the dashboard immediately into the Login window.

