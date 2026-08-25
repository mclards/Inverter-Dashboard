"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ENV_HELPER_PATH = path.resolve(__dirname, "..", "runtimeEnvPaths.js");

function mkTempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `adsi-${label}-`));
}

function runScenario(name, envPatch, expectedDir) {
  const script = `
    const assert = require("assert");
    const path = require("path");
    const envPaths = require(${JSON.stringify(ENV_HELPER_PATH)});
    try {
      const explicit = envPaths.getExplicitDataDir(process.env);
      const portable = envPaths.getPortableDataRoot(process.env);
      const resolved = explicit || (portable ? path.join(portable, "db") : "");
      assert.strictEqual(path.resolve(resolved), path.resolve(${JSON.stringify(expectedDir)}));
      process.exit(0);
    } catch (err) {
      console.error(err && err.stack ? err.stack : String(err));
      process.exit(1);
    }
  `;

  const result = spawnSync(process.execPath, ["-e", script], {
    env: {
      ...process.env,
      IM_DATA_DIR: "",
      ADSI_DATA_DIR: "",
      IM_PORTABLE_DATA_DIR: "",
      ADSI_PORTABLE_DATA_DIR: "",
      ...envPatch,
    },
    encoding: "utf8",
  });

  if (result.status !== 0) {
    const stderr = String(result.stderr || "").trim();
    const stdout = String(result.stdout || "").trim();
    throw new Error(`${name} failed\nstdout: ${stdout}\nstderr: ${stderr}`);
  }
  console.log(`[PASS] ${name}`);
}

function main() {
  const tempDirs = [];
  try {
    const adsiExplicit = mkTempDir("adsi-explicit");
    tempDirs.push(adsiExplicit);
    runScenario(
      "ADSI_DATA_DIR fallback",
      { ADSI_DATA_DIR: adsiExplicit },
      adsiExplicit,
    );

    const adsiPortable = mkTempDir("adsi-portable");
    tempDirs.push(adsiPortable);
    runScenario(
      "ADSI_PORTABLE_DATA_DIR fallback",
      { ADSI_PORTABLE_DATA_DIR: adsiPortable },
      path.join(adsiPortable, "db"),
    );

    const imExplicit = mkTempDir("im-explicit");
    const adsiIgnored = mkTempDir("adsi-ignored");
    tempDirs.push(imExplicit, adsiIgnored);
    runScenario(
      "IM_DATA_DIR precedence",
      {
        IM_DATA_DIR: imExplicit,
        ADSI_DATA_DIR: adsiIgnored,
      },
      imExplicit,
    );

    console.log("dbPathEnvCompat: all checks passed");
  } finally {
    for (const dir of tempDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (_) {}
    }
  }
}

main();
