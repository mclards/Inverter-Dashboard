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
- Runtime settings, credentials, topology, databases, camera configuration,
  forecast artifacts, and logs are preserved on reruns and Git updates.
- The production backup restore path no longer depends on the vulnerable
  `extract-zip` package. Its contained ZIP reader rejects path traversal,
  absolute paths, symlinks, NUL names, and excessive archive expansion while
  retaining Zip64 support for large plant backups.

## Operator workflow

Fresh install:

```bash
curl -fsSL https://raw.githubusercontent.com/mclards/Inverter-Dashboard/main/deploy/linux/install.sh | sudo bash
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
