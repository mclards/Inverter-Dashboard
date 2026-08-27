#!/usr/bin/env bash
# One-command bootstrap for a fresh Debian/Ubuntu dashboard appliance.

set -Eeuo pipefail
umask 027

APP_DIR="/opt/inverter-dashboard"
REPO_URL="https://github.com/mclards/Inverter-Dashboard.git"

fail() {
    echo "[install] ERROR: $1" >&2
    exit 1
}

[ "$(id -u)" -eq 0 ] || fail "Run through sudo: curl ... | sudo bash"
command -v apt-get >/dev/null 2>&1 \
    || fail "This installer currently supports Debian and Ubuntu systems with apt-get."

echo "[install] Preparing Git bootstrap prerequisites..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates git >/dev/null

if [ -d "${APP_DIR}/.git" ]; then
    CURRENT_ORIGIN="$(git -c safe.directory="${APP_DIR}" -C "${APP_DIR}" remote get-url origin 2>/dev/null || true)"
    [ "${CURRENT_ORIGIN}" = "${REPO_URL}" ] \
        || fail "Existing checkout has an unexpected origin: ${CURRENT_ORIGIN:-missing}"
    [ -z "$(git -c safe.directory="${APP_DIR}" -C "${APP_DIR}" status --porcelain)" ] \
        || fail "Existing checkout has local changes. Preserve or commit them before reinstalling."
    echo "[install] Fast-forwarding the existing dashboard checkout..."
    git -c safe.directory="${APP_DIR}" -C "${APP_DIR}" fetch origin main
    git -c safe.directory="${APP_DIR}" -C "${APP_DIR}" merge --ff-only origin/main
elif [ -e "${APP_DIR}" ]; then
    fail "${APP_DIR} already exists but is not a Git checkout. Move it aside or remove it explicitly."
else
    echo "[install] Downloading the dashboard..."
    git clone --depth 1 --branch main "${REPO_URL}" "${APP_DIR}"
fi

chmod 755 "${APP_DIR}/deploy/linux/setup.sh"
exec "${APP_DIR}/deploy/linux/setup.sh"
