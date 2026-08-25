#!/bin/bash
# inverter-db-check.sh — Pre-startup SQLite database integrity verification & auto-repair
DATA_DIR="${INVERTER_DATA_DIR:-/var/lib/inverter-dashboard}"
DB_PATH="${DATA_DIR}/db/inverter.db"
LOG_PATH="/var/log/inverter-dashboard/db-check.log"

mkdir -p "$(dirname "$LOG_PATH")" 2>/dev/null || true

if [ -f "$DB_PATH" ]; then
    CHECK_OUTPUT=$(sqlite3 "$DB_PATH" "PRAGMA quick_check;" 2>&1 || echo "error")
    if [ "$CHECK_OUTPUT" != "ok" ]; then
        echo "[$(date -Iseconds)] WARNING: Corrupted SQLite database detected ($CHECK_OUTPUT). Attempting auto-repair..." >> "$LOG_PATH"
        sqlite3 "$DB_PATH" ".dump" | sqlite3 "${DB_PATH}.repaired" 2>/dev/null || true
        if [ -f "${DB_PATH}.repaired" ]; then
            mv "$DB_PATH" "${DB_PATH}.corrupted.$(date +%Y%m%d%H%M%S).bak"
            mv "${DB_PATH}.repaired" "$DB_PATH"
            echo "[$(date -Iseconds)] Auto-repair completed successfully." >> "$LOG_PATH"
        fi
    fi
fi
exit 0
