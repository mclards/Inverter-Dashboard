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
