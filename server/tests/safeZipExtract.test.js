"use strict";

const assert = require("assert");
const path = require("path");
const { validateEntry } = require("../safeZipExtract");

function validate(entry) {
  return validateEntry(entry, path.resolve("C:/safe-zip-root"), { entries: 0, bytes: 0 });
}

assert.throws(
  () => validate({ fileName: "../outside.txt", uncompressedSize: 1, externalFileAttributes: 0 }),
  /escapes its extraction root/,
);
assert.throws(
  () => validate({ fileName: "/absolute.txt", uncompressedSize: 1, externalFileAttributes: 0 }),
  /absolute/,
);
assert.throws(
  () => validate({
    fileName: "linked-file",
    uncompressedSize: 8,
    externalFileAttributes: (0xa1ff << 16) >>> 0,
  }),
  /symbolic links are not allowed/,
);
assert.throws(
  () => validate({ fileName: "huge.bin", uncompressedSize: 65 * 1024 ** 3, externalFileAttributes: 0 }),
  /exceeds the extraction limit/,
);

const accepted = validate({ fileName: "db/adsi.db", uncompressedSize: 1024, externalFileAttributes: 0 });
assert.equal(accepted.isDirectory, false);
assert.equal(accepted.destination.endsWith(path.join("db", "adsi.db")), true);

console.log("safeZipExtract.test.js: PASS");
