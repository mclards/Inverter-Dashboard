; installer.nsh — v2.8.10 power-loss resilience (Phase B2)
;
; Seeds %PROGRAMDATA%\InverterDashboard\updates\last-good-installer.exe
; with a copy of the current installer at install time. This guarantees a
; fresh install has a local installer available for offline recovery even
; before the first auto-update cycle runs.
;
; Wired via package.json "build.nsis.include": "scripts/installer.nsh".
; electron-builder injects this into the generated NSIS script.
;
; PROGRAMDATA resolves via $APPDATA\..\..\ProgramData on Windows — we use
; explicit environment lookup ($%PROGRAMDATA%) for clarity and correctness
; on Windows 10/11 under both standard and domain profiles.

!macro customInstall
  ; %PROGRAMDATA% is the per-machine shared data root (C:\ProgramData)
  ReadEnvStr $0 "PROGRAMDATA"
  StrCmp $0 "" skipStash 0

  ; Ensure updates directory exists
  CreateDirectory "$0\Inverter-Dashboard"
  CreateDirectory "$0\Inverter-Dashboard\updates"

  ; Older builds and Windows compatibility troubleshooting could leave a
  ; persistent RUNASADMIN layer behind. That registry layer overrides the
  ; new asInvoker manifest and prevents medium-integrity Hikvision
  ; LocalService from embedding video. Remove only this product's current
  ; and legacy executable values before electron-builder launches the app.
  DeleteRegValue HKCU "Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers" "$INSTDIR\Inverter Dashboard.exe"
  DeleteRegValue HKLM "Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers" "$INSTDIR\Inverter Dashboard.exe"
  DeleteRegValue HKCU "Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers" "$PROGRAMFILES64\ADSI Inverters Dashboard\ADSI Inverters Dashboard.exe"
  DeleteRegValue HKLM "Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers" "$PROGRAMFILES64\ADSI Inverters Dashboard\ADSI Inverters Dashboard.exe"
  DeleteRegValue HKCU "Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers" "$PROGRAMFILES64\ADSI Plant Dashboard\ADSI Plant Dashboard.exe"
  DeleteRegValue HKLM "Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers" "$PROGRAMFILES64\ADSI Plant Dashboard\ADSI Plant Dashboard.exe"

  ; The installed dashboard deliberately runs at the caller's normal
  ; integrity level so Hikvision LocalService can embed its native video
  ; child window. The installer is still elevated for this per-machine ACL.
  ; Grant the built-in Users group (language-neutral SID) modify access to
  ; the shared runtime tree before the non-elevated dashboard is launched.
  nsExec::ExecToLog '"$SYSDIR\icacls.exe" "$0\Inverter-Dashboard" /grant *S-1-5-32-545:(OI)(CI)M /T /Q'
  Pop $1
  StrCmp $1 "0" aclReady 0
  DetailPrint "WARNING: Could not grant Users modify access to the data directory (icacls exit $1)"
  aclReady:

  ; Copy the currently-running installer to the recovery stash location.
  ; $EXEPATH is NSIS's canonical path of this installer's own EXE.
  CopyFiles /SILENT "$EXEPATH" "$0\Inverter-Dashboard\updates\last-good-installer.exe"
  DetailPrint "Seeded recovery installer at $0\Inverter-Dashboard\updates\last-good-installer.exe"

  skipStash:
!macroend

!macro customUnInstall
  ; Do NOT delete the stashed installer on uninstall — the operator may
  ; want to reinstall later without downloading. The stash lives in
  ; ProgramData which survives uninstall per our deleteAppDataOnUninstall=false.
!macroend
