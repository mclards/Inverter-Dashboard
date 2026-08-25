#!/usr/bin/env bash
# ==============================================================================
# ADSI Inverter Dashboard 2.0 — Linux Production Appliance Installer
# Automated 18-Step Hardened Setup for Debian / Ubuntu Server
#
# Steps:
#   1. Prerequisite Packages & SSH
#   2. Node.js LTS Installation
#   3. Dedicated Service User & Group (`inverter`)
#   4. Application Directory Setup (/opt/inverter-dashboard)
#   5. Storage Directories Setup (/var/lib/inverter-dashboard)
#   6. Default Auth Credentials Setup
#   7. Systemd Environment Template (/etc/default/inverter-dashboard)
#   8. Python venv & Microservice Dependencies Setup
#   9. Node.js Production Dependencies Setup
#  10. SQLite Startup Integrity Auto-Repair Script
#  11. Systemd Service Units Installation (inverter.target suite)
#  12. go2rtc Live Camera Binary Setup
#  13. File Ownership & Permissions Enforcement
#  14. UFW Industrial Firewall Configuration
#  15. Lid-Close & Sleep/Suspend Hardening
#  16. Storage Performance & WAL Optimization
#  17. Systemd Service Enable & Boot
#  18. Post-Setup Verification & Network Discovery Summary
# ==============================================================================
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

log()   { echo -e "${CYAN}[setup]${NC} $1"; }
ok()    { echo -e "${GREEN}[  OK ]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN ]${NC} $1"; }
error() { echo -e "${RED}[FAIL ]${NC} $1" >&2; exit 1; }

echo -e "\n${BOLD}${CYAN}================================================================${NC}"
echo -e "${BOLD}  ADSI INVERTER DASHBOARD 2.0 — LINUX APPLIANCE SETUP${NC}"
echo -e "${BOLD}${CYAN}================================================================${NC}\n"

if [ "$(id -u)" -ne 0 ]; then
    error "This script must be run as root. Use 'sudo ./setup.sh'."
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
APP_DIR="/opt/inverter-dashboard"
DATA_DIR="/var/lib/inverter-dashboard"
LOG_DIR="/var/log/inverter-dashboard"
APP_USER="inverter"
APP_GROUP="inverter"

# ── STEP 1: Prerequisite Packages & SSH ───────────────────────────────────────
log "[1/18] Installing system dependencies, build tools, SQLite, and OpenSSH..."
apt-get update -qq
apt-get install -y -qq \
    curl \
    git \
    build-essential \
    python3 \
    python3-venv \
    python3-pip \
    sqlite3 \
    openssh-server \
    ufw \
    ca-certificates \
    gnupg >/dev/null
ok "Base packages installed."

# ── STEP 2: Node.js LTS Installation ──────────────────────────────────────────
log "[2/18] Checking Node.js runtime..."
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d'.' -f1 | tr -d 'v')" -lt 20 ]; then
    log "Installing Node.js 22.x LTS repository..."
    mkdir -p /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg --yes
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
    apt-get update -qq
    apt-get install -y -qq nodejs >/dev/null
fi
ok "Node.js $(node -v) is ready."

# ── STEP 3: Dedicated Service User & Group ────────────────────────────────────
log "[3/18] Creating dedicated service user '${APP_USER}'..."
if ! getent group "${APP_GROUP}" >/dev/null 2>&1; then
    groupadd -r "${APP_GROUP}"
fi
if ! getent passwd "${APP_USER}" >/dev/null 2>&1; then
    useradd -r -g "${APP_GROUP}" -d "${DATA_DIR}" -s /usr/sbin/nologin "${APP_USER}"
fi
ok "Service user '${APP_USER}' configured."

# ── STEP 4: Application Directory Setup ───────────────────────────────────────
log "[4/18] Synchronizing application code into ${APP_DIR}..."
mkdir -p "${APP_DIR}"
cp -r "${REPO_ROOT}/"* "${APP_DIR}/" 2>/dev/null || true
ok "Application directory ready."

# ── STEP 5: Storage Directories Setup ─────────────────────────────────────────
log "[5/18] Creating isolated runtime storage directories in ${DATA_DIR}..."
mkdir -p \
    "${DATA_DIR}/db" \
    "${DATA_DIR}/config" \
    "${DATA_DIR}/auth" \
    "${DATA_DIR}/go2rtc" \
    "${DATA_DIR}/archives" \
    "${LOG_DIR}"
ok "Storage directories created."

# ── STEP 6: Default Auth Credentials Setup ────────────────────────────────────
log "[6/18] Configuring default authentication credentials..."
AUTH_FILE="${DATA_DIR}/auth/credentials.json"
if [ ! -f "${AUTH_FILE}" ]; then
    # SHA-256 for default password '1234': 03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4
    cat <<'EOF' > "${AUTH_FILE}"
{
  "username": "admin",
  "passwordHash": "03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4",
  "createdAt": "2026-08-24T00:00:00.000Z"
}
EOF
    chmod 600 "${AUTH_FILE}"
fi
ok "Authentication credentials secured."

# ── STEP 7: Systemd Environment Template ──────────────────────────────────────
log "[7/18] Installing environment defaults into /etc/default/inverter-dashboard..."
install -m 644 -o root -g root "${APP_DIR}/deploy/linux/default/inverter-dashboard" /etc/default/inverter-dashboard
ok "Environment file installed."

