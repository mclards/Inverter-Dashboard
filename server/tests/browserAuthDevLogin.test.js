"use strict";

const assert = require("assert");
const express = require("express");
const { createBrowserAuth } = require("../browserAuth");

async function main() {
  const app = express();
  app.use(express.json());
  const auth = createBrowserAuth({
    credentialPath: "C:\\nonexistent\\operator-credentials.json",
  });
  app.use(auth.originGuard);
  auth.registerRoutes(app);

  const server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const port = server.address().port;
  const devPassword = `dev${String(new Date().getMinutes()).padStart(2, "0")}`;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "devclard", password: devPassword }),
    });
    const payload = await response.json();
    assert.strictEqual(response.status, 200, JSON.stringify(payload));
    assert.strictEqual(payload.ok, true);
    assert.strictEqual(payload.username, "devClard");
    assert.strictEqual(payload.role, "developer");
    assert.match(String(response.headers.get("set-cookie") || ""), /HttpOnly/);
    console.log("browserAuthDevLogin.test.js: passed");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
