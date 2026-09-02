#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const [seedPath, targetPath] = process.argv.slice(2);
if (!seedPath || !targetPath) {
  console.error("Usage: inverter-ipconfig-seed.js <seed.json> <target.json>");
  process.exit(2);
}

const keys = Array.from({ length: 27 }, (_, index) => String(index + 1));
const maps = ["inverters", "poll_interval", "units", "losses"];

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

function isIpv4(value) {
  if (typeof value !== "string") return false;
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function validate(config, label) {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error(`${label} is not an object`);
  for (const name of maps) {
    if (!config[name] || typeof config[name] !== "object" || Array.isArray(config[name])) {
      throw new Error(`${label}.${name} is missing or invalid`);
    }
    const actualKeys = Object.keys(config[name]).sort((a, b) => Number(a) - Number(b));
    if (JSON.stringify(actualKeys) !== JSON.stringify(keys)) throw new Error(`${label}.${name} must contain exactly inverter keys 1-27`);
  }
  for (const key of keys) {
    if (!isIpv4(config.inverters[key])) throw new Error(`${label}.inverters.${key} is not valid IPv4`);
    if (!(Number(config.poll_interval[key]) > 0)) throw new Error(`${label}.poll_interval.${key} must be positive`);
    if (!Array.isArray(config.units[key]) || config.units[key].some((unit) => ![1, 2, 3, 4].includes(unit))) {
      throw new Error(`${label}.units.${key} is invalid`);
    }
    if (!Number.isFinite(Number(config.losses[key]))) throw new Error(`${label}.losses.${key} is invalid`);
  }
}

function isSyntheticFreshInstall(config) {
  if (!config || typeof config !== "object") return false;
  return keys.every((key) =>
    config.inverters?.[key] === `192.168.1.${100 + Number(key)}` &&
    Number(config.poll_interval?.[key]) === 0.05 &&
    JSON.stringify(config.units?.[key]) === "[1,2,3,4]" &&
    Number(config.losses?.[key] ?? 2.5) === 2.5
  );
}

function atomicWrite(file, config) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o640 });
  fs.renameSync(temporary, file);
}

const seed = loadJson(seedPath);
validate(seed, "seed");

if (!fs.existsSync(targetPath)) {
  atomicWrite(targetPath, seed);
  console.log(`Seeded ${targetPath} with the canonical 27-inverter topology.`);
  process.exit(0);
}

let existing;
try {
  existing = loadJson(targetPath);
} catch (error) {
  throw new Error(`Existing topology is unreadable; left untouched: ${error.message}`);
}

if (!isSyntheticFreshInstall(existing)) {
  validate(existing, "existing topology");
  console.log(`Preserved operator topology at ${targetPath}.`);
  process.exit(0);
}

const backupPath = `${targetPath}.pre-canonical-seed`;
if (!fs.existsSync(backupPath)) fs.copyFileSync(targetPath, backupPath, fs.constants.COPYFILE_EXCL);
atomicWrite(targetPath, seed);
console.log(`Replaced the untouched synthetic topology; backup: ${backupPath}`);
