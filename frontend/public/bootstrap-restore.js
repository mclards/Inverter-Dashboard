"use strict";
/* global bootstrapRestoreAPI */

/**
 * bootstrap-restore.js — wizard renderer for the v2.8.14 bootstrap-restore
 * flow. Driven entirely by IPC into electron/bootstrapRestore.js — see the
 * preload (preload-bootstrap-restore.js) for the channel contract.
 *
 * Step lifecycle:
 *   1. pick-file        →  Browse → assertValidAdsibakPath in main
 *   2. validate         →  validatePortableBackup → manifest preview
 *   3. scope-checklist  →  user opts in/out of database/config/logs/...
 *   4. progress         →  importPortableBackup + restorePortableBackup
 *   5. done             →  user clicks Relaunch → reportComplete(restored:true)
 *                            → main relaunches
 *
 * IMPORTANT: `complete({restored:true})` is fired ONLY when the user clicks
 * "Relaunch" on step 5. Firing it inside runRestore() would close the wizard
 * before the user could see the success page.
 */

const state = {
  step: 1,
  filePath: null,
  fileSize: 0,
  validation: null, // result of validate()
  scopeDefinitions: [],
  scopeChecked: new Set(),
  restoreInFlight: false, // gates Cancel/Back during step 4
  restoreOutcome: null,   // "success" | "failure" | null
};

// ─── DOM refs ──────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const els = {
  filePath:     $("filePath"),
  pickError:    $("pickError"),
  btnPickFile:  $("btnPickFile"),
  summaryGrid:  $("summaryGrid"),
  rowCounts:    $("rowCounts"),
  validateError:$("validateError"),
  scopeList:    $("scopeList"),
  scopeEmpty:   $("scopeEmptyWarning"),
  progressText: $("progressText"),
  progressFill: $("progressFill"),
  restoreError: $("restoreError"),
  stepper:      $("stepper"),
  btnCancel:    $("btnCancel"),
  btnBack:      $("btnBack"),
  btnNext:      $("btnNext"),
  btnRelaunch:  $("btnRelaunch"),
};

// ─── Helpers ───────────────────────────────────────────────────────────────
function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtDate(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  } catch { return iso; }
}

function setStep(n) {
  state.step = n;
  document.querySelectorAll(".step").forEach((el) => {
    el.classList.toggle("active", Number(el.dataset.step) === n);
  });
  // stepper dots
  Array.from(els.stepper.children).forEach((dot, idx) => {
    dot.classList.remove("active", "done");
    if (idx + 1 < n) dot.classList.add("done");
    else if (idx + 1 === n) dot.classList.add("active");
  });
  // UI-R8: update aria-valuenow for screen readers
  if (els.stepper) {
    els.stepper.setAttribute("aria-valuenow", String(n));
  }
  updateFooterButtons();
}

/**
 * Fix #2: Footer buttons must reflect BOTH the current step AND whether a
 * restore is in flight. During step 4 + restoreInFlight, everything is
 * locked down to prevent the user from orphaning a running restore.
 */
function updateFooterButtons() {
  const n = state.step;
  const inFlight = state.restoreInFlight;
  const outcome = state.restoreOutcome;

  // Cancel: visible on 1-3 freely; on step 4 ONLY after a failure; hidden on 5
  if (n < 4) {
    els.btnCancel.style.display = "inline-block";
    els.btnCancel.disabled = false;
  } else if (n === 4) {
    els.btnCancel.style.display = outcome === "failure" ? "inline-block" : "none";
    els.btnCancel.disabled = inFlight;
  } else {
    els.btnCancel.style.display = "none";
  }

  // Back: visible on 2-3; on step 4 ONLY after a failure (retry); hidden on 1 and 5
  if (n === 2 || n === 3) {
    els.btnBack.style.display = "inline-block";
    els.btnBack.disabled = false;
  } else if (n === 4 && outcome === "failure" && !inFlight) {
    els.btnBack.style.display = "inline-block";
    els.btnBack.disabled = false;
  } else {
    els.btnBack.style.display = "none";
  }

  // Next: visible on 1-3; hidden on 4 and 5
  if (n < 4) {
    els.btnNext.style.display = "inline-block";
    els.btnNext.textContent = n === 3 ? "Restore" : "Next";
    if (n === 1) els.btnNext.disabled = !state.filePath;
    else if (n === 2) els.btnNext.disabled = !state.validation;
    else if (n === 3) els.btnNext.disabled = state.scopeChecked.size === 0;
  } else {
    els.btnNext.style.display = "none";
  }

  // Relaunch: only on step 5
  els.btnRelaunch.style.display = n === 5 ? "inline-block" : "none";
}

