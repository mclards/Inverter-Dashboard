---
name: adsi-mobile-design
description: Design system guidelines, responsive layout rules, and invariants for ADSI Inverter Dashboard.
---

# ADSI Dashboard — Agent Knowledge Base & UI System Architecture

This file documents the core project rules, responsive design patterns, and operational knowledge established for the **ADSI Dashboard** codebase. All AI assistants, models, and agents working on this repository must adhere to these principles.

---

## 1. Golden Rules & Workspace Invariants

1. **Strict Desktop Protection:**
   - **NEVER** modify or break the desktop UI layout.
   - Desktop view (`> 768px`) must remain 100% intact, pristine, and verified across all resolutions (1080p, 1440p, 4K multi-monitor arrays).
2. **Mobile Scope Enforcement:**
   - All mobile-specific styles, layout overrides, and component refactors must be strictly placed inside `@media screen and (max-width: 768px)` at the bottom of `public/css/style.css`.
3. **Cache Busting Protocol:**
   - Whenever any edit is made to `public/css/style.css` (or core scripts), increment the stylesheet query parameter in `public/index.html` (e.g. `<link rel="stylesheet" href="css/style.css?v=XX" />`).
4. **Input Overlap Prevention (Mobile Sizing Invariants):**
   - Desktop CSS contains fixed min-widths on inputs/selects (e.g. `.cmp-sel { min-width: 220px }`, `.cmp-text-flex { min-width: 320px }`).
   - On mobile, always enforce:
     ```css
     min-width: 0 !important;
     max-width: 100% !important;
     box-sizing: border-box !important;
     width: 100% !important;
     ```
   - Always wrap form inputs inside semantic `<label class="...-field">` containers with top labels (`display: flex; flex-direction: column; gap: 2px;`) to prevent grid cell collisions and border overlap.
5. **Checkbox & Toggle Inline Invariant (`.chk-inline`):**
   - Every checkbox/toggle in forms, settings cards, and toolbars MUST be wrapped in a `<label class="chk-inline">` container.
   - Enforce row-oriented inline layout across all breakpoints:
     ```css
     #page-settings .srow label.chk-inline,
     #page-settings .settings-sections .srow label.chk-inline {
       grid-column: 1 / -1 !important;
       display: flex !important;
       flex-direction: row !important;
       align-items: center !important;
       gap: 10px !important;
       width: 100% !important;
       max-width: 100% !important;
       font-size: 12.5px !important;
       font-weight: 600 !important;
       color: var(--text2) !important;
       cursor: pointer !important;
     }
     #page-settings .chk-inline input[type="checkbox"] {
       width: 16px !important;
       height: 16px !important;
       min-width: 16px !important;
       max-width: 16px !important;
       accent-color: var(--accent) !important;
       cursor: pointer !important;
       margin: 0 !important;
       flex: 0 0 16px !important;
     }
     ```
   - **CRITICAL:** All parent column-flex rules on `.srow label` or `.settings-card label` MUST be guarded with `:not(.chk-inline)` (e.g. `.srow label:not(.chk-inline)`) so checkboxes are never forced into vertical column stacks where the box sits above the text.
6. **Settings Card & Subsection Wrapper (`.settings-subsection`):**
   - Multi-column settings cards (`grid-template-columns: repeat(auto-fit, ...)`) MUST encapsulate contents inside `<div class="settings-subsection">` (`grid-column: 1 / -1; width: 100%; box-sizing: border-box;`) to prevent direct children from collapsing into narrow grid tracks.
7. **Atomic Markup Edit Safety Protocol:**
   - When editing HTML components in `public/index.html`, never truncate or omit opening/closing tags (`<label>`, `<div>`, `<button>`).
   - Always run `git diff public/index.html` immediately after modifying HTML to verify zero accidental line deletions or broken element trees.
8. **Dynamic Button Lifecycle States:**
   - Action buttons that depend on runtime daemon state (e.g. Start/Stop Local Server) must dynamically update their `.disabled` property alongside visual cues (`opacity: 0.55; cursor: not-allowed;`) so operators never see conflicting active states.
9. **Decluttering on Mobile:**
   - Hide lengthy prose, multi-paragraph help text, `<details class="cmp-howto">`, and `.cmp-target-help` on mobile. Focus on actionable controls, readable metrics, and compact touch targets.

---

## 2. Plant Controller Page (`#page-plant-cap`) UI Patterns

### A. Sub-Navigation Tab Bar (`#plantCapTabStrip`)
- **Zero Horizontal Scrolling:** Rendered as an on-screen structured 2-row grid:
  - **Row 1 (APC Category):** `APC` Badge (Cyan) + 3 tabs (`MW Cap`, `%P Setpoint`, `Grid Code`) taking 100% width.
  - **Row 2 (GRID TESTS Category):** `GRID TESTS` Badge (Indigo) + 4 tabs (`T2 Freq`, `T3 Q-V`, `T5 Sweep`, `Reports`) taking 100% width.
  - All 7 tabs and badges are immediately visible and tap-accessible without swiping.

### B. MW Cap Tab (`#plantCapTabPaneMwCap`)
- **Toolbar:** Balanced 4-column single row (`Status` | `Plant MW` | `Band` | `+ Add Schedule`).
- **Hero Metrics:** Balanced 4-column single row (`PLANT` | `BAND` | `MODE` | `EXPORT LIMIT`).
- **Form:**
  - Row 1 (2-Cols): `Upper Limit (MW)` | `Lower Limit (MW)`.
  - Row 2 (3-Cols): `Sequence` | `Exempted` | `Cooldown (s)`. (The `Exempted` field is always visible in the middle slot).
