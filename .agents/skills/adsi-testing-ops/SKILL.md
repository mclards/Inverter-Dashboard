---
name: adsi-testing-ops
description: Token-efficient testing, native ABI handling, Windows signed installer release pipeline, and Linux production server operations.
---

# ADSI Dashboard — Testing, Release & Linux Ops Protocol (Token-Optimized)

## 1. Token-Efficient Verification & Native ABI Rules
- **Fast Syntax & Compile Checks (Run First):**
  - JS: `node --check server/index.js; node --check backend/services/index.js`
  - Python: `python -m py_compile services/inverter_engine.py backend/engines/inverter/inverter_engine.py`
  - Topology JSON: Validate `C:\ProgramData\Inverter-Dashboard\db\ipconfig.json` has all 4 maps (`inverters`, `poll_interval`, `units`, `losses`) and 27 inverters.
- **Better-SQLite3 Electron ABI Rule:**
  - The workspace keeps `better-sqlite3` compiled for **Electron ABI** (`npm run rebuild:native:electron`).
  - `node scripts/smoke-all.js --skip-python --no-rebuild` automatically spawns `node_modules\electron\dist\electron.exe` with `ELECTRON_RUN_AS_NODE=1` to run all 120 Node test suites in `server/tests/`.
  - To run a single DB-backed test file directly without full smoke:
    `$env:ELECTRON_RUN_AS_NODE="1"; & "d:\Inverter-Dashboard\node_modules\electron\dist\electron.exe" server/tests/<test>.js; Remove-Item Env:\ELECTRON_RUN_AS_NODE`
  - **Never** run `npm rebuild better-sqlite3` on Windows unless Visual Studio C++ build tools are active, as `node-gyp` will wipe `build/Release/better_sqlite3.node`; restore immediately with `npm run rebuild:native:electron`.

## 2. Signed Windows Installer Release Pipeline
When publishing a new Windows desktop release (`vX.Y.Z`):
1. **Rebuild Bundled Python EXEs (CRITICAL if Python services changed):**
   - If `services/inverter_engine.py` changed, rebuild `dist/InverterCoreService.exe` **before** running `electron-builder`:
     `python -m PyInstaller --noconfirm services/InverterCoreService.spec`
   - (`scripts/build-installer-signed.js` automatically rebuilds `ForecastCoreService.spec`, but **not** `InverterCoreService.spec`).
2. **Bump Version & Commit:**
   - Update `"version": "X.Y.Z"` in `package.json` and `package-lock.json` (root + `packages[""]`), commit, and push to `origin/main`.
3. **Build & Verify Signed Installer:**
   - Run `node scripts/build-installer-signed.js` (requires clean working tree).
   - Commit the updated `services/forecast-build-info.json`, tag `vX.Y.Z`, and push `origin main vX.Y.Z`.
4. **Publish GitHub Release:**
   - `gh release create vX.Y.Z "release/Inverter-Dashboard-Setup-X.Y.Z.exe" "release/Inverter-Dashboard-Setup-X.Y.Z.exe.blockmap" "release/latest.yml" --title "Inverter Dashboard vX.Y.Z" --notes "..." --latest`

## 3. Linux Production Server (`adsi-server` / `root@100.123.123.123`) Ops
- **Authoritative Paths & Systemd Units:**
  - Code root: `/opt/inverter-dashboard` (owner `inverter:inverter`, virtualenv `/opt/inverter-dashboard/venv/bin/python`).
  - Data root: `/var/lib/inverter-dashboard/db` (`adsi.db`, `ipconfig.json`).
  - Systemd units: `inverter-server`, `inverter-engine`, `inverter-forecast`, `inverter-go2rtc` (never `forecast-worker` or `go2rtc`).
- **Token-Saving Single-Roundtrip SSH Pattern:**
  - Avoid PowerShell/bash quote-escaping failures by piping a Python script over stdin in one SSH call:
    ```powershell
    @"
    import subprocess, time, sqlite3
    subprocess.run(['git', 'fetch', 'origin', 'main', '--tags', '--force'], cwd='/opt/inverter-dashboard', check=True)
    subprocess.run(['git', 'reset', '--hard', 'origin/main'], cwd='/opt/inverter-dashboard', check=True)
    subprocess.run(['chown', '-R', 'inverter:inverter', '/opt/inverter-dashboard'], check=True)
    subprocess.run(['systemctl', 'restart', 'inverter-engine', 'inverter-server', 'inverter-forecast'], check=True)
    time.sleep(6)
    for s in ['inverter-server', 'inverter-engine', 'inverter-forecast', 'inverter-go2rtc']:
        print(s, subprocess.check_output(['systemctl', 'is-active', s], text=True).strip())
    "@ | ssh -o StrictHostKeyChecking=no root@100.123.123.123 "python3 -"
    ```
- **Forecast QA CLI on Linux:**
  - Run with `ADSI_DATA_DIR=/var/lib/inverter-dashboard/db /opt/inverter-dashboard/venv/bin/python /opt/inverter-dashboard/services/forecast_engine.py --qa-date YYYY-MM-DD` (do not pass `--db-path`).
