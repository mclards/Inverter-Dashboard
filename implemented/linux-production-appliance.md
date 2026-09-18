# Linux Production Appliance

## Current contract

- `/opt/inverter-dashboard` remains a Git checkout owned by the dedicated
  `inverter` service account so updates can use fast-forward-only Git pulls.
- Persistent application state is isolated under `/var/lib/inverter-dashboard`;
  the gateway, telemetry engine, and forecast worker share the canonical
  `/var/lib/inverter-dashboard/db` data directory.
- The production gateway is `server/index.js`, matching the desktop gateway's
  authentication, authorization, validation, and audit behavior.
- Linux scripts and systemd units are UTF-8 without BOM and LF-only. Git
  attributes and focused tests lock this invariant.
- go2rtc is downloaded from the pinned upstream release for the detected CPU,
  verified against a pinned SHA-256 digest, and installed at
  `/usr/local/bin/go2rtc`. The default config contains no camera credentials.
- Setup is idempotent and never reports the appliance online until all four
  systemd services plus the gateway, telemetry, and go2rtc HTTP probes pass.
- Fresh Debian/Ubuntu hosts have a one-command bootstrap which installs Git,
  validates or clones the canonical repository, and runs the full setup.
- Tailscale is detected or installed from its official Linux installer,
  enabled at boot, enrolled once (interactively or with an operator-supplied
  auth key), and checked as part of appliance health. Tailscale SSH is enabled
  without modifying an already-active Tailscale SSH session.
- NodeSource is configured with its official deb822 repository definition and
  a validated `0644` keyring under `/usr/share/keyrings`. Both the bootstrap
  and full setup remove the exact unreadable legacy repository artifact before
  APT runs, allowing an interrupted older installation to recover on rerun.
- Runtime settings, credentials, topology, databases, camera configuration,
  forecast artifacts, and logs are preserved on reruns and Git updates.
- The Linux installer validates and seeds the canonical 27-inverter topology
  before starting telemetry. It replaces only the exact untouched synthetic
  `.101`-through-`.127`, four-node default (keeping a backup); any customized
  operator topology is validated and preserved.
- The telemetry drivers use the pinned pymodbus 3.6 API (`pymodbus.client` and
  `slave=`). A missing driver is fatal at startup, so systemd cannot report an
  apparently active telemetry process that is incapable of polling.
- Browser lifecycle controls recognize that Linux services are systemd-owned.
  They cannot run password-embedded service commands, and reachable telemetry
  without fresh frames is shown as degraded rather than polling-ready.
- The production backup restore path no longer depends on the vulnerable
  `extract-zip` package. Its contained ZIP reader rejects path traversal,
  absolute paths, symlinks, NUL names, and excessive archive expansion while
  retaining Zip64 support for large plant backups.

## Operator workflow

The durable cross-vendor installation, commit/push, production update,
verification, and failure-evidence workflow is maintained in
`LINUX-INSTALL-UPDATE-GUIDE.md`. AI vendor entry points resolve back to that
guide and `AGENTS.md` so deployment instructions do not diverge.

Fresh install:

```bash
sudo bash -c 'command -v curl >/dev/null || { apt-get update -qq && apt-get install -y -qq ca-certificates curl; }; curl -fsSL https://raw.githubusercontent.com/mclards/Inverter-Dashboard/main/deploy/linux/install.sh | bash'
```

Equivalent manual install:

```bash
sudo git clone --depth 1 --branch main https://github.com/mclards/Inverter-Dashboard.git /opt/inverter-dashboard
cd /opt/inverter-dashboard
sudo ./deploy/linux/setup.sh
```

Update and re-verify:

```bash
sudo /opt/inverter-dashboard/deploy/linux/update.sh
```

Read-only health check:

```bash
sudo /opt/inverter-dashboard/deploy/linux/scripts/inverter-health-check.sh
```

The health check establishes component reachability only. It does not issue
Modbus control commands and does not claim successful field polling when the
host is disconnected from the inverter subnet.

## 2026-08-27 field diagnosis and verification boundary

On the production appliance, all four dashboard services were active, the
wired host route selected `enp4s0`, and several configured devices accepted
TCP/502 connections. A read-only pymodbus 3.6.8 probe returned valid input
register responses from inverter `.101` on nodes N1 through N4. The installed
telemetry driver nevertheless imported the removed pymodbus 2.x module and
silently disabled its client functions. This record captures the durable
driver, installer, topology, and status corrections. Live fleet polling must
be re-verified after the corrected commit is installed on the appliance.

## 2026-09-18 boot auto-start optimization and remote access verification

- **Boot Auto-Start Optimization**:
  - Root cause: `_probeDbIntegritySync` in `server/db.js` and `backend/services/db.js` executed `PRAGMA quick_check(1)` synchronously before `app.listen(3500)`. On a 2.81 GB SQLite database on a mechanical 5400 RPM HDD (`/dev/sda`), this caused a 15–20 minute disk sleep (`D` state) blocking port 3500. Additionally, the periodic backup worker kicked off an unthrottled 2.8 GB file copy at $t = 60\text{s}$.
  - Resolution: Replaced `PRAGMA quick_check(1)` with `PRAGMA schema_version;` (runs in ~2 ms). Deferred initial periodic backup to 15 minutes post-boot when backups already exist. Increased health probe timeout in `deploy/linux/scripts/inverter-health-check.sh` to 8 seconds.
  - Evidence: Server cold boot to listening port 3500 reduced from >15 minutes to <8 seconds. All services (`inverter-server`, `inverter-engine`, `inverter-forecast`, `inverter-go2rtc`, `tailscaled`) report active and reachable.
- **Remote Access Verification**:
  - Remote Desktop Clients: Authenticate via `x-inverter-remote-token: adsilinux` (or bearer token). Verified live traffic: `laptop-inverterengr` (`100.111.111.111`) streaming WebSocket telemetry and camera feeds from `100.123.123.123:3500`.
  - Remote Web Browsers: Connect to `http://100.123.123.123:3500/` or `http://192.168.4.193:3500/` and authenticate via `/login.html` with operator credentials (`admin` / `1234`) or developer credentials (`devClard` / rotating `devMM`). Verified session cookies and HTTP 200 responses.

