# Linux Telemetry Engine Driver & Appliance Installer Fixes

**Timestamp:** 2026-08-27T18:36:00+08:00  
**Target Environment:** Linux Production Appliance (Debian / Ubuntu) & Cross-Platform Engine  
**Commits:** [`7349505`](https://github.com/mclards/Inverter-Dashboard/commit/7349505db3ba16169f74748162916aaca7efb309), [`b3ec97a`](https://github.com/mclards/Inverter-Dashboard/commit/b3ec97abacf16857d627afd7268360f03df6b6fc), [`fb11e2d`](https://github.com/mclards/Inverter-Dashboard/commit/fb11e2d), [`8576e1a`](https://github.com/mclards/Inverter-Dashboard/commit/8576e1a)

---

## 1. Problem Statement & Symptoms

### Symptoms
- Systemd automatically started `inverter-engine.service` and loopback HTTP probes (`:9100/health`) responded, but the Telemetry Engine remained in a **`DEGRADED (0/27 connected; no fresh telemetry)`** state.
- Inverter 19 being offline should have resulted in **`26/27 connected`**, not `0/27`.
- Standalone TCP/Modbus probes to port 502 succeeded when tested individually, confirming that Ethernet routing was intact and the fault was purely in the driver polling layer.
- Running the installer/updater encountered:
  1. `Git: fatal: detected dubious ownership in repository at '/opt/inverter-dashboard'`
  2. `inverter-ipconfig-seed.js: Error: Existing topology is unreadable; left untouched: EACCES: permission denied, open '/var/lib/inverter-dashboard/db/ipconfig.json'`
  3. `fatal: unable to access '/etc/gitconfig': Permission denied` when running Git under the `inverter` service user.

---

## 2. Root Cause Analysis

### A. Driver Resolution & Parameter Mismatch
1. When `InverterCoreService.py` launched, Python's `sys.path` prioritized the repository root (`/opt/inverter-dashboard/`) over nested directories.
2. It imported `/opt/inverter-dashboard/drivers/modbus_tcp.py` instead of the newer `backend/engines/inverter/drivers/modbus_tcp.py`.
3. The root driver's legacy `_call_modbus` helper only extracted `kwargs.pop("unit", None)`. When called with `slave=unit` (which is standard for PyModbus 3.x), `kwargs.pop("unit")` returned `None`, stripping the unit address and causing Modbus TCP frames to be sent without a slave ID.
4. Consequently, Ingeteam inverters returned errors/empty registers on every poll cycle.

### B. Linux Permission & Ownership Cascades
1. **Safe Directory Warning:** `/opt/inverter-dashboard` is owned by `inverter:inverter`, but admin tasks run via `sudo` (`root`). Git 2.35+ flags this unless explicitly listed under `safe.directory`.
2. **Topology Seeder EACCES:** If `ipconfig.json` was previously created or touched by `root` with `0600` permissions, running `runuser -u inverter -- ... inverter-ipconfig-seed.js` failed with `EACCES`.
3. **System Git Config Permission:** When `git config --system` was executed by root, `/etc/gitconfig` was created with root-only read permissions, preventing the unprivileged `inverter` user from running `git` during subsequent `update.sh` calls.

---

## 3. Implemented Fixes

### A. Unified Adaptive Modbus Driver Layer
Synchronized all 4 driver files across the repository:
- `drivers/modbus_tcp.py`
- `services/drivers/modbus_tcp.py`
- `backend/drivers/modbus_tcp.py`
- `backend/engines/inverter/drivers/modbus_tcp.py`

Implemented multi-keyword fallback in `_call_modbus`:
```python
def _call_modbus(fn, *args, **kwargs):
    slave = kwargs.pop("slave", kwargs.pop("unit", kwargs.pop("device_id", None)))
    if slave is not None:
        try:
            return fn(*args, slave=slave, **kwargs)
        except TypeError:
            try:
                return fn(*args, device_id=slave, **kwargs)
            except TypeError:
                try:
                    return fn(*args, unit=slave, **kwargs)
                except TypeError:
                    return fn(*args, **kwargs)
    return fn(*args, **kwargs)
```
Configured non-blocking socket parameters (`retries=0`, `reconnect_delay=0.0`) and added socket timeout refresh before every read.

### B. Inverter Telemetry Engine & I/O Modules
- **`backend/engines/inverter/inverter_engine.py`**:
  - Added startup validation guard: `if create_client is None: raise RuntimeError(...)`.
  - Replaced all legacy `unit=` parameters in clock synchronization, grid control, full configuration, and scan functions with `slave=`.
- **`backend/engines/inverter/calibration_core.py`** & **`calibration_io.py`**:
  - Wrapped client calls with adaptive `_call_client` supporting `slave=` kwargs.
- **`backend/engines/inverter/serial_io.py`**:
  - Synchronized FC11/FC16 serial number read/write pipeline with `_call_client`.
- **`backend/engines/inverter/firmware_buslock.py`**:
  - Standardized marker path to canonical hyphenated `Inverter-Dashboard`.

### C. Installer & Updater Automation Hardening
- **`deploy/linux/setup.sh`**:
  - Configures system-wide `git config --system --add safe.directory` for both application root and repo root.
  - Guarantees `/etc/gitconfig` is world-readable (`chmod 644 /etc/gitconfig`).
  - Automatically runs `chown -R inverter:inverter /var/lib/inverter-dashboard` and sets `750` on directories and `640` on `ipconfig.json` before seeding.
- **`deploy/linux/install.sh`**:
  - Configures `safe.directory` and `chmod 644 /etc/gitconfig` during early bootstrap.

---

## 4. Verification Evidence

### Automated Local Test Suites
- **Node Smoke Suite:** 115 / 115 tests passed (`node scripts/smoke-all.js --skip-python --no-rebuild`).
- **Python Pytest Suite:** 617 passed, 2 skipped (`python -m pytest services/ -q`).
- **Contract Tests:** `linuxDeploymentContract.test.js` passed, `pymodbus3Compatibility.test.js` passed.

### Live Appliance Telemetry Verification (`100.123.123.123`)
- **Telemetry Health (`:9100/health`):**
  ```json
  {
    "status": "ok",
    "stale": false,
    "newest_frame_age_ms": 10,
    "connected_inverter_count": 26,
    "configured_inverter_count": 27,
    "now_ms": 1787826472366
  }
  ```
- **Gateway Server Status (`:3500/api/server/status`):**
  ```json
  {
    "ok": true,
    "running": true,
    "state": "running",
    "port": 3500,
    "operationMode": "gateway",
    "telemetry": {
      "reachable": true,
      "healthy": true,
      "stale": false,
      "connectedInverters": 26,
      "configuredInverters": 27,
      "newestFrameAgeMs": 47
    }
  }
  ```

---

## 5. Summary of Key Invariants Preserved
1. **Inverter Topology:** All 27 inverter records and sparse node assignments (`[2, 4]` on Inv 8, `[3, 4]` on Inv 23/27) remain preserved in `/var/lib/inverter-dashboard/db/ipconfig.json`.
2. **Service State Truthfulness:** Live polling health accurately reports `26/27 connected` when INV-19 is physically down.
3. **One-Command Setup:** Both fresh installs (`install.sh`) and updates (`update.sh`) execute end-to-end idempotently with zero manual permission fixes required.
