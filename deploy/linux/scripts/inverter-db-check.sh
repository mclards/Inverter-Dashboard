#!/usr/bin/env bash
# Validate the authoritative gateway database before the Node service opens it.

set -u
umask 027

DB_DIR="${INVERTER_DATA_DIR:-/var/lib/inverter-dashboard/db}"
DB_PATH="${DB_DIR}/adsi.db"
LOG_PATH="/var/log/inverter-dashboard/db-check.log"

mkdir -p "$(dirname "${LOG_PATH}")" 2>/dev/null || true

log_line() {
    echo "[$(date -Iseconds)] $1" >> "${LOG_PATH}"
}

[ -f "${DB_PATH}" ] || exit 0

CHECK_OUTPUT="$(sqlite3 "${DB_PATH}" 'PRAGMA quick_check;' 2>&1 || true)"
[ "${CHECK_OUTPUT}" = "ok" ] && exit 0

REPAIRED_PATH="${DB_PATH}.repaired.$$"
BACKUP_PATH="${DB_PATH}.corrupted.$(date +%Y%m%d%H%M%S).bak"
log_line "WARNING: database quick_check failed (${CHECK_OUTPUT}). Attempting validated recovery."

if sqlite3 "${DB_PATH}" '.dump' 2>>"${LOG_PATH}" \
    | sqlite3 "${REPAIRED_PATH}" 2>>"${LOG_PATH}"; then
    REPAIRED_CHECK="$(sqlite3 "${REPAIRED_PATH}" 'PRAGMA quick_check;' 2>&1 || true)"
else
    REPAIRED_CHECK="dump/import failed"
fi

if [ "${REPAIRED_CHECK}" = "ok" ]; then
    mv "${DB_PATH}" "${BACKUP_PATH}"
    mv "${REPAIRED_PATH}" "${DB_PATH}"
    log_line "Recovery succeeded; original retained at ${BACKUP_PATH}."
    exit 0
fi

rm -f -- "${REPAIRED_PATH}"
log_line "ERROR: recovery did not produce a valid database (${REPAIRED_CHECK}). Original left untouched."
exit 1
