# Fix Record: Universal Mobile (iPhone/Android) & Browser Export Downloads

- **Date:** 2026-08-27 20:55:00 (+08:00)
- **Scope:** Mobile Devices (iOS Safari, Android Chrome, iPad), Web Browsers, Gateway & Remote Export Routes
- **Components:** server/index.js, public/js/app.js, rontend/public/js/app.js, public/css/style.css, rontend/public/css/style.css, public/index.html, rontend/public/index.html

---

## 1. Problem Statement
When an operator accessed the dashboard via a web browser on a mobile device (iPhone / Safari, Android / Chrome, iPad) and clicked an "Export" button:
1. The server processed the export and wrote the resulting .xlsx or .csv file to the host machine's filesystem path (e.g. /var/lib/inverter-dashboard/exports/... on Linux).
2. The server responded with { ok: true, path: "/var/lib/..." }.
3. The frontend called openExportPathFolder(r.path), which was a desktop-only Electron method (window.electronAPI.openFolder(dir)).
4. On mobile devices and web browsers, window.electronAPI was undefined. As a result, no file download was triggered to the device.
5. The UI displayed ✔ Saved: /var/lib/..., leaving the user without access to the exported file on their phone.
6. In Settings, the "Export Folder" section showed a Windows path input (C:\Logs\...) and a desktop folder picker, which was confusing and non-functional on mobile devices.

---

## 2. Root Cause
- **Server Artifact Route Restriction:** /api/export/artifact only listened for HTTP POST requests expecting JSON bodies, preventing standard browser navigation and direct anchor tag downloads (<a href="..." download="...">).
- **Client-Side Export Completion Gap:** All export runners (unDateRangeExport, unSingleDateExport, unEnergyExport, unForecastActualExport, unSolcastWeekAheadExport, unDailyDataExport, unDailyReportExport, _snbHandleMigExport) relied entirely on Electron's native folder open IPC rather than initiating a standard browser download for web/mobile clients.

---

## 3. Resolution & Architectural Changes

### A. Dual GET & POST Artifact Route (server/index.js)
Updated the export artifact handler to accept both GET and POST at /api/export/artifact and /api/export/download:
- Supports query parameters (?relativePath=..., ?file=..., ?path=...) as well as POST JSON payloads.
- Validates the requested path against the configured export directory.
- Sets explicit headers:
  - Content-Type: application/octet-stream
  - Content-Disposition: attachment; filename="<fileName>"
  - Content-Length: <fileSize>
  - x-export-relative-path: <relPath>
- Correctly proxies through to remote gateways when operating in Remote Client mode.

### B. Universal Export Completion Handler (public/js/app.js & rontend/public/js/app.js)
Implemented handleExportSuccess(exportResult, resultElementId, customPrefix):
- **Desktop Electron App:** Retains native directory reveal in Windows Explorer (openExportPathFolder).
- **Mobile & Web Clients:**
  1. Immediately triggers an automatic programmatic download (	riggerBrowserFileDownload) into the device's native **Downloads** folder.
  2. Renders a prominent, mobile-friendly **[📥 Download]** tap button in the export card result box so users can re-download at any time.

### C. Wired All 8 Export Pipelines
- unDateRangeExport (Alarms date range, Parameter history date range)
- unSingleDateExport (Alarms single date, Parameter history single date)
- unEnergyExport (Daily energy summaries)
- unForecastActualExport (Day-ahead forecast comparison & average-tables)
- unSolcastWeekAheadExport (Week-ahead forecast)
- unDailyDataExport (All-inverter node parameters)
- unDailyReportExport (Multi-day plant operational report)
- _snbHandleMigExport (Power module / measurement board relocation logs)

### D. Mobile-Aware Settings Guidance
Updated pickExportFolder() and openExportFolder():
- On mobile devices, explains that exported files save directly to the device's Downloads folder / Files app.
- On desktop web browsers, prompts for the server storage directory when needed.

---

## 4. Verification Evidence
1. **JavaScript Syntax:** 
ode --check server/index.js, public/js/app.js, and rontend/public/js/app.js passed with 0 errors.
2. **Smoke Test Suite:** 
ode scripts/smoke-all.js --skip-python --no-rebuild passed 115 / 115 test suites in 50,057 ms.
3. **Asset Synchronization:** All changes in public/ perfectly mirrored in rontend/public/. Version query strings incremented (pp.js?v=2.1.11, style.css?v=2.1.5).