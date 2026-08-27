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
Write-Log "  ADSI Inverter Dashboard — Legacy to v2.0 Data Replication"
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

Write-Log "Discovered Source Artifacts:"
Write-Log "  • Primary Database: $(if ($sourceDb) { "$sourceDb ($([Math]::Round((Get-Item $sourceDb).Length / 1MB, 2)) MB)" } else { '[NOT FOUND]' })"
Write-Log "  • Topology Config : $(if ($sourceIpconfig) { $sourceIpconfig } else { '[NOT FOUND]' })"
Write-Log "  • Archive Shards  : $(if ($sourceArchiveDir) { "$sourceArchiveDir ($archiveCount shard files)" } else { '[NOT FOUND]' })"
Write-Log "  • Auto-Reset      : $(if ($sourceAutoreset) { $sourceAutoreset } else { '[NONE]' })"
Write-Log "  • Service Config  : $(if ($sourceServiceConfig) { $sourceServiceConfig } else { '[NONE]' })"

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
    if ($destExists -and -not $DryRun) {
        $ts = Get-Date -Format "yyyyMMdd_HHmmss"
        $fileName = [System.IO.Path]::GetFileName($DestinationPath)
        $bakPath = [System.IO.Path]::Combine($targetBackupsDir, "$($fileName).bak_$ts")
        Copy-Item -LiteralPath $DestinationPath -Destination $bakPath -Force
        Write-Log "Backed up existing $Description to: $bakPath" "WARN"
    }

    if ($DryRun) {
        Write-Log "[DRY-RUN] Would copy: $SourcePath -> $DestinationPath"
    } else {
        Copy-Item -LiteralPath $SourcePath -Destination $DestinationPath -Force
        $copiedLen = (Get-Item -LiteralPath $DestinationPath).Length
        Write-Log "Replicated $Description ($([Math]::Round($copiedLen / 1MB, 2)) MB)" "SUCCESS"
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
        $invCount = if ($jsonContent.inverters) { ($jsonContent.inverters | Get-Member -MemberType NoteProperty).Count } else { 0 }
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
        Copy-ArtifactSafely -SourcePath $shard.FullName -DestinationPath $destShard -Description "Archive Shard ($($shard.Name))"
    }
}

# ------------------------------------------------------------------------------
# 8. Replicate Auto-Reset & Service Configurations
# ------------------------------------------------------------------------------
if ($sourceAutoreset) {
    $destAuto = [System.IO.Path]::Combine($TargetRoot, "autoreset.json")
    Copy-ArtifactSafely -SourcePath $sourceAutoreset -DestinationPath $destAuto -Description "Auto-Reset Config"
}

if ($sourceServiceConfig) {
    $destSrv = [System.IO.Path]::Combine($TargetRoot, "server-service-config.json")
    Copy-ArtifactSafely -SourcePath $sourceServiceConfig -DestinationPath $destSrv -Description "Service Config"
}

# ------------------------------------------------------------------------------
# 9. Verification & Summary
# ------------------------------------------------------------------------------
Write-Log "----------------------------------------------------------------"
Write-Log "Replication Finished!" "SUCCESS"
Write-Log "Target Data Summary (C:\ProgramData\Inverter-Dashboard\):"

if (-not $DryRun) {
    $targetItems = @(Get-ChildItem -Path $TargetRoot -Recurse -File | Where-Object { $_.FullName -notmatch '\\backups\\' })
    foreach ($item in $targetItems) {
        $relPath = $item.FullName.Substring($TargetRoot.Length + 1)
        $sizeStr = if ($item.Length -ge 1MB) { "$([Math]::Round($item.Length / 1MB, 2)) MB" } else { "$([Math]::Round($item.Length / 1KB, 2)) KB" }
        Write-Log "  ✓ $relPath ($sizeStr)"
    }
}

Write-Log "================================================================"
Write-Log "Source '$SourceRoot' was preserved 100% read-only and untouched."
Write-Log "You can now launch Inverter Dashboard 2.0 on the SCADA PC."
Write-Log "================================================================"
