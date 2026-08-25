#!/usr/bin/env node
/**
 * Generate or non-mutatingly verify the canonical ADSI user-guide PDF.
 *
 * Normal mode renders a validated complete HTML source and writes the PDF plus
 * a provenance sidecar. ``--check`` never launches Chromium or changes files;
 * it verifies source/PDF hashes, structure, page count, and sidecar schema.
 */
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { cleanupInstalledBackup, cleanupInstalledPdfBackup } = require("./release-build-guards");

const PROVENANCE_SCHEMA_VERSION = 1;
const GENERATOR_ID = "scripts/_gen_userguide_pdf.js";
const repoRoot = path.resolve(__dirname, "..");
const canonicalHtml = path.join(repoRoot, "docs", "ADSI-Dashboard-User-Guide.html");
const canonicalPdf = path.join(repoRoot, "docs", "ADSI-Dashboard-User-Guide.pdf");
const html = path.resolve(process.env.ADSI_USERGUIDE_HTML || canonicalHtml);
const pdf = path.resolve(process.env.ADSI_USERGUIDE_PDF || canonicalPdf);
const provenance = path.resolve(
  process.env.ADSI_USERGUIDE_PROVENANCE || pdf + ".provenance.json"
);
const checkOnly = process.argv.slice(2).includes("--check");
const minimumCompleteSourceBytes = 40000;
const minimumCompleteHeadings = 12;
const minimumGeneratedPdfBytes = 50000;
const minimumGeneratedPdfPages = 10;

function fail(message) {
  console.error("[user-guide-pdf] ERROR: " + message);
  console.error("[user-guide-pdf] Existing PDF and provenance were not changed.");
  process.exit(2);
}

function sha256File(filePath) {
  const digest = crypto.createHash("sha256");
  digest.update(fs.readFileSync(filePath));
  return digest.digest("hex");
}

