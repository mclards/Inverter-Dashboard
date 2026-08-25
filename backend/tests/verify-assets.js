"use strict";
const fs = require("fs");
const path = require("path");

const publicDir = path.join(__dirname, "..", "..", "frontend", "public");
const htmlFiles = fs.readdirSync(publicDir).filter(f => f.endsWith(".html"));
console.log("================================================================");
console.log(`  FRONTEND STATIC ASSET AUDIT — Scanning ${htmlFiles.length} HTML files`);
console.log("================================================================");

let totalMissing = 0;

for (const file of htmlFiles) {
  const html = fs.readFileSync(path.join(publicDir, file), "utf8");
  const srcMatches = [...html.matchAll(/src=["']([^"']+)["']/g)].map(m => m[1]);
  const hrefMatches = [...html.matchAll(/href=["']([^"']+)["']/g)].map(m => m[1]);
  const allAssets = [...new Set([...srcMatches, ...hrefMatches])];
  let missing = [];

  for (const asset of allAssets) {
    if (asset.startsWith("http://") || asset.startsWith("https://") || asset.startsWith("mailto:") || asset.startsWith("javascript:") || asset.startsWith("#") || asset.startsWith("about:") || asset.startsWith("data:")) {
      continue;
    }
    const cleanPath = asset.split("?")[0].replace(/^\//, "");
    const fullPath = path.join(publicDir, cleanPath);
    if (!fs.existsSync(fullPath)) {
      missing.push(asset);
    }
  }

  if (missing.length > 0) {
    console.error(`  ❌ ${file}: Missing assets ->`, missing);
    totalMissing += missing.length;
  } else {
    console.log(`  ✅ ${file}: All ${allAssets.length} asset references verified OK`);
  }
}

if (totalMissing > 0) {
  process.exit(1);
} else {
  console.log("\n  ✅ ALL HTML PAGES IN PUBLIC/ HAVE 100% COMPLETE ASSETS ON DISK!\n");
}
