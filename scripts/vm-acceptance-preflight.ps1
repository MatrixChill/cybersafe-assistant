#requires -Version 5.1
<#
.SYNOPSIS
  Recolhe evidência de pré-condições para a aceitação da candidata CyberSafe numa VM Windows.
.DESCRIPTION
  Só lê. Não instala, não altera registo, não inicia serviços e não escreve no instalador.
  O JSON produzido é a evidência da fase 0; não é um PASS de instalação.
.PARAMETER InstallerPath
  Caminho do setup da candidata a testar.
.PARAMETER OutFile
  Ficheiro JSON de evidência. Por omissão: vm-acceptance-preflight.json no diretório atual.
.PARAMETER ExpectedVersion
  Versão canónica esperada em product-version.json.
#>
param(
  [Parameter(Mandatory = $true)][string]$InstallerPath,
  [string]$OutFile = (Join-Path (Get-Location) "vm-acceptance-preflight.json"),
  [string]$ExpectedVersion = "0.1.11-internal.pap-r7.20261031"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $InstallerPath -PathType Leaf)) {
  Write-Error "Instalador inexistente: $InstallerPath"
  exit 2
}

$installer = (Resolve-Path -LiteralPath $InstallerPath).Path
$repoRoot = Split-Path -Parent $PSScriptRoot
$productVersionPath = Join-Path $repoRoot "product-version.json"
$trustPath = Join-Path $repoRoot "packages\desktop\src\updater\release-trust.json"

function Read-JsonFile([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  try { return (Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json) }
  catch { return $null }
}

$product = Read-JsonFile $productVersionPath
$trust = Read-JsonFile $trustPath
$file = Get-Item -LiteralPath $installer
$hash = Get-FileHash -LiteralPath $installer -Algorithm SHA256
$signature = Get-AuthenticodeSignature -LiteralPath $installer
$os = Get-CimInstance Win32_OperatingSystem
$computer = Get-CimInstance Win32_ComputerSystem
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

$uninstallRoots = @(
  "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall",
  "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall",
  "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"
)
$installed = @()
foreach ($root in $uninstallRoots) {
  if (-not (Test-Path $root)) { continue }
  foreach ($key in Get-ChildItem $root -ErrorAction SilentlyContinue) {
    $item = Get-ItemProperty $key.PSPath -ErrorAction SilentlyContinue
    if ($item.DisplayName -match "CyberSafe") {
      $installed += [pscustomobject]@{
        hive = if ($root -like "HKCU:*") { "HKCU" } else { "HKLM" }
        key = $key.PSChildName
        displayName = $item.DisplayName
        displayVersion = $item.DisplayVersion
        installLocation = $item.InstallLocation
        uninstallString = $item.UninstallString
      }
    }
  }
}

$processes = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
  $_.ProcessName -match "CyberSafe|cybersafe"
} | Select-Object -ExpandProperty ProcessName -Unique)

$services = @(Get-Service -ErrorAction SilentlyContinue | Where-Object {
  $_.Name -match "CyberSafe|cybersafe" -or $_.DisplayName -match "CyberSafe"
} | Select-Object Name, DisplayName, Status, StartType)

$disk = Get-PSDrive -Name C -ErrorAction SilentlyContinue
$freeGb = if ($disk) { [math]::Round($disk.Free / 1GB, 2) } else { $null }

$result = [ordered]@{
  schema = "cybersafe.vm-acceptance.preflight/v1"
  capturedAt = (Get-Date).ToUniversalTime().ToString("o")
  host = $env:COMPUTERNAME
  user = $env:USERNAME
  isAdmin = $isAdmin
  os = [ordered]@{
    caption = $os.Caption
    version = $os.Version
    build = $os.BuildNumber
    architecture = $os.OSArchitecture
    productName = $os.ProductName
  }
  hardware = [ordered]@{
    manufacturer = $computer.Manufacturer
    model = $computer.Model
    totalMemoryGb = [math]::Round($computer.TotalPhysicalMemory / 1GB, 2)
    systemDriveFreeGb = $freeGb
  }
  installer = [ordered]@{
    path = $installer
    bytes = $file.Length
    sha256 = $hash.Hash
    signatureStatus = $signature.Status.ToString()
    signatureMessage = $signature.StatusMessage
    signer = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { $null }
  }
  version = [ordered]@{
    expectedCanonical = $ExpectedVersion
    productVersionFile = if ($product) { $product.version } else { $null }
    productVersionMatchesExpected = if ($product) { $product.version -eq $ExpectedVersion } else { $false }
  }
  existing = [ordered]@{
    installed = @($installed)
    processes = @($processes)
    services = @($services)
    cleanHost = (($installed.Count -eq 0) -and ($processes.Count -eq 0) -and ($services.Count -eq 0))
  }
  updaterTrust = if ($trust) {
    [ordered]@{
      enabled = [bool]$trust.enabled
      publicKeyPresent = [bool]($trust.publicKeyPem -and $trust.publicKeyPem.Length -gt 0)
      fingerprintPresent = [bool]($trust.pinnedKeyFingerprint -and $trust.pinnedKeyFingerprint.Length -gt 0)
      feedManifestUrl = $trust.feedManifestUrl
      reason = $trust.reason
    }
  } else { $null }
  notes = @(
    "Leitura apenas; nenhuma instalação, serviço ou chave foi alterada.",
    "cleanHost=true só é esperado numa VM restaurada antes da instalação.",
    "Uma assinatura ausente é o estado atual conhecido; não é um PASS de Authenticode."
  )
}

$json = $result | ConvertTo-Json -Depth 8
$dir = Split-Path -Parent $OutFile
if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($OutFile, $json, $utf8NoBom)
Write-Output "PREFLIGHT_OK $OutFile"
Write-Output ("INSTALLER_SHA256=" + $hash.Hash)
Write-Output ("SIGNATURE=" + $signature.Status)
Write-Output ("EXISTING_INSTALLS=" + $installed.Count)
Write-Output ("CLEAN_HOST=" + $result.existing.cleanHost)
