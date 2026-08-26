"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..", "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const browserAuth = read("server/browserAuth.js");
const server = read("server/index.js");
const publicApp = read("public/js/app.js");
const frontendApp = read("frontend/public/js/app.js");
const publicCss = read("public/css/style.css");
const frontendCss = read("frontend/public/css/style.css");

const publicHtml = read("public/index.html");
const frontendHtml = read("frontend/public/index.html");
const publicLogin = read("public/login.html");
const frontendLogin = read("frontend/public/login.html");

assert.match(browserAuth, /role: normalizeSessionRole\(role\)/, "browser sessions must sign a role claim");
assert.match(browserAuth, /role: normalizeSessionRole\(session\.payload\?\.role\)/, "session endpoint must return signed role");
assert.match(server, /const DEVELOPER_BROWSER_PAGES = new Set\(/, "stand-alone admin pages must be role-gated");
assert.match(server, /function developerRoleGate\(/, "developer API guard must be installed");
assert.match(server, /OPERATOR_SHARED_SETTINGS_KEYS/, "operator settings must be allow-listed");

for (const app of [publicApp, frontendApp]) {
  assert.match(app, /fetch\("\/api\/auth\/session"/, "browser UI must verify the server session");
  assert.match(app, /return VerifiedRole\.verified && VerifiedRole\.role === "developer";/);
  assert.doesNotMatch(app, /name === "devclard"/, "mutable localStorage name must not grant developer UI");
  assert.match(app, /OPERATOR_SHARED_SETTING_KEYS_CLIENT\.has\(key\)/);
  assert.match(app, /function normalizeSettingsSectionId\(/);
  assert.match(app, /if \(!isDevClardUser\(\)\)/);
  assert.match(app, /fetch\("\/api\/auth\/logout"/);
}
for (const css of [publicCss, frontendCss]) {
  assert.match(css, /html:not\(\.role-developer\) \[data-role-min="devClard"\]/);
}
for (const html of [publicHtml, frontendHtml]) {
  assert.match(html, /id="cloudBackupSection"\s+data-role-min="devClard"/);
  assert.match(html, /id="localBackupSection"\s+data-role-min="devClard"/);
  assert.match(html, /js\/app\.js\?v=\d+\.\d+\.\d+/);
}
for (const login of [publicLogin, frontendLogin]) {
  assert.match(login, /localStorage\.removeItem\("adsi_settings_section"\)/);
}

console.log("webRoleRestrictionWiring.test.js: passed");
