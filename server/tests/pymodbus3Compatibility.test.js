"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "../..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

assert.match(read("requirements.txt"), /^pymodbus==3\.6\.8$/m);

for (const file of [
  "backend/drivers/modbus_tcp.py",
  "backend/drivers/modbus_rtu.py",
  "backend/engines/inverter/drivers/modbus_tcp.py",
  "backend/engines/inverter/drivers/modbus_rtu.py",
]) {
  const source = read(file);
  assert.match(source, /from pymodbus\.client import Modbus(?:Tcp|Serial)Client/);
  assert.doesNotMatch(source, /pymodbus\.client\.sync/);
  assert.doesNotMatch(source, /(?:read_(?:input|holding)_registers|write_registers?)\([^)]*\bunit\s*=/s);
}

const engine = read("backend/engines/inverter/inverter_engine.py");
assert.match(engine, /if create_client is None:[\s\S]*refusing to start an unready telemetry service/);
assert.doesNotMatch(engine, /(?:read_(?:input|holding)_registers|write_registers?)\([^)]*\bunit\s*=/s);

for (const file of [
  "backend/engines/inverter/calibration_core.py",
  "backend/engines/inverter/calibration_io.py",
  "backend/engines/inverter/serial_io.py",
]) {
  assert.doesNotMatch(read(file), /(?:read_(?:input|holding)_registers|write_registers?)\([^)]*\bunit\s*=/s);
}

console.log("pymodbus3Compatibility.test.js: PASS");
