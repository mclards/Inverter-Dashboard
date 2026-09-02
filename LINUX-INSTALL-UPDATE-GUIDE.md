# Linux Installation, Git Release, and Update Guide

This is the vendor-neutral operating guide for humans and AI assistants that
install or update the ADSI Inverter Dashboard Linux appliance. Project safety
and architecture rules in `AGENTS.md` remain mandatory.

## Canonical repository and branch

- Repository: `https://github.com/mclards/Inverter-Dashboard.git`
- Production branch: `main`
- Application checkout: `/opt/inverter-dashboard`
- Persistent runtime root: `/var/lib/inverter-dashboard`
- Dashboard port: `3500`

Do not deploy by copying a local folder, ZIP archive, or release bundle over the
Linux checkout. Production updates flow through reviewed commits on `main`.

## Fresh installation and repeat update

Use this same command on a fresh Debian/Ubuntu host or on an existing clean
installation:

```bash
sudo bash -c 'command -v curl >/dev/null || { apt-get update -qq && apt-get install -y -qq ca-certificates curl; }; curl -fsSL https://raw.githubusercontent.com/mclards/Inverter-Dashboard/main/deploy/linux/install.sh | bash'
```

Paste the URL as plain text. Markdown forms such as `[URL](URL)` are invalid in
a terminal.

The bootstrap installs its own prerequisites, repairs the exact legacy
NodeSource keyring defect when present, clones or fast-forwards the canonical
repository, and runs the complete idempotent setup. Setup installs and verifies
the gateway, telemetry engine, forecast worker, go2rtc, database, firewall,
systemd services, Tailscale, canonical inverter topology, and component health.

On a fresh install, setup seeds the dashboard's validated 27-inverter topology.
On reruns it preserves any valid operator-customized topology. It upgrades only
the exact untouched synthetic fresh-install topology and keeps an
`ipconfig.json.pre-canonical-seed` backup beside it.

An existing checkout with an unexpected Git remote is rejected. Application
source is cleanly synchronized to the canonical `main` branch, while runtime data
and credentials under `/var/lib/inverter-dashboard` are strictly preserved.

## Tailscale enrollment

An already connected Tailscale identity is preserved. A new device prints one
authorization URL during installation. After that one enrollment, `tailscaled`
starts at boot and retains the device identity across normal reconnects and
reboots, subject to the tailnet administrator's key-expiry and SSH policy.

A pre-authorized key can make first enrollment unattended, but it is an
operator secret. Never place it in source code, documentation, commits, logs,
or persistent dashboard configuration.

## Verify the installed appliance

The installer performs this health check automatically and fails instead of
printing a false success. It can also be run independently:

```bash
sudo /opt/inverter-dashboard/deploy/linux/scripts/inverter-health-check.sh
```

The check requires all dashboard services, `tailscaled`, the gateway HTTP
endpoint, telemetry health endpoint, and go2rtc API to be reachable. This proves
service reachability only. Successful live Modbus polling requires the plant
network and a fresh telemetry read from a configured inverter/node.

On Linux, systemd owns service start, stop, restart, and boot persistence. The
browser lifecycle page is status-only for these controls; it must not request
or store a sudo password. Use the installer/update command for normal service
deployment and the read-only health command for verification.

## Developer commit and push workflow

Run these steps from the authoritative development checkout. Preserve unrelated
or uncommitted user/Antigravity work and stage only files intended for the
release.

1. Inspect branch, worktree, and the exact changes:

   ```bash
   git status --branch --short
   git diff
   git diff --check
   ```

2. Run verification appropriate to the change. The minimum project release
   boundary includes:

   ```bash
   node scripts/smoke-all.js --skip-python --no-rebuild
   python -m py_compile backend/engines/inverter/InverterCoreService.py backend/engines/forecast/ForecastCoreService.py
   ```

   Linux deployment changes also require:

   ```bash
   node server/tests/linuxDeploymentContract.test.js
   bash -n deploy/linux/install.sh deploy/linux/setup.sh deploy/linux/update.sh deploy/linux/scripts/*.sh
   ```

   Follow all additional checks in `AGENTS.md`, including paired browser assets,
   cache versions, JSON validation, and focused tests when applicable.

3. Confirm the remote branch has not moved unexpectedly:

   ```bash
   git fetch origin main
   git status --branch --short
   ```

4. Stage only intentional files and inspect the release payload:

   ```bash
   git add path/to/changed-file
   git diff --cached --check
   git diff --cached
   ```

   Repeat `git add` for each intentional file or directory; do not stage
   unrelated work merely to make the worktree appear clean.

5. Commit and push without force:

   ```bash
   git commit -m "type(scope): concise description"
   git push origin main
   ```

6. Confirm local and remote `main` resolve to the pushed commit:

   ```bash
   git status --branch --short
   git log -1 --oneline --decorate
   git ls-remote origin refs/heads/main
   ```

If the push is rejected or `origin/main` moved, stop and inspect the divergence.
Never use force-push, `reset --hard`, `checkout --`, or `git clean` as an
automatic remedy.

## Production update flow

After a verified commit reaches `main`, run the canonical installation/update
command from this guide on the Linux appliance. The bootstrap fast-forwards the
clean checkout and reruns setup, which preserves runtime state, refreshes
dependencies and units, restarts components, and performs final health checks.

Do not claim that the production device is updated merely because GitHub is
updated. Production is updated only after the Linux checkout reaches the new
commit and the appliance health check succeeds.

## Failure evidence

When installation or updating fails, capture the original output and inspect
current state before changing anything:

```bash
sudo -u inverter git -C /opt/inverter-dashboard status --branch --short
sudo systemctl status inverter.target inverter-engine.service inverter-server.service inverter-forecast.service inverter-go2rtc.service tailscaled.service --no-pager --full
sudo journalctl -u inverter-engine.service -u inverter-server.service -u inverter-forecast.service -u inverter-go2rtc.service -n 200 --no-pager
sudo /opt/inverter-dashboard/deploy/linux/scripts/inverter-health-check.sh
```

Fix repeatable failures in the repository installer or application, add a
regression check, push the correction to `main`, and then use the canonical
update flow. Avoid host-only patches that leave the next installation broken.
