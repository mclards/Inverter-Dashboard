"use strict";

function readEnvPair(env, legacyKey, modernKey) {
  return String(env?.[legacyKey] || env?.[modernKey] || "").trim();
}

function getExplicitDataDir(env = process.env) {
  return readEnvPair(env, "IM_DATA_DIR", "ADSI_DATA_DIR");
}

function getPortableDataRoot(env = process.env) {
  return readEnvPair(env, "IM_PORTABLE_DATA_DIR", "ADSI_PORTABLE_DATA_DIR");
}

module.exports = {
  getExplicitDataDir,
  getPortableDataRoot,
};
