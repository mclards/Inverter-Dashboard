"use strict";

/**
 * reportGenerator.js — assemble PDF + CSV evidence bundle for a compliance run.
 *
 * Plan: plans/2026-05-10-modbus-registers-official-revamp.md §4 Slice θ.6
 *
 * PDF rendering uses puppeteer (already a project dep). The HTML template
 * below is intentionally minimal — printable, monospace-friendly, no runtime
 * JS dependencies. We feed it as a data URL and capture A4.
 *
 * CSV is plain UTF-8 BOM, RFC-4180 quoting via escapeCsvCell.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function escapeCsvCell(v) {
  let s = v == null ? "" : String(v);
  return (s.includes(",") || s.includes('"') || s.includes("\n"))
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

function _sha256OfFile(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// Column schemas for the multi-table CSV bundle. Centralised so the meta /
// steps / samples sections stay aligned with their headers and so the test
// suite can assert column counts without re-parsing the join code.
//
// v2.11.x — slimmed for witness readability:
//   • Dropped pwr_red_bits from samples — useful for engineer debugging,
//     not for compliance evidence; full record is still in compliance_run_sample.
//   • Renamed *_iso columns to time/start/end so spreadsheets show short
//     headings.
const META_COLUMNS = ["section", "key", "value"];
const STEP_COLUMNS = [
  "section", "step_idx", "step_name", "start", "end",
  "target", "achieved", "deviation_pct", "pass", "notes",
];
const SAMPLE_COLUMNS = [
  "section", "time", "inverter_ip", "slave", "pac_w", "qac_var",
  "vac_avg_v", "iac_avg_a", "freq_hz", "cosphi", "temp_c", "state_raw",
  "alarm_32",
];

function _csvRow(cells) {
  return cells.map(escapeCsvCell).join(",");
}

/**
 * generateCsvBundle(run, steps, samples, outDir) → { path, bytes, sha256 }
 *
 * v2.11.x — Each section now emits one column per field instead of nesting
 * the row contents inside a single comma-blob cell. Earlier shape produced
 * a 3-column file where every actual step/sample value was jammed into the
 * third column — Excel would open it but operators couldn't filter or sort
 * by step_name / pac_w / etc. NGCP audit reviewers rejected the shape.
 *
 * Section rows are padded to the widest section's column count so the file
 * is rectangular (Excel treats it as a single sheet with empty trailing
 * cells in the meta/steps blocks). Section is identified by the first cell.
 */
function generateCsvBundle(run, steps, samples, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const fileName = `compliance-${run.test_kind}-${run.run_id}.csv`;
  const filePath = path.join(outDir, fileName);

  const widest = Math.max(META_COLUMNS.length, STEP_COLUMNS.length, SAMPLE_COLUMNS.length);
  const pad = (cells) => {
    const out = cells.slice();
    while (out.length < widest) out.push("");
    return out;
  };

  const lines = [];
  // BOM + the widest header (samples) so Excel column count matches the
  // widest section. Narrower sections pad with empty trailing cells.
  lines.push("\uFEFF" + _csvRow(SAMPLE_COLUMNS));

  // Meta block (3 columns padded to widest). Only the witness-relevant
  // fields. The full summary blob lives in the PDF / compliance_run table —
  // dumping the JSON here cluttered the CSV with one giant comma-quoted
  // cell that operators kept reporting as "broken column".
  const meta = (key, value) => lines.push(_csvRow(pad(["meta", key, value == null ? "" : String(value)])));
  meta("run_id",    run.run_id);
  meta("test_kind", run.test_kind);
  meta("started",   new Date(run.started_at_ms).toISOString());
  meta("ended",     run.ended_at_ms ? new Date(run.ended_at_ms).toISOString() : "");
  meta("status",    run.status);
  meta("operator",  run.operator_actor);
  if (run.error_message) meta("error", run.error_message);
  // Promote a few high-signal summary fields to their own meta rows so
  // operators can see pass/fail counts without opening the JSON.
  if (run.summary_json) {
    try {
      const s = JSON.parse(run.summary_json);
      if (s && typeof s === "object") {
        ["passes", "fails", "samples", "mean_hz", "min_hz", "max_hz",
          "alarm_events", "longest_excursion_ms"].forEach((k) => {
          if (s[k] != null) meta(`summary.${k}`, s[k]);
        });
      }
    } catch (_) { /* swallow — JSON dump dropped, no fallback needed */ }
  }

  // Steps block — one column per step field, padded to widest.
  lines.push("");
  lines.push(_csvRow(pad(STEP_COLUMNS)));
  for (const s of steps) {
    lines.push(_csvRow(pad([
      "step",
      s.step_idx ?? "",
      s.step_name ?? "",
      s.started_at_ms ? new Date(s.started_at_ms).toISOString() : "",
      s.ended_at_ms ? new Date(s.ended_at_ms).toISOString() : "",
      s.target_value ?? "",
      s.achieved_value ?? "",
      s.deviation_pct ?? "",
      s.pass == null ? "" : (s.pass ? "PASS" : "FAIL"),
      s.notes ?? "",
    ])));
  }

  // Samples block — already at widest, no padding needed but use pad() for
  // symmetry so a future SAMPLE_COLUMNS shrink doesn't silently misalign.
  lines.push("");
  lines.push(_csvRow(pad(SAMPLE_COLUMNS)));
  for (const s of samples) {
    lines.push(_csvRow(pad([
      "sample",
      s.ts_ms ? new Date(s.ts_ms).toISOString() : "",
      s.inverter_ip || "",
      s.slave ?? "",
      s.pac_w ?? "",
      s.qac_var ?? "",
      s.vac_avg_v ?? "",
      s.iac_avg_a ?? "",
      s.freq_hz ?? "",
      s.cosphi ?? "",
      s.temp_c ?? "",
      s.state_raw ?? "",
      s.alarm_32 ?? "",
    ])));
  }

  fs.writeFileSync(filePath, lines.join("\n"), "utf8");
  const stat = fs.statSync(filePath);
  return {
    path: filePath,
    bytes: stat.size,
    sha256: _sha256OfFile(filePath),
  };
}

