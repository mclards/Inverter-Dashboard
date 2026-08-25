param(
  [Parameter(Mandatory=$true)][string]$Path,
  [string]$ExpectedThumbprint = ""
)
#
# Post-build signature verification for build-installer-signed.js.
#
# Checks that the installer at $Path has an intact Authenticode signature and
# (optionally) pins the signing thumbprint to an expected value. This is
# machine-independent — it does NOT require the self-signed root to be
# installed on the build host, since that's the gateway's responsibility.
#
# Exit codes:
#   0 - signature present and (if pinned) thumbprint matches
#   2 - no signature on the file
#   3 - signature structure is broken (HashMismatch / NotSigned / wrong file type)
#   4 - thumbprint does not match the expected value
#  10 - file not found
#
$ErrorActionPreference = 'Stop'

if (-not (Test-Path $Path)) {
  Write-Error "FILE NOT FOUND: $Path"
  exit 10
}

$sig = Get-AuthenticodeSignature -FilePath $Path
if (-not $sig.SignerCertificate) {
  Write-Error "NOT SIGNED"
  exit 2
}

Write-Output ("STATUS=" + $sig.Status)
Write-Output ("SUBJECT=" + $sig.SignerCertificate.Subject)
Write-Output ("THUMBPRINT=" + $sig.SignerCertificate.Thumbprint)
if ($sig.TimeStamperCertificate) {
  Write-Output ("TIMESTAMP=" + $sig.TimeStamperCertificate.Subject)
} else {
  Write-Output "TIMESTAMP=(none)"
}

# Reject only statuses that prove the file is bad:
#   NotSigned          - no signature at all
#   HashMismatch       - file modified after signing
#   NotSupportedFileFormat / Incompatible - wrong file type
#
# Accept: Valid, NotTrusted, UnknownError - these all mean the signature
# structure is intact. The build machine may not have the self-signed root
# installed during CI, which manifests as NotTrusted or UnknownError. Trust
# validation is the gateway's job, not the build pipeline's.
$badStatuses = @('NotSigned', 'HashMismatch', 'NotSupportedFileFormat', 'Incompatible')
if ($badStatuses -contains [string]$sig.Status) {
  Write-Error ("BAD STATUS: " + $sig.Status)
  exit 3
}

if ($ExpectedThumbprint) {
  $actual = $sig.SignerCertificate.Thumbprint.ToUpper()
  $expected = $ExpectedThumbprint.ToUpper()
  if ($actual -ne $expected) {
    Write-Error ("THUMBPRINT MISMATCH: expected=" + $expected + " actual=" + $actual)
    exit 4
  }
  Write-Output "THUMBPRINT_PIN=OK"
}

exit 0
