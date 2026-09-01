; installer.nsh — v2.8.10 power-loss resilience (Phase B2)
;
; Seeds %PROGRAMDATA%\Inverter-Dashboard\updates\last-good-installer.exe
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

  ; -------------------------------------------------------------------------
  ; Legacy Data Migration (v2.0 Root Transition)
  ; -------------------------------------------------------------------------
  ; 1. If running silently (/S), do not block with an interactive prompt
  IfSilent skipLegacyMigration

  ; 2. Check if legacy data exists in any standard legacy location
  IfFileExists "$0\InverterDashboard\db\adsi.db" legacyFound
  IfFileExists "$0\InverterDashboard\adsi.db" legacyFound
  IfFileExists "$0\InverterDashboard\archive\*.db" legacyFound
  IfFileExists "$0\InverterDashboard\forecast\*.*" legacyFound
  Goto skipLegacyMigration

legacyFound:
  ; If new database already exists, prompt with non-destructive merge notice; otherwise standard prompt
  IfFileExists "$0\Inverter-Dashboard\db\adsi.db" promptExisting promptFresh

promptExisting:
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "Legacy Inverter Dashboard data was detected at:$\r$\n$0\InverterDashboard$\r$\n$\r$\nInverter-Dashboard already exists on this PC.$\r$\nWould you like to import any missing monthly archive shards, AI forecast models, weather history, or configurations without overwriting your existing data?" \
    IDNO skipLegacyMigration
  Goto doMigrate

promptFresh:
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "Legacy Inverter Dashboard data was detected at:$\r$\n$0\InverterDashboard$\r$\n$\r$\nWould you like to import your historical telemetry database, monthly archive shards, inverter configuration, AI forecast models, and weather history into this installation?" \
    IDNO skipLegacyMigration

doMigrate:
  DetailPrint "Smartly migrating legacy data from $0\InverterDashboard..."
  CreateDirectory "$0\Inverter-Dashboard"
  CreateDirectory "$0\Inverter-Dashboard\db"
  CreateDirectory "$0\Inverter-Dashboard\db\archive"
  CreateDirectory "$0\Inverter-Dashboard\db\backups"
  CreateDirectory "$0\Inverter-Dashboard\forecast"
  CreateDirectory "$0\Inverter-Dashboard\forecast\context"
  CreateDirectory "$0\Inverter-Dashboard\forecast\context\global"
  CreateDirectory "$0\Inverter-Dashboard\forecast\snapshots"
  CreateDirectory "$0\Inverter-Dashboard\forecast\replay_results"
  CreateDirectory "$0\Inverter-Dashboard\weather"
  CreateDirectory "$0\Inverter-Dashboard\license"
  CreateDirectory "$0\Inverter-Dashboard\auth"

  ; -------------------------------------------------------------------------
  ; 1. Primary Database (adsi.db + WAL/SHM)
  ; Only copy if destination adsi.db does NOT exist
  ; -------------------------------------------------------------------------
  IfFileExists "$0\Inverter-Dashboard\db\adsi.db" skipPrimaryDb

  IfFileExists "$0\InverterDashboard\db\adsi.db" 0 checkRootLegacyDb
  CopyFiles /SILENT "$0\InverterDashboard\db\adsi.db*" "$0\Inverter-Dashboard\db\"
  Goto skipPrimaryDb

checkRootLegacyDb:
  IfFileExists "$0\InverterDashboard\adsi.db" 0 skipPrimaryDb
  CopyFiles /SILENT "$0\InverterDashboard\adsi.db*" "$0\Inverter-Dashboard\db\"

skipPrimaryDb:

  ; -------------------------------------------------------------------------
  ; 2. Topology Configuration (ipconfig.json)
  ; Only copy if destination ipconfig.json does NOT exist
  ; -------------------------------------------------------------------------
  IfFileExists "$0\Inverter-Dashboard\db\ipconfig.json" skipIpConfig

  IfFileExists "$0\InverterDashboard\db\ipconfig.json" copyDbIp
  IfFileExists "$0\InverterDashboard\config\ipconfig.json" copyCfgIp
  IfFileExists "$0\InverterDashboard\ipconfig.json" copyRootIp
  Goto skipIpConfig

copyDbIp:
  CopyFiles /SILENT "$0\InverterDashboard\db\ipconfig.json" "$0\Inverter-Dashboard\db\ipconfig.json"
  Goto skipIpConfig

