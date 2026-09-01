# ==============================================================================
# Replicate Legacy Inverter Dashboard Data to v2.0 Root
# Target Platform: Windows SCADA PC
# Source: C:\ProgramData\InverterDashboard\
# Destination: C:\ProgramData\Inverter-Dashboard\
# ==============================================================================

[CmdletBinding()]
param (
    [string]$SourceRoot = "C:\ProgramData\InverterDashboard",
    [string]$TargetRoot = "C:\ProgramData\Inverter-Dashboard",
    [switch]$DryRun,
    [switch]$Force
)

$ErrorActionPreference = "Stop"

function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $color = switch ($Level) {
        "SUCCESS" { "Green" }
        "WARN"    { "Yellow" }
        "ERROR"   { "Red" }
        default   { "Cyan" }
    }
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Write-Host "[$ts] [$Level] $Message" -ForegroundColor $color
}

Write-Log "================================================================"
Write-Log "  ADSI Inverter Dashboard -- Legacy to v2.0 Data Replication"
Write-Log "================================================================"
Write-Log "Source Root     : $SourceRoot"
Write-Log "Destination Root: $TargetRoot"
if ($DryRun) {
    Write-Log "MODE            : DRY-RUN (no files will be written)" "WARN"
}

# ------------------------------------------------------------------------------
# 1. Verify Source Directory Existence
# ------------------------------------------------------------------------------
if (-not (Test-Path -LiteralPath $SourceRoot)) {
    Write-Log "Source root '$SourceRoot' was not found on this machine!" "ERROR"
    exit 1
}

# ------------------------------------------------------------------------------
# 2. Locate Source Components
# ------------------------------------------------------------------------------
$sourceDb = $null
$sourceIpconfig = $null
$sourceArchiveDir = $null
$sourceAutoreset = $null
$sourceServiceConfig = $null

# Find adsi.db
$dbCandidates = @(
    [System.IO.Path]::Combine($SourceRoot, "db", "adsi.db"),
    [System.IO.Path]::Combine($SourceRoot, "adsi.db")
)
foreach ($c in $dbCandidates) {
    if (Test-Path -LiteralPath $c) {
        $sourceDb = $c
        break
    }
}

# Find ipconfig.json
$ipCandidates = @(
    [System.IO.Path]::Combine($SourceRoot, "db", "ipconfig.json"),
    [System.IO.Path]::Combine($SourceRoot, "config", "ipconfig.json"),
    [System.IO.Path]::Combine($SourceRoot, "ipconfig.json")
)
foreach ($c in $ipCandidates) {
    if (Test-Path -LiteralPath $c) {
        $sourceIpconfig = $c
        break
    }
}

# Find archive folder
$archiveCandidates = @(
    [System.IO.Path]::Combine($SourceRoot, "db", "archive"),
    [System.IO.Path]::Combine($SourceRoot, "archive")
)
foreach ($c in $archiveCandidates) {
    if (Test-Path -LiteralPath $c) {
        $sourceArchiveDir = $c
        break
    }
}

# Find autoreset.json
$autoCandidates = @(
    [System.IO.Path]::Combine($SourceRoot, "autoreset.json"),
    [System.IO.Path]::Combine($SourceRoot, "db", "autoreset.json")
)
foreach ($c in $autoCandidates) {
    if (Test-Path -LiteralPath $c) {
        $sourceAutoreset = $c
        break
    }
}

# Find server-service-config.json
$srvCandidates = @(
    [System.IO.Path]::Combine($SourceRoot, "server-service-config.json"),
    [System.IO.Path]::Combine($SourceRoot, "db", "server-service-config.json")
)
foreach ($c in $srvCandidates) {
    if (Test-Path -LiteralPath $c) {
        $sourceServiceConfig = $c
        break
    }
}

$archiveCount = 0
if ($sourceArchiveDir -and (Test-Path -LiteralPath $sourceArchiveDir)) {
    $archiveCount = @(Get-ChildItem -Path $sourceArchiveDir -Filter '*.db' -File -ErrorAction SilentlyContinue).Count
}

$sourceDbMb = 0
$primaryDbInfo = "[NOT FOUND]"
if ($sourceDb) {
    $sourceDbMb = [Math]::Round((Get-Item $sourceDb).Length / 1MB, 2)
    $primaryDbInfo = "$sourceDb [$sourceDbMb MB]"
}

