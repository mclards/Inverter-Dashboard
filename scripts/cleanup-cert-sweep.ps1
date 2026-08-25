# One-shot cleanup sweep to ensure no code signing cert artifacts remain in any Windows cert store.
$thumb = '44CD054E69D04011DAA8FB2B60127F1F6EB99C0E'
$stores = @(
    'Cert:\CurrentUser\My',
    'Cert:\CurrentUser\Root',
    'Cert:\CurrentUser\CA',
    'Cert:\CurrentUser\AuthRoot',
    'Cert:\CurrentUser\TrustedPublisher',
    'Cert:\LocalMachine\My',
    'Cert:\LocalMachine\Root',
    'Cert:\LocalMachine\CA',
    'Cert:\LocalMachine\AuthRoot',
    'Cert:\LocalMachine\TrustedPublisher'
)

$foundCount = 0
$removedCount = 0

foreach ($store in $stores) {
    $certs = Get-ChildItem -Path $store -ErrorAction SilentlyContinue | Where-Object { $_.Thumbprint -eq $thumb }
    if ($certs) {
        foreach ($c in $certs) {
            $foundCount++
            $path = Join-Path $store $c.Thumbprint
            Write-Host ("[!] FOUND in {0}" -f $store)
            try {
                Remove-Item -Path $path -Force -ErrorAction Stop
                Write-Host ("    REMOVED") -ForegroundColor Green
                $removedCount++
            } catch {
                Write-Host ("    REMOVE FAILED: {0}" -f $_.Exception.Message) -ForegroundColor Red
            }
        }
    }
}

Write-Host ""
if ($foundCount -eq 0) {
    Write-Host "[+] ALL CLEAN - no cert artifacts in any store" -ForegroundColor Green
} else {
    Write-Host ("[*] Found {0}, removed {1}" -f $foundCount, $removedCount)
}