copyCfgIp:
  CopyFiles /SILENT "$0\InverterDashboard\config\ipconfig.json" "$0\Inverter-Dashboard\db\ipconfig.json"
  Goto skipIpConfig

copyRootIp:
  CopyFiles /SILENT "$0\InverterDashboard\ipconfig.json" "$0\Inverter-Dashboard\db\ipconfig.json"

skipIpConfig:

  ; -------------------------------------------------------------------------
  ; 3. Historical Monthly Shards (*.db)
  ; Check each shard individually; only copy shards missing in destination
  ; -------------------------------------------------------------------------
  FindFirst $1 $2 "$0\InverterDashboard\archive\*.db"
loopShardsA:
  StrCmp $2 "" doneShardsA
  IfFileExists "$0\Inverter-Dashboard\db\archive\$2" nextShardA
  CopyFiles /SILENT "$0\InverterDashboard\archive\$2*" "$0\Inverter-Dashboard\db\archive\"
nextShardA:
  FindNext $1 $2
  Goto loopShardsA
doneShardsA:
  FindClose $1

  FindFirst $1 $2 "$0\InverterDashboard\db\archive\*.db"
loopShardsB:
  StrCmp $2 "" doneShardsB
  IfFileExists "$0\Inverter-Dashboard\db\archive\$2" nextShardB
  CopyFiles /SILENT "$0\InverterDashboard\db\archive\$2*" "$0\Inverter-Dashboard\db\archive\"
nextShardB:
  FindNext $1 $2
  Goto loopShardsB
doneShardsB:
  FindClose $1

  ; -------------------------------------------------------------------------
  ; 4. AI/ML Forecast Models & State (forecast\*.joblib, ml_train_state.json)
  ; Only copy forecast files that do not exist in destination
  ; -------------------------------------------------------------------------
  FindFirst $1 $2 "$0\InverterDashboard\forecast\*.*"
loopForecastRoot:
  StrCmp $2 "" doneForecastRoot
  StrCmp $2 "." nextForecastRoot
  StrCmp $2 ".." nextForecastRoot
  IfFileExists "$0\InverterDashboard\forecast\$2\*.*" nextForecastRoot
  IfFileExists "$0\Inverter-Dashboard\forecast\$2" nextForecastRoot
  CopyFiles /SILENT "$0\InverterDashboard\forecast\$2" "$0\Inverter-Dashboard\forecast\"
nextForecastRoot:
  FindNext $1 $2
  Goto loopForecastRoot
doneForecastRoot:
  FindClose $1

  ; Forecast Snapshots (forecast\snapshots\*.json)
  FindFirst $1 $2 "$0\InverterDashboard\forecast\snapshots\*.json"
loopSnapshots:
  StrCmp $2 "" doneSnapshots
  IfFileExists "$0\Inverter-Dashboard\forecast\snapshots\$2" nextSnapshot
  CopyFiles /SILENT "$0\InverterDashboard\forecast\snapshots\$2" "$0\Inverter-Dashboard\forecast\snapshots\"
nextSnapshot:
  FindNext $1 $2
  Goto loopSnapshots
doneSnapshots:
  FindClose $1

  ; Forecast Diurnal Context (forecast\context\global\global.json)
  IfFileExists "$0\Inverter-Dashboard\forecast\context\global\global.json" skipGlobalCtx
  IfFileExists "$0\InverterDashboard\forecast\context\global\global.json" 0 skipGlobalCtx
  CopyFiles /SILENT "$0\InverterDashboard\forecast\context\global\global.json" "$0\Inverter-Dashboard\forecast\context\global\"
skipGlobalCtx:

  ; -------------------------------------------------------------------------
  ; 5. Historical Weather Logs & Caches (weather\*.csv)
  ; Only copy weather CSV logs missing in destination
  ; -------------------------------------------------------------------------
  FindFirst $1 $2 "$0\InverterDashboard\weather\*.csv"
loopWeather:
  StrCmp $2 "" doneWeather
  IfFileExists "$0\Inverter-Dashboard\weather\$2" nextWeather
  CopyFiles /SILENT "$0\InverterDashboard\weather\$2" "$0\Inverter-Dashboard\weather\"
nextWeather:
  FindNext $1 $2
  Goto loopWeather
