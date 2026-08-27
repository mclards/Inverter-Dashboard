#!/usr/bin/env bash
# ADSI Inverter Dashboard 2.0 - Debian/Ubuntu production appliance installer.
# Safe to rerun from the canonical Git checkout at /opt/inverter-dashboard.

set -Eeuo pipefail
umask 027

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

if [ "$(id -u)" -ne 0 ]; then
    error "Run this installer as root: sudo ./deploy/linux/setup.sh"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
APP_DIR="/opt/inverter-dashboard"
DATA_ROOT="/var/lib/inverter-dashboard"
DB_DIR="${DATA_ROOT}/db"
LOG_DIR="/var/log/inverter-dashboard"
ENV_FILE="/etc/default/inverter-dashboard"
APP_USER="inverter"
APP_GROUP="inverter"
GO2RTC_VERSION="1.9.14"
NODESOURCE_KEYRING="/usr/share/keyrings/nodesource.gpg"
NODESOURCE_SOURCES="/etc/apt/sources.list.d/nodesource.sources"
LEGACY_NODESOURCE_LIST="/etc/apt/sources.list.d/nodesource.list"
LEGACY_NODESOURCE_KEY="/etc/apt/keyrings/nodesource.gpg"

if grep -Fqs \
    'signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main' \
    "${LEGACY_NODESOURCE_LIST}" 2>/dev/null; then
    rm -f -- "${LEGACY_NODESOURCE_LIST}" "${LEGACY_NODESOURCE_KEY}"
fi

echo -e "\n${BOLD}${CYAN}================================================================${NC}"
echo -e "${BOLD}  ADSI INVERTER DASHBOARD 2.0 - LINUX APPLIANCE SETUP${NC}"
echo -e "${BOLD}${CYAN}================================================================${NC}\n"

log "[1/18] Validating the source checkout..."
for required in package.json package-lock.json requirements.txt server/index.js; do
    [ -f "${REPO_ROOT}/${required}" ] || error "Missing required source file: ${required}"
done
[ -d "${REPO_ROOT}/.git" ] || warn "Source is not a Git checkout; updates will require a new release bundle."
ok "Source checkout validated at ${REPO_ROOT}."

log "[2/18] Installing required operating-system packages..."
if [ "${INVERTER_SKIP_SYSTEM_PACKAGES:-0}" != "1" ]; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq \
        build-essential ca-certificates curl git gnupg openssh-server \
        python3 python3-pip python3-venv rsync sqlite3 ufw >/dev/null
fi
ok "Operating-system prerequisites are ready."

/usr/bin/bash "${REPO_ROOT}/deploy/linux/scripts/tailscale-setup.sh"
ok "Persistent Tailscale remote access is ready."

log "[3/18] Checking the Node.js runtime..."
NODE_MAJOR=0
if command -v node >/dev/null 2>&1; then
    NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
fi
if [ "${NODE_MAJOR}" -lt 20 ]; then
    case "$(dpkg --print-architecture)" in
        amd64|arm64) NODE_ARCH="$(dpkg --print-architecture)" ;;
        *) error "NodeSource Node.js 22 supports only amd64 and arm64 on this installer." ;;
    esac
    install -d -m 755 /usr/share/keyrings
    NODE_KEY_ASC="$(mktemp)"
    NODE_KEY_GPG="$(mktemp)"
    trap 'rm -f "${NODE_KEY_ASC:-}" "${NODE_KEY_GPG:-}"' EXIT
    curl --proto '=https' --tlsv1.2 -fsSL \
        https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
        -o "${NODE_KEY_ASC}"
    gpg --batch --yes --dearmor --output "${NODE_KEY_GPG}" "${NODE_KEY_ASC}"
    gpg --batch --no-default-keyring --keyring "${NODE_KEY_GPG}" --list-keys >/dev/null
    install -m 644 -o root -g root "${NODE_KEY_GPG}" "${NODESOURCE_KEYRING}"
    rm -f "${NODE_KEY_ASC}" "${NODE_KEY_GPG}"
    trap - EXIT
    rm -f -- "${LEGACY_NODESOURCE_LIST}" "${LEGACY_NODESOURCE_KEY}"
    cat > "${NODESOURCE_SOURCES}" <<EOF
Types: deb
URIs: https://deb.nodesource.com/node_22.x
Suites: nodistro
Components: main
Architectures: ${NODE_ARCH}
Signed-By: ${NODESOURCE_KEYRING}
EOF
    chmod 644 "${NODESOURCE_SOURCES}"
    apt-get update -qq
    apt-get install -y -qq nodejs >/dev/null
