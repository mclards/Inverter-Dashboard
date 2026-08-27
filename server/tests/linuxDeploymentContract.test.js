"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "../..");

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

const linuxFiles = [
  "deploy/linux/install.sh",
  "deploy/linux/setup.sh",
  "deploy/linux/update.sh",
  "deploy/linux/scripts/inverter-db-check.sh",
  "deploy/linux/scripts/inverter-health-check.sh",
  "deploy/linux/scripts/tailscale-setup.sh",
  "deploy/linux/default/inverter-dashboard",
  "deploy/linux/default/go2rtc.yaml",
  "deploy/linux/systemd/inverter.target",
  "deploy/linux/systemd/inverter-engine.service",
  "deploy/linux/systemd/inverter-server.service",
  "deploy/linux/systemd/inverter-forecast.service",
  "deploy/linux/systemd/inverter-go2rtc.service",
];

for (const rel of linuxFiles) {
  const raw = fs.readFileSync(path.join(ROOT, rel));
  assert.notDeepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf], `${rel} must not contain a UTF-8 BOM`);
  assert.equal(raw.includes(Buffer.from("\r\n")), false, `${rel} must use LF line endings`);
}

for (const rel of [
  "deploy/linux/install.sh",
  "deploy/linux/setup.sh",
  "deploy/linux/update.sh",
  "deploy/linux/scripts/inverter-db-check.sh",
  "deploy/linux/scripts/inverter-health-check.sh",
  "deploy/linux/scripts/tailscale-setup.sh",
]) {
  assert.match(read(rel), /^#!\/usr\/bin\/env bash\n/, `${rel} must have an executable Linux shebang`);
}

const attrs = read(".gitattributes");
assert.match(attrs, /\*\.sh text eol=lf/);
assert.match(attrs, /deploy\/linux\/\*\* text eol=lf/);

const environment = read("deploy/linux/default/inverter-dashboard");
assert.match(environment, /^ADSI_SERVER_PORT=3500$/m);
assert.match(environment, /^INVERTER_DATA_DIR=\/var\/lib\/inverter-dashboard\/db$/m);
assert.match(environment, /^INVERTER_STORAGE_DIR=\/var\/lib\/inverter-dashboard$/m);
assert.match(environment, /^ADSI_LOGIN_CREDENTIAL_PATH=\/var\/lib\/inverter-dashboard\/auth\/credentials\.json$/m);
assert.doesNotMatch(environment, /^INVERTER_PORTABLE_DATA_DIR=/m);

const setup = read("deploy/linux/setup.sh");
assert.match(setup, /REPO_ROOT.*!=.*APP_DIR/);
assert.match(setup, /GO2RTC_VERSION="1\.9\.14"/);
assert.match(setup, /sha256sum --check --status/);
assert.match(setup, /inverter-health-check\.sh" --wait 30/);
assert.match(setup, /error "Installation completed, but one or more services are not healthy\."/);
assert.match(setup, /cp -a "\$\{ENV_FILE\}" "\$\{ENV_FILE\}\.pre-db-layout"/);
assert.match(setup, /sed -i[\s\S]*INVERTER_PORTABLE_DATA_DIR/);

const bootstrap = read("deploy/linux/install.sh");
assert.match(bootstrap, /apt-get install -y -qq ca-certificates git/);
assert.match(bootstrap, /git clone --depth 1 --branch main/);
assert.match(bootstrap, /status --porcelain/);
assert.match(bootstrap, /merge --ff-only origin\/main/);
assert.match(bootstrap, /exec "\$\{APP_DIR\}\/deploy\/linux\/setup\.sh"/);

const tailscaleSetup = read("deploy/linux/scripts/tailscale-setup.sh");
assert.match(tailscaleSetup, /command -v tailscale/);
assert.match(tailscaleSetup, /https:\/\/tailscale\.com\/install\.sh/);
assert.match(tailscaleSetup, /systemctl enable --now tailscaled\.service/);
assert.match(tailscaleSetup, /TAILSCALE_AUTH_KEY/);
assert.match(tailscaleSetup, /tailscale up[\s\S]*--ssh/);
assert.match(tailscaleSetup, /Active Tailscale SSH session detected/);

const healthCheck = read("deploy/linux/scripts/inverter-health-check.sh");
assert.match(healthCheck, /tailscaled\.service/);
assert.match(healthCheck, /"BackendState"/);

const dbCheck = read("deploy/linux/scripts/inverter-db-check.sh");
assert.match(dbCheck, /DB_PATH="\$\{DB_DIR\}\/adsi\.db"/);
assert.match(dbCheck, /PRAGMA quick_check/);
assert.match(dbCheck, /Original left untouched/);

const serverUnit = read("deploy/linux/systemd/inverter-server.service");
assert.match(serverUnit, /ExecStartPre=\/usr\/bin\/bash .*inverter-db-check\.sh/);
assert.match(serverUnit, /ExecStart=\/usr\/bin\/node \/opt\/inverter-dashboard\/server\/index\.js/);
assert.doesNotMatch(serverUnit, /backend\/server\.js/);

const go2rtcUnit = read("deploy/linux/systemd/inverter-go2rtc.service");
assert.match(go2rtcUnit, /ExecStart=\/usr\/local\/bin\/go2rtc /);
assert.match(go2rtcUnit, /go2rtc\.yaml/);

const go2rtcManager = read("server/go2rtcManager.js");
assert.match(go2rtcManager, /INVERTER_STORAGE_DIR/);
assert.match(go2rtcManager, /managedExternally/);

const target = read("deploy/linux/systemd/inverter.target");
for (const service of ["inverter-engine.service", "inverter-server.service", "inverter-forecast.service", "inverter-go2rtc.service"]) {
  assert.match(target, new RegExp(service.replace(".", "\\.")), `${service} must be pulled in by inverter.target`);
}

const defaultGo2rtc = read("deploy/linux/default/go2rtc.yaml");
assert.doesNotMatch(defaultGo2rtc, /rtsp:\/\//i, "default camera config must not ship credentials or RTSP endpoints");

console.log("linuxDeploymentContract.test.js: PASS");