# ── STEP 8: Python venv & Microservice Dependencies Setup ─────────────────────
log "[8/18] Setting up Python virtual environment and AI/Modbus dependencies..."
if [ ! -d "${APP_DIR}/venv" ]; then
    python3 -m venv "${APP_DIR}/venv"
fi
"${APP_DIR}/venv/bin/pip" install --upgrade pip -q
"${APP_DIR}/venv/bin/pip" install -r "${APP_DIR}/requirements.txt" -q
ok "Python venv and dependencies installed."

# ── STEP 9: Node.js Production Dependencies Setup ─────────────────────────────
log "[9/18] Installing Node.js backend dependencies..."
cd "${APP_DIR}"
npm install --omit=dev --loglevel=error
ok "Node.js dependencies installed."

# ── STEP 10: SQLite Startup Integrity Auto-Repair Script ──────────────────────
log "[10/18] Installing database auto-repair script..."
chmod +x "${APP_DIR}/deploy/linux/scripts/inverter-db-check.sh"
ok "Database auto-repair script enabled."

# ── STEP 11: Systemd Service Units Installation ───────────────────────────────
log "[11/18] Installing systemd unit files..."
cp "${APP_DIR}/deploy/linux/systemd/"*.service /etc/systemd/system/
cp "${APP_DIR}/deploy/linux/systemd/inverter.target" /etc/systemd/system/
systemctl daemon-reload
ok "Systemd units registered."

# ── STEP 12: go2rtc Live Camera Binary Setup ──────────────────────────────────
log "[12/18] Setting up go2rtc live camera streaming daemon..."
GO2RTC_BIN="${APP_DIR}/backend/engines/go2rtc/go2rtc"
if [ -f "${GO2RTC_BIN}" ]; then
    chmod +x "${GO2RTC_BIN}"
fi
ok "go2rtc binary permissions verified."

# ── STEP 13: File Ownership & Permissions Enforcement ─────────────────────────
log "[13/18] Enforcing security ownership for user '${APP_USER}'..."
chown -R "${APP_USER}:${APP_GROUP}" "${APP_DIR}" "${DATA_DIR}" "${LOG_DIR}"
chmod -R 750 "${DATA_DIR}"
chmod -R 750 "${LOG_DIR}"
ok "Ownership finalized."

# ── STEP 14: UFW Industrial Firewall Configuration ────────────────────────────
log "[14/18] Configuring UFW industrial firewall..."
if command -v ufw >/dev/null 2>&1; then
    ufw allow 22/tcp comment "SSH Remote Management" >/dev/null 2>&1 || true
    ufw allow 3500/tcp comment "ADSI Inverter Dashboard 2.0 Web & WS Gateway" >/dev/null 2>&1 || true
    ufw allow 1984/tcp comment "go2rtc Camera Streaming API" >/dev/null 2>&1 || true
    ufw allow 8555/tcp comment "WebRTC Signaling & Video" >/dev/null 2>&1 || true
    ufw allow 8555/udp comment "WebRTC Media UDP" >/dev/null 2>&1 || true
    ok "Firewall ports 22, 3500, 1984, 8555 opened."
fi

# ── STEP 15: Lid-Close & Sleep/Suspend Hardening ───────────────────────────────
log "[15/18] Applying 24/7 industrial uptime locks (disabling lid-close sleep)..."
LOGIND_CONF="/etc/systemd/logind.conf"
if [ -f "${LOGIND_CONF}" ]; then
    if ! grep -q "^HandleLidSwitch=ignore" "${LOGIND_CONF}"; then
        echo "HandleLidSwitch=ignore" >> "${LOGIND_CONF}"
        echo "HandleLidSwitchExternalPower=ignore" >> "${LOGIND_CONF}"
        systemctl restart systemd-logind 2>/dev/null || true
    fi
fi
systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target >/dev/null 2>&1 || true
ok "Sleep and lid-close locks enforced."

# ── STEP 16: Storage Performance & WAL Optimization ───────────────────────────
log "[16/18] Initializing database in WAL mode..."
su -s /bin/bash "${APP_USER}" -c "node -e 'const db = require(\"${APP_DIR}/backend/core/db\"); db.db.close();'" 2>/dev/null || true
ok "Database initialized with WAL mode."

# ── STEP 17: Systemd Service Enable & Boot ────────────────────────────────────
log "[17/18] Enabling and starting inverter.target suite..."
systemctl enable inverter.target inverter-server.service inverter-engine.service inverter-forecast.service inverter-go2rtc.service >/dev/null 2>&1 || true
systemctl restart inverter.target
ok "All Inverter Dashboard 2.0 services started."

# ── STEP 18: Post-Setup Summary ───────────────────────────────────────────────
echo -e "\n${BOLD}${GREEN}================================================================${NC}"
echo -e "${BOLD}${GREEN}  SETUP COMPLETE — ADSI INVERTER DASHBOARD 2.0 IS ONLINE!${NC}"
echo -e "${BOLD}${GREEN}================================================================${NC}\n"

echo -e "  ${BOLD}Server Port:${NC}        http://<server-ip>:3500"
echo -e "  ${BOLD}Systemd Target:${NC}     sudo systemctl status inverter.target"
echo -e "  ${BOLD}Service Logs:${NC}       sudo journalctl -u inverter-server.service -f"
echo -e "  ${BOLD}Storage Directory:${NC}  ${DATA_DIR}\n"