fi
command -v npm >/dev/null 2>&1 || error "npm is unavailable after Node.js setup."
ok "Node.js $(node -v) and npm $(npm -v) are ready."

log "[4/18] Creating the dedicated service identity..."
getent group "${APP_GROUP}" >/dev/null 2>&1 || groupadd --system "${APP_GROUP}"
if ! getent passwd "${APP_USER}" >/dev/null 2>&1; then
    useradd --system --gid "${APP_GROUP}" --home-dir "${DATA_ROOT}" \
        --shell /usr/sbin/nologin "${APP_USER}"
fi
ok "Service user ${APP_USER} is ready."

log "[5/18] Preparing the Git-managed application directory..."
if [ "${REPO_ROOT}" != "${APP_DIR}" ]; then
    install -d -m 755 "${APP_DIR}"
    rsync -a \
        --exclude node_modules --exclude venv --exclude .venv \
        --exclude storage --exclude release --exclude dist --exclude build \
        "${REPO_ROOT}/" "${APP_DIR}/"
else
    ok "Installer is running from the canonical application checkout; self-copy skipped."
fi
chown -R "${APP_USER}:${APP_GROUP}" "${APP_DIR}"
ok "Application source is ready at ${APP_DIR}."

log "[6/18] Creating persistent runtime directories..."
install -d -o "${APP_USER}" -g "${APP_GROUP}" -m 750 \
    "${DATA_ROOT}" "${DB_DIR}" "${DB_DIR}/archive" \
    "${DATA_ROOT}/config" "${DATA_ROOT}/auth" "${DATA_ROOT}/go2rtc" \
    "${DATA_ROOT}/archives" "${DATA_ROOT}/forecast" "${DATA_ROOT}/weather" \
    "${LOG_DIR}"
ok "Persistent data is isolated under ${DATA_ROOT}."