$archiveInfo = "[NOT FOUND]"
if ($sourceArchiveDir) {
    $archiveInfo = "$sourceArchiveDir [$archiveCount shard files]"
}

$topoInfo = "[NOT FOUND]"
if ($sourceIpconfig) {
    $topoInfo = $sourceIpconfig
}

$autoInfo = "[NONE]"
if ($sourceAutoreset) {
    $autoInfo = $sourceAutoreset
}

$srvInfo = "[NONE]"
if ($sourceServiceConfig) {
    $srvInfo = $sourceServiceConfig
}

Write-Log "Discovered Source Artifacts:"
Write-Log "  * Primary Database: $primaryDbInfo"
Write-Log "  * Topology Config : $topoInfo"
Write-Log "  * Archive Shards  : $archiveInfo"
Write-Log "  * Auto-Reset      : $autoInfo"
Write-Log "  * Service Config  : $srvInfo"

if (-not $sourceDb -and -not $sourceIpconfig) {
    Write-Log "No database or ipconfig found in $SourceRoot. Nothing to replicate." "ERROR"
    exit 1
}

# ------------------------------------------------------------------------------
# 3. Create v2.0 Target Directories
# ------------------------------------------------------------------------------
$targetDbDir = [System.IO.Path]::Combine($TargetRoot, "db")
$targetArchiveDir = [System.IO.Path]::Combine($targetDbDir, "archive")
$targetBackupsDir = [System.IO.Path]::Combine($targetDbDir, "backups")

if (-not $DryRun) {
    foreach ($d in @($TargetRoot, $targetDbDir, $targetArchiveDir, $targetBackupsDir)) {
        if (-not (Test-Path -LiteralPath $d)) {
            New-Item -Path $d -ItemType Directory -Force | Out-Null
            Write-Log "Created directory: $d"
        }
    }
}

# ------------------------------------------------------------------------------
# 4. Helper Function for Safe Copy with Existing Backup
# ------------------------------------------------------------------------------
function Copy-ArtifactSafely {
    param(
        [string]$SourcePath,
        [string]$DestinationPath,
        [string]$Description
    )
    if (-not (Test-Path -LiteralPath $SourcePath)) { return }

    $destExists = Test-Path -LiteralPath $DestinationPath
    if ($destExists) {
        if (-not $Force) {
            Write-Log "Skipping existing $Description (already present at target)" "INFO"
            return
        }
        if (-not $DryRun) {
            $ts = Get-Date -Format "yyyyMMdd_HHmmss"
            $fileName = [System.IO.Path]::GetFileName($DestinationPath)
            $bakPath = [System.IO.Path]::Combine($targetBackupsDir, "$fileName.bak_$ts")
            Copy-Item -LiteralPath $DestinationPath -Destination $bakPath -Force
            Write-Log "Backed up existing $Description to: $bakPath" "WARN"
        }
    }

    if ($DryRun) {
        Write-Log "[DRY-RUN] Would copy: $SourcePath -> $DestinationPath"
    } else {
        Copy-Item -LiteralPath $SourcePath -Destination $DestinationPath -Force
        $copiedLen = (Get-Item -LiteralPath $DestinationPath).Length
        $copiedMb = [Math]::Round($copiedLen / 1MB, 2)
        Write-Log "Replicated $Description [$copiedMb MB]" "SUCCESS"
    }
}

# ------------------------------------------------------------------------------
# 5. Replicate Primary Database (adsi.db and WAL if present)
# ------------------------------------------------------------------------------
if ($sourceDb) {
    $destDb = [System.IO.Path]::Combine($targetDbDir, "adsi.db")
    Copy-ArtifactSafely -SourcePath $sourceDb -DestinationPath $destDb -Description "Primary Database (adsi.db)"

    # Copy WAL and SHM if present
    $sourceWal = "$sourceDb-wal"
    $sourceShm = "$sourceDb-shm"
    if (Test-Path -LiteralPath $sourceWal) {
        Copy-ArtifactSafely -SourcePath $sourceWal -DestinationPath "$destDb-wal" -Description "SQLite WAL Journal"
    }
    if (Test-Path -LiteralPath $sourceShm) {
        Copy-ArtifactSafely -SourcePath $sourceShm -DestinationPath "$destDb-shm" -Description "SQLite SHM Index"
    }
}