function relativeRepoPath(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function validatePdf(filePath) {
  if (!fs.existsSync(filePath)) throw new Error("PDF does not exist: " + filePath);
  const bytes = fs.readFileSync(filePath);
  if (bytes.length < minimumGeneratedPdfBytes) {
    throw new Error("PDF is implausibly small (" + bytes.length + " bytes)");
  }
  const text = bytes.toString("latin1");
  if (!text.startsWith("%PDF-") || !/%%EOF\s*$/.test(text)) {
    throw new Error("PDF header or EOF structure is invalid");
  }
  const pageCount = (text.match(/\/Type\s*\/Page\b/g) || []).length;
  if (pageCount < minimumGeneratedPdfPages) {
    throw new Error(
      "PDF page count is below the complete-guide floor (" + pageCount +
      " < " + minimumGeneratedPdfPages + ")"
    );
  }
  return { byteLength: bytes.length, pageCount };
}

if (!fs.existsSync(html)) fail("HTML source does not exist: " + html);
const source = fs.readFileSync(html, "utf8");
const completeMarker = /<meta\s+name=["']adsi-guide-source["']\s+content=["']complete["']\s*\/?\s*>/i;
const headingCount = (source.match(/<h[12]\b/gi) || []).length;
if (!completeMarker.test(source)) {
  fail(
    "selected HTML is not declared as a complete guide; restore the complete source and " +
    "its adsi-guide-source=complete marker first"
  );
}
if (Buffer.byteLength(source, "utf8") < minimumCompleteSourceBytes || headingCount < minimumCompleteHeadings) {
  fail(
    "complete-source validation failed (bytes=" + Buffer.byteLength(source, "utf8") +
    ", h1/h2=" + headingCount + ")"
  );
}

if (checkOnly) {
  try {
    const recorded = JSON.parse(fs.readFileSync(provenance, "utf8"));
    const pdfInfo = validatePdf(pdf);
    const expected = {
      schema_version: PROVENANCE_SCHEMA_VERSION,
      generator: GENERATOR_ID,
      source_path: relativeRepoPath(html),
      source_sha256: sha256File(html),
      source_bytes: Buffer.byteLength(source, "utf8"),
      source_heading_count: headingCount,
      pdf_path: relativeRepoPath(pdf),
      pdf_sha256: sha256File(pdf),
      pdf_bytes: pdfInfo.byteLength,
      pdf_page_count: pdfInfo.pageCount,
    };
    for (const [field, value] of Object.entries(expected)) {
      if (recorded[field] !== value) {
        throw new Error(
          "provenance mismatch for " + field +
          " (recorded=" + JSON.stringify(recorded[field]) +
          ", actual=" + JSON.stringify(value) + ")"
        );
      }
    }
    console.log(
      "[user-guide-pdf] Provenance OK: source=" + expected.source_sha256 +
      " pdf=" + expected.pdf_sha256 + " pages=" + expected.pdf_page_count
    );
    process.exit(0);
  } catch (error) {
    fail("non-mutating provenance check failed: " + error.message);
  }
}

let puppeteer;
try {
  puppeteer = require("puppeteer");
} catch (error) {
  fail("Puppeteer is required for generation: " + error.message);
}

const tempPdf = pdf + ".tmp-" + process.pid + ".pdf";
const tempProvenance = provenance + ".tmp-" + process.pid;
const backupPdf = pdf + ".backup-" + process.pid;
const backupProvenance = provenance + ".backup-" + process.pid;
let browser;
let originalPdfMoved = false;
let originalProvenanceMoved = false;
let installedNewPdf = false;
let installedNewProvenance = false;

(async () => {
  const url = "file:///" + html.split(path.sep).join("/");
  browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-gpu"],
  });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "networkidle0" });
  await page.pdf({
    path: tempPdf,
    printBackground: true,
    format: "A4",
    margin: { top: "12mm", bottom: "12mm", left: "10mm", right: "10mm" },
  });

  const pdfInfo = validatePdf(tempPdf);
  const sidecar = {
    schema_version: PROVENANCE_SCHEMA_VERSION,
    generator: GENERATOR_ID,
    source_path: relativeRepoPath(html),
    source_sha256: sha256File(html),
    source_bytes: Buffer.byteLength(source, "utf8"),
    source_heading_count: headingCount,
    pdf_path: relativeRepoPath(pdf),
    pdf_sha256: sha256File(tempPdf),
    pdf_bytes: pdfInfo.byteLength,
    pdf_page_count: pdfInfo.pageCount,
  };
  fs.writeFileSync(tempProvenance, JSON.stringify(sidecar, null, 2) + "\n", "utf8");

  if (fs.existsSync(pdf)) {
    fs.renameSync(pdf, backupPdf);
    originalPdfMoved = true;
  }
  if (fs.existsSync(provenance)) {
    fs.renameSync(provenance, backupProvenance);
    originalProvenanceMoved = true;
  }
  try {
    fs.renameSync(tempPdf, pdf);
    installedNewPdf = true;
    fs.renameSync(tempProvenance, provenance);
    installedNewProvenance = true;
  } catch (error) {
    if (installedNewProvenance && fs.existsSync(provenance)) fs.rmSync(provenance, { force: true });
    if (installedNewPdf && fs.existsSync(pdf)) fs.rmSync(pdf, { force: true });
    if (originalProvenanceMoved && fs.existsSync(backupProvenance)) {
      fs.renameSync(backupProvenance, provenance);
      originalProvenanceMoved = false;
    }
    if (originalPdfMoved && fs.existsSync(backupPdf)) {
      fs.renameSync(backupPdf, pdf);
      originalPdfMoved = false;
    }
    throw error;
  }

  cleanupInstalledPdfBackup(backupPdf, fs, console);
  cleanupInstalledBackup(backupProvenance, "provenance sidecar", fs, console);
  console.log(
    "[user-guide-pdf] PDF and provenance regenerated from validated complete source -> " + pdf
  );
})()
  .catch((error) => {
    console.error("[user-guide-pdf] ERROR: " + (error && error.message ? error.message : error));
    if (installedNewPdf && fs.existsSync(pdf)) {
      console.error("[user-guide-pdf] New PDF may remain installed; inspect retained backups before retrying.");
    } else if (fs.existsSync(pdf)) {
      console.error("[user-guide-pdf] Existing PDF was preserved or restored: " + pdf);
    } else {
      console.error("[user-guide-pdf] PDF recovery is incomplete; inspect backup: " + backupPdf);
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    if (browser) await browser.close().catch(() => {});
    for (const temporary of [tempPdf, tempProvenance]) {
      if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
    }
    if (originalProvenanceMoved && fs.existsSync(backupProvenance) && !fs.existsSync(provenance)) {
      try {
        fs.renameSync(backupProvenance, provenance);
      } catch (error) {
        console.error("[user-guide-pdf] ERROR: final provenance restore failed: " + error.message);
        process.exitCode = 1;
      }
    }
    if (originalPdfMoved && fs.existsSync(backupPdf) && !fs.existsSync(pdf)) {
      try {
        fs.renameSync(backupPdf, pdf);
      } catch (error) {
        console.error("[user-guide-pdf] ERROR: final PDF restore failed: " + error.message);
        process.exitCode = 1;
      }
    }
  });
