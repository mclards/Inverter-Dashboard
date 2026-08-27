#!/usr/bin/env bash
# Install, enroll, and persist Tailscale remote access for the appliance.

set -Eeuo pipefail
umask 077

log() { echo "[tailscale] $1"; }
fail() { echo "[tailscale] ERROR: $1" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "Run this setup as root."

if ! command -v tailscale >/dev/null 2>&1; then
    command -v curl >/dev/null 2>&1 || fail "curl is required to install Tailscale."
    log "Tailscale is not installed; downloading the official Linux installer..."
    INSTALLER="$(mktemp)"
    trap 'rm -f "${INSTALLER:-}"' EXIT
    curl --proto '=https' --tlsv1.2 -fsSL https://tailscale.com/install.sh -o "${INSTALLER}"
    /usr/bin/bash "${INSTALLER}"
    rm -f "${INSTALLER}"
    trap - EXIT
else
    log "Existing Tailscale installation detected."
fi

systemctl enable --now tailscaled.service >/dev/null

tailscale_running() {
    tailscale status --json 2>/dev/null \
        | grep -Eq '"BackendState"[[:space:]]*:[[:space:]]*"Running"'
}

if ! tailscale_running; then
    HOST_NAME="${TAILSCALE_HOSTNAME:-$(hostname -s)}"
    if [ -n "${TAILSCALE_AUTH_KEY:-}" ]; then
        log "Enrolling this host with the supplied one-time auth key..."
        tailscale up --auth-key="${TAILSCALE_AUTH_KEY}" --hostname="${HOST_NAME}" --ssh --timeout=10m
        unset TAILSCALE_AUTH_KEY
    else
        log "One-time tailnet authorization is required. Open the URL printed below."
        tailscale up --hostname="${HOST_NAME}" --ssh --timeout=10m
    fi
elif tailscale debug prefs 2>/dev/null | grep -Eq '"RunSSH"[[:space:]]*:[[:space:]]*true'; then
    log "Tailscale is signed in and Tailscale SSH is already enabled."
else
    LOCAL_SSH_IP="$(printf '%s' "${SSH_CONNECTION:-}" | awk '{print $3}')"
    case "${LOCAL_SSH_IP}" in
        100.*|fd7a:*)
            log "Active Tailscale SSH session detected; leaving SSH mode unchanged to avoid disconnecting it."
            log "After reconnecting locally, enable it once with: sudo tailscale set --ssh"
            ;;
        *)
            tailscale set --ssh
            log "Tailscale SSH enabled."
            ;;
    esac
fi

tailscale_running || fail "Tailscale is installed but not connected to a tailnet."
TAILSCALE_IP="$(tailscale ip -4 2>/dev/null || true)"
log "Connected${TAILSCALE_IP:+ at ${TAILSCALE_IP}}; identity persists across reboot."