doneWeather:
  FindClose $1

  ; -------------------------------------------------------------------------
  ; 6. License and Activation State
  ; -------------------------------------------------------------------------
  IfFileExists "$0\Inverter-Dashboard\license\license-state.json" skipLicenseState
  IfFileExists "$0\InverterDashboard\license\license-state.json" 0 skipLicenseState
  CopyFiles /SILENT "$0\InverterDashboard\license\license-state.json" "$0\Inverter-Dashboard\license\"
skipLicenseState:

  IfFileExists "$0\Inverter-Dashboard\license\license.dat" skipLicenseDat
  IfFileExists "$0\InverterDashboard\license\license.dat" 0 skipLicenseDat
  CopyFiles /SILENT "$0\InverterDashboard\license\license.dat" "$0\Inverter-Dashboard\license\"
skipLicenseDat:

  ; -------------------------------------------------------------------------
  ; 7. Auth Tokens & Secret Keyring
  ; -------------------------------------------------------------------------
  IfFileExists "$0\Inverter-Dashboard\auth\cloud_tokens.enc" skipCloudTokens
  IfFileExists "$0\InverterDashboard\auth\cloud_tokens.enc" 0 skipCloudTokens
  CopyFiles /SILENT "$0\InverterDashboard\auth\cloud_tokens.enc" "$0\Inverter-Dashboard\auth\"
skipCloudTokens:

  IfFileExists "$0\Inverter-Dashboard\db\.token-keyring" skipTokenKeyring
  IfFileExists "$0\InverterDashboard\auth\.token-keyring" copyAuthKeyring
  IfFileExists "$0\InverterDashboard\db\.token-keyring" copyDbKeyring
  Goto skipTokenKeyring
copyAuthKeyring:
  CopyFiles /SILENT "$0\InverterDashboard\auth\.token-keyring" "$0\Inverter-Dashboard\db\.token-keyring"
  Goto skipTokenKeyring
copyDbKeyring:
  CopyFiles /SILENT "$0\InverterDashboard\db\.token-keyring" "$0\Inverter-Dashboard\db\.token-keyring"
skipTokenKeyring:

  ; -------------------------------------------------------------------------
  ; 8. Auto-Reset, Service Config & Backup Metadata
  ; -------------------------------------------------------------------------
  IfFileExists "$0\Inverter-Dashboard\autoreset.json" skipAutoreset
  IfFileExists "$0\InverterDashboard\autoreset.json" 0 skipAutoreset
  CopyFiles /SILENT "$0\InverterDashboard\autoreset.json" "$0\Inverter-Dashboard\autoreset.json"
skipAutoreset:

  IfFileExists "$0\Inverter-Dashboard\server-service-config.json" skipServiceConfig
  IfFileExists "$0\InverterDashboard\server-service-config.json" 0 skipServiceConfig
  CopyFiles /SILENT "$0\InverterDashboard\server-service-config.json" "$0\Inverter-Dashboard\server-service-config.json"
skipServiceConfig:

  IfFileExists "$0\Inverter-Dashboard\backup_history.json" skipBackupHistory
  IfFileExists "$0\InverterDashboard\backup_history.json" 0 skipBackupHistory
  CopyFiles /SILENT "$0\InverterDashboard\backup_history.json" "$0\Inverter-Dashboard\backup_history.json"
skipBackupHistory:

  IfFileExists "$0\Inverter-Dashboard\db\backupHealth.json" skipBackupHealth
  IfFileExists "$0\InverterDashboard\db\backupHealth.json" 0 skipBackupHealth
  CopyFiles /SILENT "$0\InverterDashboard\db\backupHealth.json" "$0\Inverter-Dashboard\db\backupHealth.json"
skipBackupHealth:

  DetailPrint "Legacy data migration completed successfully."

skipLegacyMigration:

  ; Older builds and Windows compatibility troubleshooting could leave a
  ; persistent RUNASADMIN layer behind. That registry layer overrides the
  ; new asInvoker manifest and prevents medium-integrity Hikvision
  ; LocalService from embedding video. Remove only this product's current
  ; and legacy executable values before electron-builder launches the app.
  DeleteRegValue HKCU "Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers" "$INSTDIR\Inverter Dashboard.exe"
  DeleteRegValue HKLM "Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers" "$INSTDIR\Inverter Dashboard.exe"
  DeleteRegValue HKCU "Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers" "$INSTDIR\ADSI Inverter Dashboard.exe"
  DeleteRegValue HKLM "Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers" "$INSTDIR\ADSI Inverter Dashboard.exe"
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