- **Action Buttons:** Balanced 4-column single row (`Preview Plan` | `Enable Cap` | `Disable Monitoring` | `Release Controlled Inverters`).
- **Status Grid:** 2 columns × 4 rows (8 distinct status cards).
- **Schedule Modal (`#capScheduleModal`):**
  - 8 input fields arranged into a clean 2-column × 4-row grid.
  - Single full-width Save button.
  - Redundant Cancel button hidden (`display: none`).
  - Empty error pill containers strictly hidden (`:empty { display: none !important; }`).

### C. Active Power Control (%P Setpoint) Tab (`#plantCapTabPaneApc`)
- **Scope Selection:** 3-chip segment bar (`Per Node` | `Per Inverter` | `Plant-Wide`).
- **Target Selection:** 2-column dropdowns (`Inverter` & `Node`) + full-width current %P setpoint readout pill.
- **Setpoint & Presets:** Large % input box with a 6-button preset grid (`100` | `90` | `75` | `50` | `25` | `0`).
- **Actions:** 3-column row (`STOP` [Red] | `START` [Green] | `Apply Setpoint` [Accent]).
- **Ramp-Rate Limiter:** Compact inline control row.

### D. Grid Code Tab (`#plantCapTabPaneGridControl`)
- Compact alert pill for safety banner.
- 2-column target selectors with read-state button.
- Side-by-side action buttons (`Set PF` | `Set kVAr` | `Disable Reactive`).

### E. Compliance Tests (`T2 Freq`, `T3 Q-V`, `T5 Sweep`, `Reports`)
- **Target Selector:** 2-column grid (`Inverter` | `Internal node`). Redundant IP input is hidden on mobile.
- **Parameters:**
  - Multi-value sequence inputs (`Sweep`, `Ramp`): Full-width row with horizontal scrolling.
  - Numeric parameter trios (`Hold` | `Settle` | `Tol`): Balanced 3-column row (`repeat(3, minmax(0, 1fr))`).
- **Action Buttons:** Side-by-side balanced 2-column or 3-column buttons (`Run sweep / Start observation`, `Abort`, `Read-back state`).
- **Results Metrics:** 3-column balanced grid with fixed 48px tile height and ellipsis text protection.
- **Live Feed & Run History Tables:** Encapsulated in responsive overflow-x swipe containers.

---

## 3. Data Export Section (`#page-export`) UI Patterns

- **Card Stacking:** `export-grid` styled as a vertical flex container with a `12px` gap (preventing card overlaps).
- **Descriptions & Notes:** `.exp-desc` and `.exp-note` text hidden on mobile.
- **Inputs:** Locked to a uniform `30px` height with clean 2-column or 3-column layouts.
- **Actions:** Side-by-side balanced `Export` and `Cancel` buttons.

---

## 4. Tablet & Intermediate Screen Patterns (769px–1200px)

- **Analytics Top Cards:** On tablet viewports (`≤ 1200px`), `.chart-total-side-card` (`Selected Date Summary`) and `.chart-total-card` (`Day-Ahead vs Actual MWh`) span full width (`grid-column: 1 / -1`) stacked vertically, giving 9 metric tiles spacious 3-column rows and granting the 24-hour day-ahead vs actual chart high-resolution canvas width.
- **Chart Titlebar & Legend Flex:** Header metrics and legend chips use flex-wrap with non-breaking titles rather than rigid grid columns, preventing word-wrapping on titles and text truncation on legend chips.

---

## 5. Settings & Lifecycle Management Patterns (`#page-settings`, `#serverControlSection`)

- **Card Headers:** Clean title with MDI icon and descriptive tooltip.
- **Status HUD:** Balanced 4-card metric grid (`Server State`, `Web Gateway (:3500)`, `Telemetry Engine (:9100)`, `AI Forecast Engine (:9200)`).
- **Option Toggles:** Single full-width horizontal rows using `.chk-inline` with $16\text{px} \times 16\text{px}$ inputs and clear text descriptions.
- **Lifecycle Actions:** Side-by-side balanced buttons (`Start Local Server` [Primary], `Stop Local Server` [Red], `Check Status` [Outline]) with active/disabled state binding.

---

## 6. Testing & Verification Checklist

When making UI adjustments:
1. **Node Test Suite:** Run `node scripts/smoke-all.js --skip-python --no-rebuild` and verify 100% of Node suites pass (**106 / 106 PASS**).
2. **HTML Tag Balance:** Run `git diff public/index.html` to confirm all `<label>`, `<div>`, and `<button>` tags are properly balanced.
3. **Mobile Verification:** Test in responsive viewport (e.g. 360px–390px width) using headless browser/Puppeteer to confirm zero horizontal scroll on tab bars and zero field overlap.
4. **Intermediate/Tablet Verification:** Test in tablet viewport (e.g. 800px–1024px width) to confirm seamless stacking and card expansion.
5. **Desktop Verification:** Take full desktop screenshots (1440px width) to verify zero layout regressions.
6. **Bump CSS Version:** Ensure `public/index.html` has incremented CSS query version before finalizing.
