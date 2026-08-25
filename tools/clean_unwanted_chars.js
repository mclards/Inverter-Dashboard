// tools/clean_unwanted_chars.js
/**
 * Clean unwanted characters from source files.
 * Removes line-number prefixes (e.g., "44: "), trailing whitespace, and zero-width spaces.
 */
const fs = require('fs');
const path = require('path');

// Directories to exclude from processing
const EXCLUDE_DIRS = ['node_modules', 'dist', 'build', '.git', 'release', '.tmp', 'release_pre_*', 'release_prev_*', 'release_full_*'];
// File extensions to include (add more as needed)
const INCLUDED_EXTS = ['.js', '.ts', '.html', '.css', '.json', '.md', '.py', '.spec.js', '.jsx', '.tsx'];

function shouldProcess(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!INCLUDED_EXTS.includes(ext)) return false;
  // Exclude large binary-like files (>5 MB)
  try {
    const stats = fs.statSync(filePath);
    if (stats.size > 5 * 1024 * 1024) return false;
  } catch (_) { return false; }
  return true;
}

function cleanContent(content) {
  // 1. Strip leading line-number prefixes like "44: "
  const noLineNumbers = content.replace(/^\d+:\s+/gm, '');
  // 2. Remove zero‑width spaces and other invisible Unicode control chars
  const noZeroWidth = noLineNumbers.replace(/[\u200B\u200C\u200D\uFEFF]/g, '');
  // 3. Trim trailing whitespace on each line
  const trimmed = noZeroWidth.replace(/[ \t]+$/gm, '');
  // 4. Collapse multiple consecutive blank lines to a single blank line
  const collapsed = trimmed.replace(/\n{3,}/g, '\n\n');
  return collapsed;
}

function scanDirectory(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    // Skip directories we cannot read (e.g., permission issues)
    console.warn(`[SKIP] Cannot read directory ${dir}: ${err.message}`);
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.includes(entry.name)) continue;
      scanDirectory(fullPath);
    } else if (entry.isFile() && shouldProcess(fullPath)) {
      const original = fs.readFileSync(fullPath, 'utf8');
      const cleaned = cleanContent(original);
      if (original !== cleaned) {
        fs.writeFileSync(fullPath, cleaned, 'utf8');
        console.log(`[CLEANED] ${fullPath}`);
      }
    }
  }
}

// Run from repository root
scanDirectory(process.cwd());
