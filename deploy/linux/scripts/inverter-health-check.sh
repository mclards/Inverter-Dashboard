#!/usr/bin/env bash
# Current component health for the Linux production appliance.

set -u

WAIT_SECONDS=0
if [ "${1:-}" = "--wait" ]; then
    WAIT_SECONDS="${2:-30}"
fi

case "${WAIT_SECONDS}" in
    ''|*[!0-9]*) echo "Invalid wait duration: ${WAIT_SECONDS}" >&2; exit 2 ;;
esac

SERVICES=(
    inverter-engine.service
    inverter-server.service
    inverter-forecast.service
    inverter-go2rtc.service
    tailscaled.service
)

services_active() {
    local service
    for service in "${SERVICES[@]}"; do
        systemctl is-active --quiet "${service}" || return 1
    done
}

http_reachable() {
    curl -fsS --max-time 3 -o /dev/null http://127.0.0.1:3500/api/health \
        && curl -fsS --max-time 3 -o /dev/null http://127.0.0.1:9100/health \
        && curl -fsS --max-time 3 -o /dev/null http://127.0.0.1:1984/api
}

DEADLINE=$((SECONDS + WAIT_SECONDS))
while ! services_active || ! http_reachable; do
    [ "${SECONDS}" -ge "${DEADLINE}" ] && break
    sleep 1
done

FAILED=0
for service in "${SERVICES[@]}"; do
    state="$(systemctl is-active "${service}" 2>/dev/null || true)"
    printf '%-34s %s\n' "${service}" "${state:-unknown}"
    [ "${state}" = "active" ] || FAILED=1
done

if tailscale status --json 2>/dev/null \
    | grep -Eq '"BackendState"[[:space:]]*:[[:space:]]*"Running"'; then
    printf '%-34s %s\n' "Tailscale network" "connected ($(tailscale ip -4 2>/dev/null || echo unknown))"
else
    printf '%-34s %s\n' "Tailscale network" "not connected"
    FAILED=1
fi

for probe in \
    'gateway|http://127.0.0.1:3500/api/health' \
    'telemetry|http://127.0.0.1:9100/health' \
    'go2rtc|http://127.0.0.1:1984/api'; do
    name="${probe%%|*}"
    url="${probe#*|}"
    if curl -fsS --max-time 3 -o /dev/null "${url}"; then
        printf '%-34s %s\n' "${name} HTTP" "reachable"
    else
        printf '%-34s %s\n' "${name} HTTP" "unreachable"
        FAILED=1
    fi
done

if [ "${FAILED}" -ne 0 ]; then
    echo "Dashboard state: degraded" >&2
    exit 1
fi

echo "Dashboard state: services reachable (live inverter polling not asserted)"
