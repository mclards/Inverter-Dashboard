---
name: adsi-mobile-design
description: Design system guidelines, responsive layout rules, and UI invariants for ADSI Inverter Dashboard.
---

# ADSI Dashboard — UI & Responsive Design Invariants (Token-Optimized)

## 1. Core Layout & Asset Mirroring Rules
1. **Desktop Lock (`> 768px`):** Never alter desktop layout across 1080p/1440p/4K monitors.
2. **Mobile Scope (`<= 768px`):** Place all mobile overrides inside `@media screen and (max-width: 768px)` at the bottom of `public/css/style.css`.
3. **Mirrored Frontend Assets:** Always mirror edits between `public/` and `frontend/public/` (`index.html`, `css/style.css`, `js/app.js`) and bump `?v=XX` cache-busting query strings in both HTML entry points.
4. **Atomic HTML Edits:** After editing `index.html`, run `git diff public/index.html` to verify balanced `<label>`, `<div>`, and `<button>` tags.
5. **Click & Pointer-Events Safety:** Hidden modals, drawers, and overlays must set `pointer-events: none` (or `display: none`) when inactive so transparent backdrops never intercept clicks on toolbar/action buttons (e.g., `Accept All`, `Start/Stop Local Server`).

## 2. Form, Checkbox & Card Invariants
- **Mobile Input Sizing:** Override desktop fixed `min-width` values inside mobile media queries:
  `min-width: 0 !important; max-width: 100% !important; width: 100% !important; box-sizing: border-box !important;`
- **Inline Checkboxes (`.chk-inline`):**
  - Wrap all checkboxes/toggles in `<label class="chk-inline">`.
  - Enforce `display: flex !important; flex-direction: row !important; align-items: center !important; gap: 10px !important; width: 100% !important;` and fixed `16px x 16px` (`flex: 0 0 16px !important`) on `input[type="checkbox"]`.
  - Guard all parent column-flex label rules with `:not(.chk-inline)` (e.g., `.srow label:not(.chk-inline)`).
- **Multi-Column Settings Cards (`.settings-subsection`):**
  - Wrap contents of `grid-template-columns: repeat(auto-fit, ...)` cards in `<div class="settings-subsection">` (`grid-column: 1 / -1; width: 100%; box-sizing: border-box;`).
- **Dynamic Lifecycle Buttons:** Bind `.disabled` state and visual cues (`opacity: 0.55; cursor: not-allowed;`) to live health probes, never cached click state.

## 3. Page-Specific Responsive Patterns
- **Plant Controller (`#page-plant-cap`):**
  - `#plantCapTabStrip`: 2-row grid with zero horizontal scroll — Row 1 (`APC`: `MW Cap`, `%P Setpoint`, `Grid Code`), Row 2 (`GRID TESTS`: `T2 Freq`, `T3 Q-V`, `T5 Sweep`, `Reports`).
  - `MW Cap`: 4-col toolbar & hero metrics; 2-col (`Upper`/`Lower`) + 3-col (`Sequence`/`Exempted`/`Cooldown`) form; 4-col actions; 2x4 status grid; 2x4 `#capScheduleModal` with `:empty { display: none !important; }`.
  - `%P Setpoint`: 3-chip scope bar, 2-col target selectors, 6-button preset grid (`100|90|75|50|25|0`), 3-col actions (`STOP|START|Apply`).
  - `Compliance (T2/T3/T5/Reports)`: 2-col target grid (IP hidden on mobile), 3-col parameter trios (`Hold|Settle|Tol`), 3-col 48px metric tiles, overflow-x tables.
- **Data Export (`#page-export`):** Vertical flex `export-grid` (`gap: 12px`), `.exp-desc`/`.exp-note` hidden on mobile, uniform `30px` inputs, 2-col `Export`/`Cancel`.
- **Tablet (`769px–1200px`):** `.chart-total-side-card` and `.chart-total-card` span `grid-column: 1 / -1` stacked vertically; chart headers/legends use `flex-wrap`.
- **Settings (`#page-settings`):** 4-card status HUD (`Server State`, `:3500`, `:9100`, `:9200`), compact Forecast Configuration (`Source & Tuning` + `Solcast Connection` tabs; text-only connection verify).
