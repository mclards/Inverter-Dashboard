; installer.nsh - installer recovery, ACL, and verified legacy-import request.
;
; Legacy data is never merged with CopyFiles here. NSIS has no transactional
; SQLite API and cannot safely decide whether same-named databases/configs are
; identical. When the operator opts in, NSIS writes a request marker. On the
; first packaged-app launch, electron/legacyDataMigration.js snapshots,
; validates, compares, merges, backs up, and audits the legacy content before
; the dashboard opens its canonical database.

!macro customInstall
  ReadEnvStr $0 "PROGRAMDATA"
  StrCmp $0 "" skipStash 0

  CreateDirectory "$0\Inverter-Dashboard"
  CreateDirectory "$0\Inverter-Dashboard\updates"

  ; Silent upgrades must not import data from a separate product without an
  ; operator decision. An earlier accepted request is left intact for retry.
  IfSilent skipLegacyMigration

  ; Detect every legacy family supported by the application-side importer.
  IfFileExists "$0\InverterDashboard\db\*.*" legacyFound
  IfFileExists "$0\InverterDashboard\archive\*.*" legacyFound
  IfFileExists "$0\InverterDashboard\forecast\*.*" legacyFound
  IfFileExists "$0\InverterDashboard\weather\*.*" legacyFound
  IfFileExists "$0\InverterDashboard\license\*.*" legacyFound
  IfFileExists "$0\InverterDashboard\auth\*.*" legacyFound
  IfFileExists "$0\InverterDashboard\config\ipconfig.json" legacyFound
  IfFileExists "$0\InverterDashboard\adsi.db" legacyFound
  IfFileExists "$0\InverterDashboard\ipconfig.json" legacyFound
  IfFileExists "$0\InverterDashboard\autoreset.json" legacyFound
  IfFileExists "$0\InverterDashboard\server-service-config.json" legacyFound
  IfFileExists "$0\InverterDashboard\backup_history.json" legacyFound
  IfFileExists "$0\InverterDashboard\cloud_tokens.enc" legacyFound
  Goto skipLegacyMigration

legacyFound:
  IfFileExists "$0\Inverter-Dashboard\db\adsi.db" promptExisting promptFresh

promptExisting:
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "Legacy Inverter Dashboard data was detected at:$\r$\n$0\InverterDashboard$\r$\n$\r$\nInverter-Dashboard already contains data. Import verified missing database rows and files?$\r$\n$\r$\nCurrent settings remain authoritative. Differing files are retained as conflicts, and a rollback backup plus audit manifest will be created." \
    IDNO skipLegacyMigration
  Goto queueLegacyMigration

promptFresh:
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "Legacy Inverter Dashboard data was detected at:$\r$\n$0\InverterDashboard$\r$\n$\r$\nImport its validated databases, inverter topology, archive shards, forecast state, weather history, licensing, authentication state, and service configuration on first launch?$\r$\n$\r$\nThe source files will remain untouched and an audit manifest will be created." \
    IDNO skipLegacyMigration

queueLegacyMigration:
  CreateDirectory "$0\Inverter-Dashboard\migration"
  ClearErrors
  FileOpen $1 "$0\Inverter-Dashboard\migration\legacy-import-request-v1.txt" w
  IfErrors migrationRequestFailed
  FileWrite $1 "requested-by-nsis-v1$\r$\n"
  FileClose $1
  DetailPrint "Queued verified legacy-data migration for the first application launch."
  Goto skipLegacyMigration

migrationRequestFailed:
  DetailPrint "WARNING: Could not create the legacy-data migration request. No legacy data was changed."
  MessageBox MB_OK|MB_ICONEXCLAMATION \
    "The legacy-data migration could not be queued. No legacy data was changed. Please reinstall or contact support."

skipLegacyMigration:
  ; Remove persistent RUNASADMIN compatibility layers which prevent the
  ; medium-integrity Hikvision LocalService from embedding native video.
  DeleteRegValue HKCU "Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers" "$INSTDIR\Inverter Dashboard.exe"
  DeleteRegValue HKLM "Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers" "$INSTDIR\Inverter Dashboard.exe"
  DeleteRegValue HKCU "Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers" "$INSTDIR\ADSI Inverter Dashboard.exe"
  DeleteRegValue HKLM "Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers" "$INSTDIR\ADSI Inverter Dashboard.exe"
  DeleteRegValue HKCU "Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers" "$PROGRAMFILES64\ADSI Inverters Dashboard\ADSI Inverters Dashboard.exe"
  DeleteRegValue HKLM "Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers" "$PROGRAMFILES64\ADSI Inverters Dashboard\ADSI Inverters Dashboard.exe"
  DeleteRegValue HKCU "Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers" "$PROGRAMFILES64\ADSI Plant Dashboard\ADSI Plant Dashboard.exe"
  DeleteRegValue HKLM "Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers" "$PROGRAMFILES64\ADSI Plant Dashboard\ADSI Plant Dashboard.exe"

  ; Grant standard users modify access to the shared runtime tree.
  nsExec::ExecToLog '"$SYSDIR\icacls.exe" "$0\Inverter-Dashboard" /grant *S-1-5-32-545:(OI)(CI)M /T /Q'
  Pop $1
  StrCmp $1 "0" aclReady 0
  DetailPrint "WARNING: Could not grant Users modify access to the data directory (icacls exit $1)"
aclReady:

  ; Seed the offline recovery installer.
  CopyFiles /SILENT "$EXEPATH" "$0\Inverter-Dashboard\updates\last-good-installer.exe"
  DetailPrint "Seeded recovery installer at $0\Inverter-Dashboard\updates\last-good-installer.exe"

skipStash:
!macroend

!macro customUnInstall
  ; ProgramData survives uninstall; retain the recovery installer and data.
!macroend