function showError(el, msg) {
  el.textContent = msg;
  el.style.display = "block";
}

function clearError(el) {
  el.textContent = "";
  el.style.display = "none";
}

// ─── Step 1: pick file ─────────────────────────────────────────────────────
els.btnPickFile.addEventListener("click", async () => {
  clearError(els.pickError);
  try {
    const res = await bootstrapRestoreAPI.pickFile();
    if (!res?.ok) {
      if (res?.canceled) return;
      showError(els.pickError, res?.error || "Could not select file.");
      return;
    }
    state.filePath = res.path;
    state.fileSize = res.size;
    state.validation = null; // invalidate previous validation if any
    els.filePath.textContent = res.path;
    els.filePath.classList.add("has-value");
    updateFooterButtons();
  } catch (err) {
    showError(els.pickError, err.message || String(err));
  }
});

// ─── Step 2: validate ──────────────────────────────────────────────────────
async function runValidation() {
  clearError(els.validateError);
  els.summaryGrid.innerHTML = '<dt>Status</dt><dd>Validating…</dd>';
  els.rowCounts.style.display = "none";
  // Lock Next/Back during validate so user can't double-click
  els.btnNext.disabled = true;
  els.btnBack.disabled = true;
  try {
    const res = await bootstrapRestoreAPI.validate(state.filePath);
    if (!res?.ok) {
      showError(els.validateError, res?.error || "Validation failed.");
      els.summaryGrid.innerHTML = "";
      state.validation = null;
      return;
    }
    state.validation = res.info;
    renderSummary(res.info);
  } catch (err) {
    showError(els.validateError, err.message || String(err));
    state.validation = null;
  } finally {
    updateFooterButtons();
  }
}

