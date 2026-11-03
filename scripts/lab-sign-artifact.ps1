#requires -Version 5.1
<# VM-only, explicitly authorized laboratory signing. Never imports roots or exports keys. #>
param(
  [switch]$ExecuteAuthorized,
  [string]$AuthorizedVmHostname,
  [string]$SnapshotId,
  [string]$ArtifactPath,
  [string]$ExpectedSha256,
  [string]$CertificateThumbprint,
  [string]$SignToolPath,
  [string]$LabOutputDirectory
)
$ErrorActionPreference='Stop'
if (-not $ExecuteAuthorized) { throw 'LAB_EXECUTION_NOT_AUTHORIZED' }
if (-not $AuthorizedVmHostname -or $env:COMPUTERNAME -ne $AuthorizedVmHostname -or -not $SnapshotId) { throw 'LAB_HOST_OR_SNAPSHOT_REQUIRED' }
if ($ExpectedSha256 -notmatch '^[a-fA-F0-9]{64}$' -or $CertificateThumbprint -notmatch '^[a-fA-F0-9]{40}$') { throw 'LAB_IDENTITY_REQUIRED' }
$publisher='CyberSafe Assistant LAB ONLY'
$source=(Get-Item -LiteralPath $ArtifactPath).FullName
if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ne $ExpectedSha256) { throw 'LAB_INPUT_HASH_MISMATCH' }
$certificate=Get-Item -LiteralPath ('Cert:\CurrentUser\My\'+$CertificateThumbprint)
if (-not $certificate.HasPrivateKey -or $certificate.NotAfter -le (Get-Date) -or $certificate.NotBefore -gt (Get-Date)) { throw 'LAB_CERTIFICATE_UNUSABLE' }
if ($certificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false) -ne $publisher) { throw 'LAB_PUBLISHER_MISMATCH' }
$codeSigning=$false
foreach ($extension in $certificate.Extensions) {
  if ($extension -is [Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]) {
    foreach ($oid in $extension.EnhancedKeyUsages) { if ($oid.Value -eq '1.3.6.1.5.5.7.3.3') { $codeSigning=$true } }
  }
}
if (-not $codeSigning) { throw 'LAB_CODE_SIGNING_EKU_REQUIRED' }
$tool=(Get-Item -LiteralPath $SignToolPath).FullName
$toolSignature=Get-AuthenticodeSignature -LiteralPath $tool
if ($toolSignature.Status -ne 'Valid' -or -not $toolSignature.SignerCertificate -or $toolSignature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false) -ne 'Microsoft Corporation') { throw 'LAB_SIGNTOOL_UNTRUSTED' }
$output=[IO.Path]::GetFullPath($LabOutputDirectory)
$repo=[IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot)).TrimEnd('\')+'\'
if ($output.StartsWith($repo,[StringComparison]::OrdinalIgnoreCase) -or $output.StartsWith('\\') -or (Test-Path -LiteralPath $output)) { throw 'LAB_NEW_EXTERNAL_OUTPUT_REQUIRED' }
# All output ancestors must be real directories, never junctions into the repository.
$ancestor=New-Object IO.DirectoryInfo((Split-Path -Parent $output))
while ($null -ne $ancestor) {
  if (-not $ancestor.Exists -or ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'LAB_OUTPUT_ANCESTOR_REFUSED' }
  $ancestor=$ancestor.Parent
}
New-Item -ItemType Directory -Path $output | Out-Null
$signed=Join-Path $output 'CyberSafe-LAB-ONLY-setup.exe'
[IO.File]::Copy($source,$signed,$false)
if ((Get-FileHash -LiteralPath $signed -Algorithm SHA256).Hash -ne $ExpectedSha256) { throw 'LAB_COPIED_HASH_MISMATCH' }
& $tool sign /s My /sha1 $CertificateThumbprint /fd SHA256 $signed
if ($LASTEXITCODE -ne 0) { throw 'LAB_SIGN_FAILED_DO_NOT_DISTRIBUTE' }
& $tool verify /pa /all /v $signed
if ($LASTEXITCODE -ne 0) { throw 'LAB_VERIFY_FAILED_DO_NOT_DISTRIBUTE' }
$signature=Get-AuthenticodeSignature -LiteralPath $signed
if ($signature.Status -ne 'Valid' -or $signature.SignatureType -ne 'Authenticode' -or $signature.SignerCertificate.Thumbprint -ne $CertificateThumbprint) { throw 'LAB_AUTHENTICODE_MISMATCH' }
$evidence=[ordered]@{schema=1;scope='LAB ONLY - NOT PRODUCTION';host=$env:COMPUTERNAME;snapshot=$SnapshotId;publisher=$publisher;thumbprint=$CertificateThumbprint;expiresUtc=$certificate.NotAfter.ToUniversalTime().ToString('o');inputSha256=$ExpectedSha256;artifact=$signed;sha256=(Get-FileHash -LiteralPath $signed -Algorithm SHA256).Hash;bytes=(Get-Item -LiteralPath $signed).Length;authenticode=$signature.Status.ToString();timestamped=$false}
[IO.File]::WriteAllText((Join-Path $output 'lab-signing-evidence.json'),($evidence|ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
Write-Output 'LAB_SIGNED_NOT_INSTALLED_NOT_PRODUCTION'
