---
name: adsi-testing-ops
description: Automated test suites, smoke test execution guidelines, zero DB lock guarantees, and verification checklists for Inverter Dashboard.
---

# ADSI Dashboard — Testing & Operations Protocol

This skill documents the automated testing strategies, continuous verification suites, database locking rules, and deployment operations for the **Inverter Dashboard** platform.

---

## 1. Test Suite Architecture

- **Node Smoke Suite:**
  - 106 test suites covering database schema, APC controllers, forecasting pipelines, license validation, HikVision CCTV, shutdown serialization, and energy reconciliation.
  - Executed via: `node scripts/smoke-all.js --skip-python --no-rebuild`
  - Invariant: **106 / 106 suites must pass with zero failures (100% pass rate).**
- **Python Pytest Suite:**
  - 619 tests covering Modbus telemetry acquisition, inverter engine models, physical clear-sky calculations, Solcast integration, and firmware transports.
  - Executed via: `python -m pytest services/ -q`

---

## 2. Zero DB Lock & Isolated Execution Invariants

- **Isolated Test DBs:** Every test must instantiate its database in an isolated temporary directory (e.g. `path.join(os.tmpdir(), "adsi-test-...")`) or in-memory, ensuring no contention with running live services.
- **WAL Flush on Teardown:** Tests must explicitly close database connections and trigger `PRAGMA wal_checkpoint(TRUNCATE)` before process exit.
- **Graceful Process Shutdown Tests:** Verify that unexpected process terminations cleanly reconstruct the `shutdown_reasons` log on subsequent startup.

---

## 3. UI & Responsive Verification Checklist

Whenever altering frontend markup or styles:
1. **Desktop Verification (1440px / 1080p):** Desktop view (`> 768px`) must remain 100% intact with zero broken grid cells or layout shifts.
2. **Intermediate / Tablet View (769px–1200px):** Metric side-cards stack vertically, granting charts full-width resolution; titles flex without wrapping.
3. **Mobile View (360px–390px):**
   - Sub-navigation tab bars render without horizontal scrollbars.
   - All checkboxes maintain `.chk-inline` row flex (`display: flex !important; flex-direction: row !important; align-items: center !important; gap: 10px !important; width: 100% !important;`).
   - Sizing invariants enforced: `min-width: 0 !important; max-width: 100% !important; width: 100% !important;`.
4. **Cache-Busting Protocol:** Always bump `style.css?v=XX` and `app.js?v=XX` query parameters in both `public/index.html` and `frontend/public/index.html`.
5. **Asset Pairing:** Ensure edits in `public/` and `frontend/public/` remain 100% identical.

---

## 4. Linux 18-Step Zero-Collision Maintenance Rule

When deploying updates to Linux production workstations:
1. **ALWAYS** explicitly stop all ADSI services before modifying code or databases:
   ```bash
   sudo systemctl stop adsi.target adsi-server adsi-inverter adsi-forecast adsi-go2rtc
   ```
2. Apply code updates (`git pull`), script executions (`setup.sh`), or database migrations.
3. Verify permissions: `sudo chown -R adsi:adsi /var/lib/inverter-dashboard /opt/inverter-dashboard`.
4. Restart services only when completely finalized:
   ```bash
   sudo systemctl start adsi.target
   ```