function renderSummary(info) {
  const rows = [
    ["Source app version", info.appVersion || "unknown"],
    ["Schema version",     info.schemaVersion || "—"],
    ["Created",            fmtDate(info.createdAt)],
    ["Tag",                info.tag || "—"],
    ["Scopes in backup",   (info.scope || []).join(", ") || "—"],
    ["Files",              String(info.fileCount || 0)],
    ["Uncompressed size",  fmtSize(info.totalSize)],
    ["Archive size",       fmtSize(info.archiveSize)],
    ["Checksum",           info.checksumOk ? "verified" : "MISMATCH"],
  ];
  els.summaryGrid.innerHTML = rows
    .map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(String(v))}</dd>`)
    .join("");

  if (info.rowCounts && Object.keys(info.rowCounts).length) {
    const top = Object.entries(info.rowCounts)
      .sort((a, b) => (b[1] || 0) - (a[1] || 0))
      .slice(0, 8)
      .map(([t, n]) => `<strong>${escapeHtml(t)}</strong>: ${Number(n).toLocaleString()}`)
      .join(" &middot; ");
    els.rowCounts.innerHTML = `Database row counts (top tables): ${top}`;
    els.rowCounts.style.display = "block";
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ─── Step 3: scope checklist ───────────────────────────────────────────────
async function buildScopeList() {
  els.scopeList.innerHTML = "";
  state.scopeChecked = new Set();
  const defs = state.scopeDefinitions;
  const manifestScopes = new Set((state.validation?.scope) || []);

  for (const def of defs) {
    const available = manifestScopes.has(def.key);
    const checkedByDefault = available && def.defaultChecked;
    if (checkedByDefault) state.scopeChecked.add(def.key);

    const li = document.createElement("li");
    if (!available) li.classList.add("disabled");

    const pill = available
      ? (def.critical ? '<span class="pill">recommended</span>' : "")
      : '<span class="pill unavailable">not in this backup</span>';

    li.innerHTML = `
      <label>
        <input type="checkbox" data-scope="${def.key}" ${checkedByDefault ? "checked" : ""} ${available ? "" : "disabled"}>
        <span class="scope-text">
          <span class="scope-label">${escapeHtml(def.label)}${pill}</span>
          <span class="scope-detail">${escapeHtml(def.detail)}</span>
        </span>
      </label>
    `;
    els.scopeList.appendChild(li);
  }

  els.scopeList.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener("change", () => {
      const key = cb.dataset.scope;
      if (cb.checked) state.scopeChecked.add(key);
      else state.scopeChecked.delete(key);
      updateScopeEmptyWarning();
      updateFooterButtons();
    });
  });
  updateScopeEmptyWarning();
}

function updateScopeEmptyWarning() {
  const enabled = state.scopeChecked.size > 0;
  els.scopeEmpty.style.display = enabled ? "none" : "block";
}

// ─── Step 4: run restore ───────────────────────────────────────────────────
async function runRestore() {
  clearError(els.restoreError);
  els.progressText.textContent = "Preparing restore…";
  els.progressFill.style.width = "10%";

  state.restoreInFlight = true;
  state.restoreOutcome = null;
  updateFooterButtons();

  // Pseudo-progress timer. Real progress events aren't available without
  // the embedded server — this is just to reassure the user the app is
  // alive while archiver/extract-zip stream the .adsibak through Node.
  let pct = 10;
  const tick = setInterval(() => {
    pct = Math.min(pct + 3, 90);
    els.progressFill.style.width = `${pct}%`;
    if (pct < 40)       els.progressText.textContent = "Extracting backup archive…";
    else if (pct < 70)  els.progressText.textContent = "Verifying integrity…";
    else                els.progressText.textContent = "Writing files to disk…";
  }, 800);

  let result;
  try {
    result = await bootstrapRestoreAPI.run({
      sourcePath: state.filePath,
      scopeFilter: Array.from(state.scopeChecked),
    });
  } catch (err) {
    clearInterval(tick);
    state.restoreInFlight = false;
    state.restoreOutcome = "failure";
    els.progressFill.style.width = "0%";
    els.progressText.textContent = "Restore threw an exception.";
    showError(els.restoreError, err.message || String(err));
    updateFooterButtons();
    // Do NOT call complete() — user can retry via Back or abandon via Cancel.
    return;
  }

  clearInterval(tick);
  state.restoreInFlight = false;

  if (!result?.ok) {
    state.restoreOutcome = "failure";
    els.progressFill.style.width = "0%";
    els.progressText.textContent = "Restore failed.";
    showError(els.restoreError, result?.error || "Restore failed for an unknown reason.");
    updateFooterButtons();
    return;
  }

  state.restoreOutcome = "success";
  els.progressFill.style.width = "100%";
  els.progressText.textContent = "Restore complete.";
  // Fix #1: do NOT fire complete() here. The user must click Relaunch to
  // confirm they've read the success page.
  setStep(5);
}

// ─── Footer wiring ─────────────────────────────────────────────────────────
els.btnNext.addEventListener("click", async () => {
  if (state.step === 1) {
    setStep(2);
    await runValidation();
  } else if (state.step === 2) {
    setStep(3);
    await buildScopeList();
  } else if (state.step === 3) {
    if (state.scopeChecked.size === 0) {
      els.scopeEmpty.style.display = "block";
      return;
    }
    setStep(4);
    await runRestore();
  }
});

els.btnBack.addEventListener("click", () => {
  if (state.restoreInFlight) return; // safety: never honour Back mid-restore
  if (state.step === 4 && state.restoreOutcome === "failure") {
    // After a failed restore, Back returns to the scope checklist so the
    // user can adjust and retry.
    state.restoreOutcome = null;
    state.restoreInFlight = false;
    clearError(els.restoreError);
    els.progressFill.style.width = "0%";
    setStep(3);
    return;
  }
  if (state.step > 1) setStep(state.step - 1);
});

els.btnCancel.addEventListener("click", async () => {
  if (state.restoreInFlight) return; // safety
  // After a failed restore, Cancel should just close the wizard.
  await bootstrapRestoreAPI.cancel();
});

els.btnRelaunch.addEventListener("click", () => {
  // Fix #1: THIS is where the restored-state signal finally goes back to
  // main. Main then schedules app.relaunch() + app.exit(0).
  els.btnRelaunch.disabled = true;
  els.btnRelaunch.textContent = "Relaunching…";
  bootstrapRestoreAPI.complete({
    restored: true,
    scope: Array.from(state.scopeChecked),
  });
});

// ─── Boot ──────────────────────────────────────────────────────────────────
(async function init() {
  try {
    state.scopeDefinitions = await bootstrapRestoreAPI.getScopes();
  } catch (err) {
    state.scopeDefinitions = [];
    console.error("[bootstrap-restore] getScopes failed:", err);
  }
  setStep(1);
})();