/**
 * Build a self-contained inline SVG chart for T3 Q-V capability runs.
 * Renders the qv_series points (V, Q) per step on a simple grid with the
 * NGCP capability envelope (PF 0.95 lag/lead boundaries) shown as guide
 * lines. Returns "" when the run is not a T3 or has no data.
 *
 * Slice θ.4 acceptance criterion θ-3: the chart must overlay measured
 * points on the registered capability curve and flag deviations > 5 %.
 */
function _buildQvChartSection(run, summary) {
  if (!run || run.test_kind !== "t3_qv_sweep") return "";
  const series = Array.isArray(summary?.qv_series) ? summary.qv_series : [];
  if (series.length === 0) return '<h2>Q-V Capability Chart</h2><p>No Q-V series captured.</p>';

  const W = 720, H = 360, P = 50;
  const innerW = W - 2 * P, innerH = H - 2 * P;
  const vs = series.map(p => Number(p.v) || 0).filter(v => v > 0);
  const qs = series.map(p => Number(p.q_var) || 0);
  if (vs.length === 0) return '<h2>Q-V Capability Chart</h2><p>No usable V/Q samples.</p>';
  const vMin = Math.min(...vs), vMax = Math.max(...vs);
  const vSpan = Math.max(1, vMax - vMin);
  const qAbs = Math.max(1, ...qs.map(Math.abs));
  const qMin = -qAbs, qMax = qAbs;
  const qSpan = qMax - qMin;
  const xOf = (v) => P + ((v - vMin) / vSpan) * innerW;
  const yOf = (q) => P + (1 - (q - qMin) / qSpan) * innerH;

  const points = series.map(p => `${xOf(p.v).toFixed(1)},${yOf(p.q_var).toFixed(1)}`).join(" ");
  const dots = series.map((p) => {
    const cx = xOf(p.v), cy = yOf(p.q_var);
    const fill = p.observed_pf == null ? "#999"
      : Math.abs(p.observed_pf - p.target_pf) <= 0.05 ? "#057a30"
      : "#b3261e";
    return `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="4" fill="${fill}" stroke="#fff" stroke-width="0.5"/>`;
  }).join("");

  // PF 0.95 boundary lines (capability envelope): for any V the device should
  // sit between these. We can't draw the true elliptical envelope without
  // knowing P at each step, so we just label the boundaries visually.
  const yZero = yOf(0).toFixed(1);

  return `<h2>Q-V Capability Chart (T3)</h2>
<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" xmlns="http://www.w3.org/2000/svg" font-family="ui-sans-serif, system-ui, sans-serif" font-size="10">
  <!-- frame -->
  <rect x="${P}" y="${P}" width="${innerW}" height="${innerH}" fill="none" stroke="#333" stroke-width="1"/>
  <!-- zero-Q axis -->
  <line x1="${P}" y1="${yZero}" x2="${W - P}" y2="${yZero}" stroke="#bbb" stroke-dasharray="4,4"/>
  <!-- axis labels -->
  <text x="${W / 2}" y="${H - 12}" text-anchor="middle" fill="#333">Vac (V) — measured per-step grid voltage average</text>
  <text x="14" y="${H / 2}" text-anchor="middle" fill="#333" transform="rotate(-90 14 ${H / 2})">Reactive Q (var) — positive = lag (inject), negative = lead (absorb)</text>
  <!-- v range labels -->
  <text x="${P}" y="${H - P + 16}" text-anchor="start" fill="#333">${vMin.toFixed(1)} V</text>
  <text x="${W - P}" y="${H - P + 16}" text-anchor="end" fill="#333">${vMax.toFixed(1)} V</text>
  <!-- q range labels -->
  <text x="${P - 8}" y="${P + 4}" text-anchor="end" fill="#333">${qMax.toFixed(0)}</text>
  <text x="${P - 8}" y="${H - P + 4}" text-anchor="end" fill="#333">${qMin.toFixed(0)}</text>
  <text x="${P - 8}" y="${parseFloat(yZero) + 4}" text-anchor="end" fill="#666">0</text>
  <!-- trace + points -->
  <polyline points="${points}" fill="none" stroke="#0d6efd" stroke-width="1.5" opacity="0.55"/>
  ${dots}
  <!-- legend -->
  <g transform="translate(${W - P - 200}, ${P + 12})" font-size="10">
    <circle cx="6" cy="0" r="4" fill="#057a30"/><text x="14" y="3" fill="#057a30">Within ±5 %</text>
    <circle cx="6" cy="14" r="4" fill="#b3261e"/><text x="14" y="17" fill="#b3261e">Deviation > ±5 %</text>
    <circle cx="6" cy="28" r="4" fill="#999"/><text x="14" y="31" fill="#999">No PF reading</text>
  </g>
  <text x="${W / 2}" y="${P - 14}" text-anchor="middle" fill="#333" font-weight="600">PGC 2016 GCR 4.4.4.1 — Q-V Capability (NGCP PF 0.95 lag/lead envelope)</text>
</svg>
<p style="font-size: 11px; color: #555; margin-top: 4px;">
  ${series.length} sweep points. Each dot is one PF target step's steady-state (V, Q). Green = observed PF within ±5 % of target; red = outside tolerance per the θ-3 acceptance criterion. Trace order follows the sweep sequence (1.00 → 0.95 lag → 1.00 → 0.95 lead → 1.00 by default).
</p>`;
}