log "[7/18] Configuring operator authentication..."
AUTH_FILE="${DATA_ROOT}/auth/credentials.json"
if [ ! -f "${AUTH_FILE}" ]; then
    cat > "${AUTH_FILE}" <<EOF
{
  "username": "admin",
  "passwordHash": "03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4",
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
    chown "${APP_USER}:${APP_GROUP}" "${AUTH_FILE}"
    chmod 600 "${AUTH_FILE}"
    warn "Bootstrap operator credentials are admin / 1234; change them after first sign-in."
else
    ok "Existing operator credentials preserved."
fi

log "[8/18] Installing canonical runtime environment settings..."
ENV_TEMPLATE="${APP_DIR}/deploy/linux/default/inverter-dashboard"
if [ ! -f "${ENV_FILE}" ]; then
    install -m 640 -o root -g "${APP_GROUP}" "${ENV_TEMPLATE}" "${ENV_FILE}"
elif grep -Fqx 'INVERTER_DATA_DIR=/var/lib/inverter-dashboard' "${ENV_FILE}" \
    && grep -Fqx 'INVERTER_PORTABLE_DATA_DIR=/var/lib/inverter-dashboard' "${ENV_FILE}"; then
    cp -a "${ENV_FILE}" "${ENV_FILE}.pre-db-layout"
    sed -i \
        -e 's|^INVERTER_DATA_DIR=/var/lib/inverter-dashboard$|INVERTER_DATA_DIR=/var/lib/inverter-dashboard/db|' \
        -e '/^INVERTER_PORTABLE_DATA_DIR=\/var\/lib\/inverter-dashboard$/d' \
        "${ENV_FILE}"
    grep -q '^ADSI_SERVER_PORT=' "${ENV_FILE}" \
        || echo 'ADSI_SERVER_PORT=3500' >> "${ENV_FILE}"
    grep -q '^INVERTER_STORAGE_DIR=' "${ENV_FILE}" \
        || echo 'INVERTER_STORAGE_DIR=/var/lib/inverter-dashboard' >> "${ENV_FILE}"
    grep -q '^ADSI_LOGIN_CREDENTIAL_PATH=' "${ENV_FILE}" \
        || echo 'ADSI_LOGIN_CREDENTIAL_PATH=/var/lib/inverter-dashboard/auth/credentials.json' >> "${ENV_FILE}"
    chown root:"${APP_GROUP}" "${ENV_FILE}"
    chmod 640 "${ENV_FILE}"
    warn "Migrated the legacy Linux data-root environment; backup: ${ENV_FILE}.pre-db-layout"
else
    ok "Existing operator-supplied environment file preserved."
fi
set -a
# shellcheck disable=SC1090
. "${ENV_FILE}"
set +a
case "${INVERTER_DATA_DIR:-}" in
    /*) ;;
    *) error "INVERTER_DATA_DIR must be an absolute operator-approved path." ;;
esac
if [ ! -d "${INVERTER_DATA_DIR}" ]; then
    install -d -o "${APP_USER}" -g "${APP_GROUP}" -m 750 "${INVERTER_DATA_DIR}"
fi
runuser -u "${APP_USER}" -- test -w "${INVERTER_DATA_DIR}" \
    || error "The service user cannot write to ${INVERTER_DATA_DIR}."

log "[9/18] Installing Python dependencies in an isolated environment..."
if [ ! -x "${APP_DIR}/venv/bin/python" ]; then
    runuser -u "${APP_USER}" -- python3 -m venv "${APP_DIR}/venv"
fi
runuser -u "${APP_USER}" -- "${APP_DIR}/venv/bin/pip" install --upgrade pip -q
runuser -u "${APP_USER}" -- "${APP_DIR}/venv/bin/pip" install \
    -r "${APP_DIR}/requirements.txt" -q
ok "Python dependencies are ready."

log "[10/18] Installing production Node.js dependencies..."
runuser -u "${APP_USER}" -- npm --prefix "${APP_DIR}" ci --omit=dev --loglevel=error
ok "Node.js dependencies are ready."

log "[11/18] Provisioning the pinned go2rtc Linux binary..."
case "$(uname -m)" in
    x86_64|amd64)
        GO2RTC_ASSET="go2rtc_linux_amd64"
        GO2RTC_SHA256="32d616af226bd731678ffde328b94cfb94e30339bfefc469cfb76323144615a6"
        ;;
    aarch64|arm64)
        GO2RTC_ASSET="go2rtc_linux_arm64"
        GO2RTC_SHA256="359fabade8a7a51e81a55fe6df6b0ef81764a5e1d63179577534eaaa71904b50"
        ;;
    armv7l|armv8l)
        GO2RTC_ASSET="go2rtc_linux_arm"
        GO2RTC_SHA256="4d7e1639af5a2722a28e864468fd8099b3c1682565446c798bf9e3b38fde12e4"
        ;;
    *) error "Unsupported go2rtc CPU architecture: $(uname -m)" ;;
esac
GO2RTC_BIN="/usr/local/bin/go2rtc"
if [ ! -x "${GO2RTC_BIN}" ] \
    || ! echo "${GO2RTC_SHA256}  ${GO2RTC_BIN}" | sha256sum --check --status; then
    GO2RTC_TMP="$(mktemp)"
    trap 'rm -f "${GO2RTC_TMP:-}"' EXIT
    curl --proto '=https' --tlsv1.2 -fL \
        "https://github.com/AlexxIT/go2rtc/releases/download/v${GO2RTC_VERSION}/${GO2RTC_ASSET}" \
        -o "${GO2RTC_TMP}"
    echo "${GO2RTC_SHA256}  ${GO2RTC_TMP}" | sha256sum --check --status \
        || error "go2rtc checksum verification failed."
    install -m 755 -o root -g root "${GO2RTC_TMP}" "${GO2RTC_BIN}"
    rm -f "${GO2RTC_TMP}"
    trap - EXIT
fi
GO2RTC_CONFIG="${DATA_ROOT}/go2rtc/go2rtc.yaml"
if [ ! -f "${GO2RTC_CONFIG}" ]; then
    install -m 640 -o "${APP_USER}" -g "${APP_GROUP}" \
        "${APP_DIR}/deploy/linux/default/go2rtc.yaml" "${GO2RTC_CONFIG}"
fi
ok "go2rtc ${GO2RTC_VERSION} is installed with a verified checksum."

log "[12/18] Validating executable scripts and application syntax..."
chmod 755 "${APP_DIR}/deploy/linux/setup.sh" \
    "${APP_DIR}/deploy/linux/install.sh" \
    "${APP_DIR}/deploy/linux/update.sh" \
    "${APP_DIR}/deploy/linux/scripts/inverter-db-check.sh" \
    "${APP_DIR}/deploy/linux/scripts/inverter-health-check.sh" \
    "${APP_DIR}/deploy/linux/scripts/tailscale-setup.sh"
runuser -u "${APP_USER}" -- /usr/bin/node --check "${APP_DIR}/server/index.js"
runuser -u "${APP_USER}" -- "${APP_DIR}/venv/bin/python" -m py_compile \
    "${APP_DIR}/backend/engines/inverter/InverterCoreService.py" \
    "${APP_DIR}/backend/engines/forecast/ForecastCoreService.py"
ok "Linux entry points passed syntax validation."

log "[13/18] Installing systemd service definitions..."
install -m 644 "${APP_DIR}/deploy/linux/systemd/inverter.target" /etc/systemd/system/
install -m 644 "${APP_DIR}/deploy/linux/systemd/"*.service /etc/systemd/system/
systemctl daemon-reload
ok "systemd service definitions are registered."

log "[14/18] Initializing the application database in WAL mode..."
runuser -u "${APP_USER}" -- env \
    INVERTER_DATA_DIR="${INVERTER_DATA_DIR:-${DB_DIR}}" \
    INVERTER_STORAGE_DIR="${INVERTER_STORAGE_DIR:-${DATA_ROOT}}" \
    node -e "const db=require('${APP_DIR}/server/db'); db.db.close();"
ok "Application database initialized."

log "[15/18] Configuring the host firewall..."
if command -v ufw >/dev/null 2>&1; then
    ufw allow 22/tcp comment "SSH Remote Management" >/dev/null 2>&1 || true
    ufw allow 3500/tcp comment "ADSI Dashboard Gateway" >/dev/null 2>&1 || true
    ufw allow 1984/tcp comment "go2rtc Camera API" >/dev/null 2>&1 || true
    ufw allow 8555/tcp comment "go2rtc WebRTC TCP" >/dev/null 2>&1 || true
    ufw allow 8555/udp comment "go2rtc WebRTC UDP" >/dev/null 2>&1 || true
fi
ok "Required firewall rules are present."

log "[16/18] Applying optional 24/7 appliance power hardening..."
if [ "${INVERTER_HARDEN_SLEEP:-1}" = "1" ]; then
    if ! grep -q '^HandleLidSwitch=ignore$' /etc/systemd/logind.conf; then
        echo 'HandleLidSwitch=ignore' >> /etc/systemd/logind.conf
    fi
    if ! grep -q '^HandleLidSwitchExternalPower=ignore$' /etc/systemd/logind.conf; then
        echo 'HandleLidSwitchExternalPower=ignore' >> /etc/systemd/logind.conf
    fi
    systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target >/dev/null
    warn "Sleep targets are masked; logind settings take full effect after reboot."
else
    ok "Sleep hardening skipped by operator override."
fi

log "[17/18] Enabling and starting the dashboard services..."
systemctl enable inverter.target inverter-engine.service inverter-server.service \
    inverter-forecast.service inverter-go2rtc.service >/dev/null
systemctl start inverter.target
systemctl restart inverter-engine.service
systemctl restart inverter-server.service
systemctl restart inverter-forecast.service
systemctl restart inverter-go2rtc.service
ok "Service start requests completed."

log "[18/18] Verifying current service and HTTP health..."
if ! "${APP_DIR}/deploy/linux/scripts/inverter-health-check.sh" --wait 30; then
    systemctl status inverter-engine.service inverter-server.service \
        inverter-forecast.service inverter-go2rtc.service --no-pager --full || true
    error "Installation completed, but one or more services are not healthy."
fi

echo -e "\n${BOLD}${GREEN}================================================================${NC}"
echo -e "${BOLD}${GREEN}  SETUP COMPLETE - DASHBOARD SERVICES ARE REACHABLE${NC}"
echo -e "${BOLD}${GREEN}================================================================${NC}\n"
echo -e "  ${BOLD}Dashboard:${NC}          http://<server-ip>:3500"
echo -e "  ${BOLD}Application:${NC}        ${APP_DIR}"
echo -e "  ${BOLD}Runtime data:${NC}       ${DATA_ROOT}"
echo -e "  ${BOLD}Update command:${NC}     sudo ${APP_DIR}/deploy/linux/update.sh"
echo -e "  ${BOLD}Health command:${NC}     sudo ${APP_DIR}/deploy/linux/scripts/inverter-health-check.sh"
echo -e "\n  Service reachability passed. Live inverter polling still requires the plant network.\n"
