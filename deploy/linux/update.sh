#!/usr/bin/env bash
# One-command Git update for an installed Linux appliance.

set -Eeuo pipefail

APP_DIR="/opt/inverter-dashboard"
APP_USER="inverter"

if [ "$(id -u)" -ne 0 ]; then
    echo "Run as root: sudo ${APP_DIR}/deploy/linux/update.sh" >&2
    exit 1
fi

[ -d "${APP_DIR}/.git" ] || {
    echo "${APP_DIR} is not a Git checkout. Reinstall from Git before using update.sh." >&2
    exit 1
}

if [ -n "$(runuser -u "${APP_USER}" -- git -C "${APP_DIR}" status --porcelain)" ]; then
    echo "Update refused: ${APP_DIR} has local changes. Preserve or commit them first." >&2
    exit 1
fi

runuser -u "${APP_USER}" -- git -C "${APP_DIR}" fetch origin main
runuser -u "${APP_USER}" -- git -C "${APP_DIR}" merge --ff-only origin/main

INVERTER_SKIP_SYSTEM_PACKAGES=1 "${APP_DIR}/deploy/linux/setup.sh"