# ------------------------------------------------------------------------------
# 6. Replicate Topology (ipconfig.json) & Validate Schema
# ------------------------------------------------------------------------------
if ($sourceIpconfig) {
    # Validate JSON before copying
    try {
        $jsonContent = Get-Content -LiteralPath $sourceIpconfig -Raw -Encoding UTF8 | ConvertFrom-Json
        $invCount = 0
        if ($jsonContent.inverters) {
            $invCount = ($jsonContent.inverters | Get-Member -MemberType NoteProperty).Count
        }
        Write-Log "Validated ipconfig.json: Contains $invCount inverter definitions." "SUCCESS"
    } catch {
        Write-Log "Warning: ipconfig.json could not be parsed as valid JSON: $_" "WARN"
    }

    $destIpconfig = [System.IO.Path]::Combine($targetDbDir, "ipconfig.json")
    Copy-ArtifactSafely -SourcePath $sourceIpconfig -DestinationPath $destIpconfig -Description "Topology Config (ipconfig.json)"
}

# ------------------------------------------------------------------------------
# 7. Replicate Archive Shards (*.db)
# ------------------------------------------------------------------------------
if ($sourceArchiveDir -and (Test-Path -LiteralPath $sourceArchiveDir)) {
    $shardFiles = @(Get-ChildItem -Path $sourceArchiveDir -Filter "*.db" -File -ErrorAction SilentlyContinue)
    foreach ($shard in $shardFiles) {
        $destShard = [System.IO.Path]::Combine($targetArchiveDir, $shard.Name)
        $shardName = $shard.Name
        Copy-ArtifactSafely -SourcePath $shard.FullName -DestinationPath $destShard -Description "Archive Shard [$shardName]"
    }
}

# ------------------------------------------------------------------------------
# 8. Replicate AI/ML Forecast, Weather, License & Auth
# ------------------------------------------------------------------------------
$sourceForecastDir = [System.IO.Path]::Combine($SourceRoot, "forecast")
if (Test-Path -LiteralPath $sourceForecastDir) {
    $forecastFiles = @(Get-ChildItem -Path $sourceForecastDir -Recurse -File -ErrorAction SilentlyContinue)
    foreach ($f in $forecastFiles) {
        $rel = $f.FullName.Substring($sourceForecastDir.Length + 1)
        $destFile = [System.IO.Path]::Combine($TargetRoot, "forecast", $rel)
        $destParent = [System.IO.Path]::GetDirectoryName($destFile)
        if (-not (Test-Path -LiteralPath $destParent) -and -not $DryRun) {
            New-Item -Path $destParent -ItemType Directory -Force | Out-Null
        }
        Copy-ArtifactSafely -SourcePath $f.FullName -DestinationPath $destFile -Description "Forecast File ($rel)"
    }
}

$sourceWeatherDir = [System.IO.Path]::Combine($SourceRoot, "weather")
if (Test-Path -LiteralPath $sourceWeatherDir) {
    $weatherFiles = @(Get-ChildItem -Path $sourceWeatherDir -Recurse -File -ErrorAction SilentlyContinue)
    foreach ($f in $weatherFiles) {
        $rel = $f.FullName.Substring($sourceWeatherDir.Length + 1)
        $destFile = [System.IO.Path]::Combine($TargetRoot, "weather", $rel)
        $destParent = [System.IO.Path]::GetDirectoryName($destFile)
        if (-not (Test-Path -LiteralPath $destParent) -and -not $DryRun) {
            New-Item -Path $destParent -ItemType Directory -Force | Out-Null
        }
        Copy-ArtifactSafely -SourcePath $f.FullName -DestinationPath $destFile -Description "Weather File ($rel)"
    }
}