// Friendly labels for run.test_kind so the PDF heading reads cleanly
// (`T2 — Frequency Withstand` instead of `T2_FREQ_WITHSTAND`).
const TEST_KIND_LABELS = {
  t2_freq_withstand: "T2 — Frequency Withstand",
  t3_qv_sweep:       "T3 — Reactive Power / Q-V Capability",
  t5_apc_sweep:      "T5 — Active Power Control Sweep",
};
function _testKindLabel(kind) {
  return TEST_KIND_LABELS[kind] || String(kind || "").toUpperCase().replace(/_/g, " ");
}

// Format a target_inverters array into a small one-row-per-target table.
function _renderTargetsBlock(safe, run) {
  let targets = [];
  try { targets = JSON.parse(run.target_inverters || "[]"); } catch (_) {}
  if (!Array.isArray(targets) || targets.length === 0) return "";
  const rows = targets.map(t => `
    <tr>
      <td>${safe(t.inverter ?? "")}</td>
      <td>${safe(t.ip ?? "")}</td>
      <td>${safe(t.slave ?? "")}</td>
    </tr>`).join("");
  return `<h2>Target Node${targets.length > 1 ? "s" : ""}</h2>
    <table class="kvtable">
      <thead><tr><th>Inverter</th><th>IP</th><th>Internal node</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// Render a JSON-encoded params object as a 2-column key/value table.
// Drops null/undefined entries and re-formats array values as comma lists
// so operators don't have to read raw JSON.
function _renderKvBlock(safe, jsonString, heading) {
  let obj = null;
  try { obj = JSON.parse(jsonString || "{}"); } catch (_) {}
  if (!obj || typeof obj !== "object") return "";
  const entries = Object.entries(obj).filter(([, v]) => v != null && v !== "");
  if (entries.length === 0) return "";
  const rows = entries.map(([k, v]) => {
    const valStr = Array.isArray(v) ? v.join(", ")
      : (typeof v === "object" ? JSON.stringify(v) : String(v));
    return `<tr><td class="kvkey">${safe(k)}</td><td>${safe(valStr)}</td></tr>`;
  }).join("");
  return `<h2>${safe(heading)}</h2>
    <table class="kvtable"><tbody>${rows}</tbody></table>`;
}

/**
 * Build a self-contained printable HTML doc for the run. No external assets.
 *
 * v2.11.x — slimmed for operator + witness readability:
 *   • Replaced raw JSON `<pre>` blocks (target_inverters, params_json,
 *     summary_json) with clean 2-column key/value tables.
 *   • Heading uses the friendly test-kind label.
 *   • Meta block shows only the fields a witness needs to sign off.
 */
function _buildReportHtml(run, steps, samples) {
  const safe = (s) => String(s == null ? "" : s).replace(/[<>&"']/g, c => ({
    "<":"&lt;",">":"&gt;","&":"&amp;",'"':"&quot;","'":"&#39;",
  }[c]));
  const fmtDate = (ms) => ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 19) + " UTC" : "—";
  const summary = run.summary_json ? (() => {
    try { return JSON.parse(run.summary_json); } catch { return null; }
  })() : null;

  const stepRows = steps.map(s => `
    <tr>
      <td>${safe(s.step_idx)}</td>
      <td>${safe(s.step_name)}</td>
      <td>${safe(s.target_value ?? "")}</td>
      <td>${safe(s.achieved_value == null ? "" : Number(s.achieved_value).toFixed(2))}</td>
      <td>${safe(s.deviation_pct == null ? "" : Number(s.deviation_pct).toFixed(2))}</td>
      <td class="${s.pass === 1 ? "pass" : (s.pass === 0 ? "fail" : "")}">${s.pass == null ? "—" : (s.pass ? "PASS" : "FAIL")}</td>
      <td>${safe(s.notes ?? "")}</td>
    </tr>
  `).join("");

  const sampleSummary = samples.length === 0
    ? "<p>No samples captured.</p>"
    : `<p><b>${samples.length}</b> samples captured between <code>${safe(fmtDate(samples[0].ts_ms))}</code>
       and <code>${safe(fmtDate(samples[samples.length - 1].ts_ms))}</code>. Full per-tick data is in the
       accompanying CSV.</p>`;

  const statusClass = run.status === "completed" ? "ok"
                    : run.status === "completed_with_warnings" ? "warn"
                    : (run.status === "failed" || run.status === "aborted") ? "fail" : "";

  return `<!doctype html>
<html><head>
  <meta charset="utf-8" />
  <title>NGCP PGC 2016 Compliance Report — ${safe(run.test_kind)} — ${safe(run.run_id)}</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; color: #111; padding: 24px; line-height: 1.5; }
    h1 { font-size: 18px; margin: 0 0 2px; }
    .subtitle { font-size: 11px; color: #666; margin-bottom: 18px; }
    h2 { font-size: 13px; margin: 20px 0 6px; border-bottom: 1px solid #ddd; padding-bottom: 3px; color: #333; }
    table { width: 100%; border-collapse: collapse; font-size: 11px; margin-top: 4px; }
    th, td { border: 1px solid #ccc; padding: 4px 8px; text-align: left; vertical-align: top; }
    th { background: #f4f4f4; font-weight: 600; }
    .kvtable { width: 60%; }
    .kvtable .kvkey { width: 35%; color: #555; font-weight: 500; background: #fafafa; }
    .meta-card { display: grid; grid-template-columns: max-content 1fr; gap: 4px 14px; font-size: 12px; padding: 10px 14px; background: #f9f9f9; border: 1px solid #eee; border-radius: 4px; }
    .meta-card .lbl { color: #666; }
    .pass { color: #057a30; font-weight: 600; }
    .fail { color: #b3261e; font-weight: 600; }
    .status-pill { display: inline-block; padding: 2px 10px; border-radius: 999px; font-weight: 600; font-size: 11px; }
    .status-pill.ok   { background: #e6f4ea; color: #0b6e2b; }
    .status-pill.warn { background: #fef7e0; color: #8a5a00; }
    .status-pill.fail { background: #fce8e6; color: #a3261e; }
    code { font-family: ui-monospace, Menlo, monospace; font-size: 11px; }
    .signoff { margin-top: 32px; page-break-inside: avoid; }
    .signoff .row { display: flex; gap: 24px; margin-top: 16px; }
    .signoff .row > div { flex: 1; }
    .signoff .line { border-top: 1px solid #999; margin-top: 36px; padding-top: 4px; font-size: 10px; color: #555; }
  </style>
</head><body>
  <h1>${safe(_testKindLabel(run.test_kind))}</h1>
  <div class="subtitle">NGCP PGC 2016 Compliance Evidence · Generated by Alterpower Digos Solar Dashboard</div>

  <div class="meta-card">
    <span class="lbl">Run ID</span>     <span><code>${safe(run.run_id)}</code></span>
    <span class="lbl">Started</span>    <span>${safe(fmtDate(run.started_at_ms))}</span>
    <span class="lbl">Ended</span>      <span>${safe(fmtDate(run.ended_at_ms))}</span>
    <span class="lbl">Status</span>     <span><span class="status-pill ${statusClass}">${safe(run.status)}</span></span>
    <span class="lbl">Operator</span>   <span>${safe(run.operator_actor || "—")}</span>
    ${run.error_message ? `<span class="lbl">Error</span><span><code>${safe(run.error_message)}</code></span>` : ""}
  </div>

  ${_renderTargetsBlock(safe, run)}
  ${_renderKvBlock(safe, run.params_json, "Parameters")}
  ${summary ? _renderKvBlock(safe, JSON.stringify(summary), "Result Summary") : ""}

  ${_buildQvChartSection(run, summary)}

  <h2>Step Results (${steps.length})</h2>
  <table>
    <thead><tr>
      <th>#</th><th>Step</th><th>Target</th><th>Achieved</th><th>Dev %</th><th>Result</th><th>Notes</th>
    </tr></thead>
    <tbody>${stepRows || `<tr><td colspan="7">No steps.</td></tr>`}</tbody>
  </table>

  <h2>Samples</h2>
  ${sampleSummary}

  <div class="signoff">
    <h2>Witness Sign-off</h2>
    <div class="row">
      <div><div class="line">NGCP Witness — printed name + signature + date</div></div>
      <div><div class="line">Plant Operator — Engr. Clariden Montaño REE</div></div>
    </div>
  </div>
</body></html>`;
}

/**
 * generateXlsxBundle(run, steps, samples, outDir) → { path, bytes, sha256 }
 *
 * v2.11.x — replaces the legacy CSV "section" column shape with a clean
 * three-sheet workbook that operators can hand to a witness without any
 * spreadsheet wrangling:
 *   • Sheet 1 "Run Info"  — meta + summary key/value table (frozen header)
 *   • Sheet 2 "Steps"     — one row per orchestrator step, no padding noise
 *   • Sheet 3 "Samples"   — full per-tick telemetry (filterable, frozen header)
 *
 * Every column is auto-sized from actual content width, every cell is
 * centered + middle-aligned, and the header row is bold with a project-
 * accent fill. The CSV path stays available for any external pipeline that
 * already consumes it; this is the operator-friendly default.
 */
async function generateXlsxBundle(run, steps, samples, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const fileName = `compliance-${run.test_kind}-${run.run_id}.xlsx`;
  const filePath = path.join(outDir, fileName);

  // Lazy-require so unit tests that don't exercise XLSX don't pay the cost.
  const ExcelJS = require("exceljs");
  const wb = new ExcelJS.Workbook();
  wb.creator = "Alterpower Digos Solar Dashboard";
  wb.created = new Date();
  wb.modified = new Date();

  const HEADER_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E3A8A" } };
  const HEADER_FONT = { color: { argb: "FFFFFFFF" }, bold: true, size: 11 };
  const HEADER_BORDER = {
    top:    { style: "thin", color: { argb: "FF1E3A8A" } },
    bottom: { style: "thin", color: { argb: "FF1E3A8A" } },
    left:   { style: "thin", color: { argb: "FF1E3A8A" } },
    right:  { style: "thin", color: { argb: "FF1E3A8A" } },
  };
  const CELL_BORDER = {
    top:    { style: "hair", color: { argb: "FFD0D0D0" } },
    bottom: { style: "hair", color: { argb: "FFD0D0D0" } },
    left:   { style: "hair", color: { argb: "FFD0D0D0" } },
    right:  { style: "hair", color: { argb: "FFD0D0D0" } },
  };
  const CENTER = { horizontal: "center", vertical: "middle", wrapText: false };

  // Compute a column's auto-width from the longest value in that column.
  // Excel's column width unit ≈ "characters of digit zero in the default
  // font", so length-based heuristics produce a tight fit without runtime
  // font measurement (which exceljs doesn't expose).
  function autoFitColumns(ws, headers, rows) {
    headers.forEach((h, i) => {
      let max = String(h ?? "").length;
      for (const r of rows) {
        const v = r[i];
        const s = v == null ? "" : String(v);
        if (s.length > max) max = s.length;
      }
      ws.getColumn(i + 1).width = Math.min(60, Math.max(10, max + 3));
    });
  }

  function styleHeaderRow(ws, rowIdx) {
    const row = ws.getRow(rowIdx);
    row.eachCell((cell) => {
      cell.font = HEADER_FONT;
      cell.fill = HEADER_FILL;
      cell.alignment = CENTER;
      cell.border = HEADER_BORDER;
    });
    row.height = 22;
  }

  function styleDataCells(ws, fromRow, toRow) {
    for (let r = fromRow; r <= toRow; r++) {
      const row = ws.getRow(r);
      row.eachCell((cell) => {
        cell.alignment = CENTER;
        cell.border = CELL_BORDER;
      });
    }
  }

  // ─── Sheet 1: Run Info ────────────────────────────────────────────────
  const wsInfo = wb.addWorksheet("Run Info", { views: [{ state: "frozen", ySplit: 1 }] });
  const infoHeaders = ["Field", "Value"];
  wsInfo.addRow(infoHeaders);
  const infoRows = [
    ["Run ID",    run.run_id],
    ["Test Kind", run.test_kind],
    ["Started",   run.started_at_ms ? new Date(run.started_at_ms).toISOString() : ""],
    ["Ended",     run.ended_at_ms   ? new Date(run.ended_at_ms).toISOString()   : ""],
    ["Status",    run.status || ""],
    ["Operator",  run.operator_actor || ""],
  ];
  if (run.error_message) infoRows.push(["Error", run.error_message]);
  // Promote high-signal summary fields into their own rows.
  if (run.summary_json) {
    try {
      const s = JSON.parse(run.summary_json);
      if (s && typeof s === "object") {
        ["passes", "fails", "samples", "mean_hz", "min_hz", "max_hz",
         "alarm_events", "longest_excursion_ms", "in_continuous_band",
         "in_withstand_band", "outside_withstand_band"].forEach((k) => {
          if (s[k] != null) infoRows.push([`summary.${k}`, s[k]]);
        });
      }
    } catch (_) { /* JSON parse failure → skip the summary block */ }
  }
  infoRows.forEach((r) => wsInfo.addRow(r));
  styleHeaderRow(wsInfo, 1);
  styleDataCells(wsInfo, 2, infoRows.length + 1);
  // Field column left-aligned for readability; value centered.
  for (let r = 2; r <= infoRows.length + 1; r++) {
    wsInfo.getCell(r, 1).alignment = { horizontal: "left", vertical: "middle" };
    wsInfo.getCell(r, 1).font = { bold: true, color: { argb: "FF555555" } };
  }
  autoFitColumns(wsInfo, infoHeaders, infoRows);

  // ─── Sheet 2: Steps ───────────────────────────────────────────────────
  const wsSteps = wb.addWorksheet("Steps", { views: [{ state: "frozen", ySplit: 1 }] });
  const stepHeaders = ["#", "Step", "Start", "End", "Target", "Achieved", "Dev %", "Result", "Notes"];
  wsSteps.addRow(stepHeaders);
  const stepRows = steps.map((s) => [
    s.step_idx ?? "",
    s.step_name ?? "",
    s.started_at_ms ? new Date(s.started_at_ms).toISOString() : "",
    s.ended_at_ms   ? new Date(s.ended_at_ms).toISOString()   : "",
    s.target_value ?? "",
    s.achieved_value == null ? "" : Number(Number(s.achieved_value).toFixed(3)),
    s.deviation_pct == null  ? "" : Number(Number(s.deviation_pct).toFixed(3)),
    s.pass == null ? "—" : (s.pass ? "PASS" : "FAIL"),
    s.notes ?? "",
  ]);
  stepRows.forEach((r) => wsSteps.addRow(r));
  styleHeaderRow(wsSteps, 1);
  styleDataCells(wsSteps, 2, stepRows.length + 1);
  // Result column gets pass/fail color tint for at-a-glance scanning.
  for (let r = 2; r <= stepRows.length + 1; r++) {
    const result = wsSteps.getCell(r, 8).value;
    if (result === "PASS") {
      wsSteps.getCell(r, 8).font = { bold: true, color: { argb: "FF057A30" } };
    } else if (result === "FAIL") {
      wsSteps.getCell(r, 8).font = { bold: true, color: { argb: "FFB3261E" } };
    }
  }
  autoFitColumns(wsSteps, stepHeaders, stepRows);

  // ─── Sheet 3: Samples ─────────────────────────────────────────────────
  const wsSamples = wb.addWorksheet("Samples", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  const sampleHeaders = ["Time", "Inverter IP", "Slave", "PAC (W)", "QAC (VAR)",
    "Vac avg (V)", "Iac avg (A)", "Freq (Hz)", "cosφ", "Temp (°C)", "State raw", "Alarm bits"];
  wsSamples.addRow(sampleHeaders);
  const sampleRows = samples.map((s) => [
    s.ts_ms ? new Date(s.ts_ms).toISOString() : "",
    s.inverter_ip || "",
    s.slave ?? "",
    s.pac_w ?? "",
    s.qac_var ?? "",
    s.vac_avg_v == null ? "" : Number(Number(s.vac_avg_v).toFixed(2)),
    s.iac_avg_a == null ? "" : Number(Number(s.iac_avg_a).toFixed(2)),
    s.freq_hz   == null ? "" : Number(Number(s.freq_hz).toFixed(3)),
    s.cosphi    == null ? "" : Number(Number(s.cosphi).toFixed(3)),
    s.temp_c    ?? "",
    s.state_raw == null ? "" : `0x${Number(s.state_raw).toString(16).toUpperCase().padStart(4, "0")}`,
    s.alarm_32  == null ? "" : `0x${Number(s.alarm_32).toString(16).toUpperCase().padStart(8, "0")}`,
  ]);
  sampleRows.forEach((r) => wsSamples.addRow(r));
  styleHeaderRow(wsSamples, 1);
  styleDataCells(wsSamples, 2, sampleRows.length + 1);
  // Auto-filter on the header row so witnesses can sort/filter freely.
  wsSamples.autoFilter = {
    from: { row: 1, column: 1 },
    to:   { row: 1, column: sampleHeaders.length },
  };
  autoFitColumns(wsSamples, sampleHeaders, sampleRows);

  await wb.xlsx.writeFile(filePath);
  const stat = fs.statSync(filePath);
  return {
    path: filePath,
    bytes: stat.size,
    sha256: _sha256OfFile(filePath),
  };
}

/**
 * generatePdfBundle(run, steps, samples, outDir, puppeteerInstance) → { path, bytes, sha256 }
 * `puppeteerInstance` allows tests to inject a stub. In production we
 * lazy-require puppeteer.
 */
async function generatePdfBundle(run, steps, samples, outDir, puppeteerInstance) {
  fs.mkdirSync(outDir, { recursive: true });
  const fileName = `compliance-${run.test_kind}-${run.run_id}.pdf`;
  const filePath = path.join(outDir, fileName);
  const html = _buildReportHtml(run, steps, samples);

  const pup = puppeteerInstance || require("puppeteer");
  const browser = await pup.launch({ headless: "new", args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    await page.pdf({
      path: filePath,
      format: "A4",
      printBackground: true,
      margin: { top: "12mm", bottom: "12mm", left: "12mm", right: "12mm" },
    });
  } finally {
    await browser.close();
  }
  const stat = fs.statSync(filePath);
  return { path: filePath, bytes: stat.size, sha256: _sha256OfFile(filePath) };
}

module.exports = {
  generateCsvBundle,
  generateXlsxBundle,
  generatePdfBundle,
  _buildReportHtml, // exported for tests
};
