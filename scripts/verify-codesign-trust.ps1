# Verifies that the ADSI Inverter Dashboard codesign root certificate is
# correctly installed in Trusted Root Certification Authorities on this machine.
#
# Run on the gateway AFTER importing build/private/codesign.cer.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/verify-codesign-trust.ps1
#
# Exits 0 if cert is trusted, 1 if not.

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$ThumbPath = Join-Path $RepoRoot "build\private\codesign-thumbprint.txt"
$CerPath = Join-Path $RepoRoot "build\private\codesign.cer"

if (-not (Test-Path $ThumbPath)) {
    Write-Host "[!] Cannot find $ThumbPath" -ForegroundColor Red
    Write-Host "    Run 'npm run codesign:generate' first." -ForegroundColor Yellow
    exit 1
}

$thumbprint = (Get-Content $ThumbPath -Raw).Trim().ToUpper()
Write-Host "[*] Looking for certificate with thumbprint: $thumbprint" -ForegroundColor Cyan

# Check both LocalMachine\Root (preferred) and CurrentUser\Root (fallback)
$found = $false
$location = ""

foreach ($store in @("Cert:\LocalMachine\Root", "Cert:\CurrentUser\Root")) {
    $cert = Get-ChildItem -Path $store -ErrorAction SilentlyContinue | Where-Object { $_.Thumbprint -eq $thumbprint }
    if ($cert) {
        $found = $true
        $location = $store
        Write-Host "[+] Certificate found in $store" -ForegroundColor Green
        Write-Host "    Subject:    $($cert.Subject)"
        Write-Host "    Issuer:     $($cert.Issuer)"
        Write-Host "    NotBefore:  $($cert.NotBefore)"
        Write-Host "    NotAfter:   $($cert.NotAfter)"
        Write-Host "    HasPrivKey: $($cert.HasPrivateKey)"
        break
    }
}

if (-not $found) {
    Write-Host "[!] Certificate NOT found in any Trusted Root store on this machine" -ForegroundColor Red
    Write-Host ""
    Write-Host "    Install it now with one of these methods:" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "    A) GUI:" -ForegroundColor Yellow
    Write-Host "       Right-click $CerPath"
    Write-Host "       -> Install Certificate"
    Write-Host "       -> Local Machine"
    Write-Host "       -> 'Place all certificates in the following store'"
    Write-Host "       -> Browse -> Trusted Root Certification Authorities"
    Write-Host "       -> OK"
    Write-Host ""
    Write-Host "    B) PowerShell (run as Administrator):" -ForegroundColor Yellow
    Write-Host "       Import-Certificate -FilePath '$CerPath' -CertStoreLocation 'Cert:\LocalMachine\Root'"
    Write-Host ""
    exit 1
}

# Now verify trust by signing test file (if a signed binary is around)
$testBinary = Join-Path $RepoRoot "release\Inverter-Dashboard-Setup-*.exe"
$existingBinary = Get-ChildItem -Path $testBinary -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1

if ($existingBinary) {
    Write-Host ""
    Write-Host "[*] Verifying trust on actual installer: $($existingBinary.Name)" -ForegroundColor Cyan
    $signtool = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin\*\x64\signtool.exe' -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1
    if ($signtool) {
        & $signtool.FullName verify /pa $existingBinary.FullName
        if ($LASTEXITCODE -eq 0) {
            Write-Host "[+] Signature verified against trusted root" -ForegroundColor Green
        } else {
            Write-Host "[!] Signature did NOT verify against trusted root" -ForegroundColor Red
            Write-Host "    Cert is in the store ($location) but trust chain still fails." -ForegroundColor Yellow
            Write-Host "    Make sure it's in 'Trusted Root Certification Authorities', not 'Personal'." -ForegroundColor Yellow
            exit 1
        }
    } else {
        Write-Host "[~] signtool.exe not available; skipping signature verification" -ForegroundColor Yellow
    }
} else {
    Write-Host ""
    Write-Host "[~] No installer found in release/ to verify against" -ForegroundColor Yellow
    Write-Host "    Build one with 'npm run build:installer:signed' to test the full chain" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "================================================================" -ForegroundColor Green
Write-Host "  TRUST CHECK PASSED" -ForegroundColor Green
Write-Host "================================================================" -ForegroundColor Green
exit 0