$sourceLicenseDir = [System.IO.Path]::Combine($SourceRoot, "license")
if (Test-Path -LiteralPath $sourceLicenseDir) {
    $licenseFiles = @(Get-ChildItem -Path $sourceLicenseDir -Recurse -File -ErrorAction SilentlyContinue)
    foreach ($f in $licenseFiles) {
        $rel = $f.FullName.Substring($sourceLicenseDir.Length + 1)
        $destFile = [System.IO.Path]::Combine($TargetRoot, "license", $rel)
        $destParent = [System.IO.Path]::GetDirectoryName($destFile)
        if (-not (Test-Path -LiteralPath $destParent) -and -not $DryRun) {
            New-Item -Path $destParent -ItemType Directory -Force | Out-Null
        }
        Copy-ArtifactSafely -SourcePath $f.FullName -DestinationPath $destFile -Description "License File ($rel)"
    }
}

$sourceAuthDir = [System.IO.Path]::Combine($SourceRoot, "auth")
if (Test-Path -LiteralPath $sourceAuthDir) {
    $authFiles = @(Get-ChildItem -Path $sourceAuthDir -Recurse -File -ErrorAction SilentlyContinue)
    foreach ($f in $authFiles) {
        $rel = $f.FullName.Substring($sourceAuthDir.Length + 1)
        $destFile = [System.IO.Path]::Combine($TargetRoot, "auth", $rel)
        $destParent = [System.IO.Path]::GetDirectoryName($destFile)
        if (-not (Test-Path -LiteralPath $destParent) -and -not $DryRun) {
            New-Item -Path $destParent -ItemType Directory -Force | Out-Null
        }
        Copy-ArtifactSafely -SourcePath $f.FullName -DestinationPath $destFile -Description "Auth File ($rel)"
    }
}

# ------------------------------------------------------------------------------
# 9. Replicate Auto-Reset, Backup Metadata & Service Configurations
# ------------------------------------------------------------------------------
if ($sourceAutoreset) {
    $destAuto = [System.IO.Path]::Combine($TargetRoot, "autoreset.json")
    Copy-ArtifactSafely -SourcePath $sourceAutoreset -DestinationPath $destAuto -Description "Auto-Reset Config"
}

if ($sourceServiceConfig) {
    $destSrv = [System.IO.Path]::Combine($TargetRoot, "server-service-config.json")
    Copy-ArtifactSafely -SourcePath $sourceServiceConfig -DestinationPath $destSrv -Description "Service Config"
}

$sourceBackupHist = [System.IO.Path]::Combine($SourceRoot, "backup_history.json")
if (Test-Path -LiteralPath $sourceBackupHist) {
    $destBackupHist = [System.IO.Path]::Combine($TargetRoot, "backup_history.json")
    Copy-ArtifactSafely -SourcePath $sourceBackupHist -DestinationPath $destBackupHist -Description "Backup History"
}

$sourceBackupHealth = [System.IO.Path]::Combine($SourceRoot, "db", "backupHealth.json")
if (Test-Path -LiteralPath $sourceBackupHealth) {
    $destBackupHealth = [System.IO.Path]::Combine($targetDbDir, "backupHealth.json")
    Copy-ArtifactSafely -SourcePath $sourceBackupHealth -DestinationPath $destBackupHealth -Description "Backup Health Metadata"
}

# ------------------------------------------------------------------------------
# 10. Verification & Summary
# ------------------------------------------------------------------------------
Write-Log "----------------------------------------------------------------"
Write-Log "Replication Finished!" "SUCCESS"
Write-Log "Target Data Summary (C:\ProgramData\Inverter-Dashboard\):"

if (-not $DryRun) {
    $targetItems = @(Get-ChildItem -Path $TargetRoot -Recurse -File | Where-Object { $_.FullName -notmatch '\\backups\\' })
    foreach ($item in $targetItems) {
        $relPath = $item.FullName.Substring($TargetRoot.Length + 1)
        $sizeStr = ""
        if ($item.Length -ge 1MB) {
            $mb = [Math]::Round($item.Length / 1MB, 2)
            $sizeStr = "$mb MB"
        } else {
            $kb = [Math]::Round($item.Length / 1KB, 2)
            $sizeStr = "$kb KB"
        }
        Write-Log "  [OK] $relPath [$sizeStr]"
    }
}

Write-Log "================================================================"
Write-Log "Source '$SourceRoot' was preserved 100% read-only and untouched."
Write-Log "You can now launch Inverter Dashboard 2.0 on the SCADA PC."
Write-Log "================================================================"
