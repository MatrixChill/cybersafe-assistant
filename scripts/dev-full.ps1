# dev-full.ps1 — lançador de DEV/PREVIEW no Windows.
#
# DOIS modos:
#   • PREVIEW (default): só o que a PREVIEW de login/dashboard/IA precisa = API
#     (:4000) + vite preview do build (:4173). NÃO serviço Windows, NÃO Electron,
#     NÃO elevação/scan/Defender. Reaproveita listeners já em curso (sem duplicar).
#   • -Full: a STACK COMPLETA que o utilizador pediu (frontend+Electron+serviço+API).
#     Faz a ponte para o comando JÁ EXISTENTE `npm run dev` (concurrently
#     dev:service + dev:api + dev:app + dev:desktop). Isto ARANCA o serviço (que fica
#     com PROTEÇÃO OFF até o desktop enviar monitor.start — index.ts:155) e o
#     Electron. Só usa isto quando queres a stack inteira a correr; NÃO é preciso
#     para validar a PREVIEW.
#
# Uso (o padrão é -NoProfile -File; NÃO usar -ExecutionPolicy Bypass por omissão):
#   powershell -NoProfile -File scripts\dev-full.ps1 -DryRun
#   powershell -NoProfile -File scripts\dev-full.ps1
#   powershell -NoProfile -File scripts\dev-full.ps1 -Full
# Se a política do Windows BLOQUEAR o arranque de scripts .ps1, NÃO alteres a
# política. Alternativa validada sem PowerShell: para a stack completa corre
# diretamente `npm run dev`; para a preview corre `node scripts\dev-preflight.mjs`
# e depois, cada um no seu terminal, `npm run dev:api` + `npm run build -w
# @cybersafe/app` + `npm run preview -w @cybersafe/app`. Não imprime segredos.
param(
  [switch]$DryRun,
  [switch]$Full,
  [int]$ApiPort = 4000,
  [int]$PreviewPort = 4173
)
$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot

function Test-Port([string]$Computer, [int]$Port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $async = $client.BeginConnect($Computer, $Port, $null, $null)
    $ok = $async.AsyncWaitHandle.WaitOne(500, $false)
    if ($ok -and $client.Connected) { $client.EndConnect($async); return $true }
    return $false
  } catch { return $false } finally { $client.Close() }
}

# Serve algo HTTP em qualquer um destes URLs? (deteta preview em IPv4 OU IPv6,
# que o Test-Port por hostname resolve de forma inconsistente no Windows).
function Test-AnyHttp([string[]]$Urls) {
  foreach ($u in $Urls) {
    try {
      $r = Invoke-WebRequest -UseBasicParsing -Uri $u -TimeoutSec 2 -MaximumRedirection 0 -ErrorAction Stop
      return $true          # qualquer resposta HTTP conta como "servido"
    } catch {
      if ($_.Exception.Response) { return $true }  # até um 4xx prova que há listener
    }
  }
  return $false
}

Write-Host "== PREVIEW full-stack launcher ($RepoRoot) ==" -ForegroundColor Cyan

# 1) Preflight read-only (não escreve; reporta BLOCK/WARN; nunca imprime valores).
Write-Host "`n-- preflight --" -ForegroundColor Yellow
& node (Join-Path $RepoRoot "scripts\dev-preflight.mjs")
if ($LASTEXITCODE -ne 0) {
  Write-Host "PREFLIGHT bloqueou a arranque. Resolve os BLOCK (ex.: JWT_SECRET ausente) e tenta de novo." -ForegroundColor Red
  exit 1
}

# 2) Modo FULL: a stack completa pedida (frontend+Electron+servico+API), via
#    comando JÁ EXISTENTE 'npm run dev' (nao re-implementamos a orquestracao).
if ($Full) {
  Write-Host ''
  Write-Host '== STACK COMPLETA: npm run dev =='
  Write-Host '  concurrently: dev:service + dev:api + dev:app + dev:desktop'
  Write-Host '  ordem/leitura: servico abre o pipe; PROTECAO fica OFF ate o desktop'
  Write-Host '  enviar monitor.start (index.ts:155). API :4000; app dev :5173; Electron'
  Write-Host '  liga ao pipe. NAO altera politica do Windows nem eleva; nao dispara scan.'
  if ($DryRun) {
    Write-Host ''
    Write-Host '-DryRun -Full: nada arrancado. Corre "npm run dev" (ou remove -DryRun).'
    exit 0
  }
  Write-Host ''
  Write-Host 'a iniciar stack completa (Ctrl-C para parar tudo; o concurrently encerra os filhos)'
  Push-Location $RepoRoot
  try { npm run dev } finally { Pop-Location }
  exit $LASTEXITCODE
}

# 3) Modo PREVIEW: decidir o que arrancar vs reaproveitar.
$apiBusy     = Test-Port "127.0.0.1" $ApiPort
$previewBusy = Test-AnyHttp @("http://localhost:$PreviewPort/", "http://127.0.0.1:$PreviewPort/")
$apiDist     = Test-Path (Join-Path $RepoRoot "packages\api\dist\index.js")
$appDist     = Test-Path (Join-Path $RepoRoot "packages\app\dist\index.html")

Write-Host ''
Write-Host '-- plano (PREVIEW) --'
Write-Host ("  API  :{0} (porta {1} livre)"    -f ($(if ($apiBusy)     { "REAPROVEITAR (já em escuta)" } else { "ARRANCAR npm run dev:api" }), $ApiPort))
Write-Host ("  build:{0}"                       -f ($(if ($appDist)    { "app/dist já existe" } else { "npm run build -w @cybersafe/app (necessário p/ preview)" })))
Write-Host ("  preview:{0} (porta {1} {2})"     -f ($(if ($previewBusy) { "REAPROVEITAR" } else { "ARRANCAR npm run preview -w @cybersafe/app" }), $PreviewPort, $(if ($previewBusy) { "livre=FALSE" } else { "livre=TRUE" })))
if (-not $apiDist) { Write-Host "  nota: dev:api usa tsx (não precisa de dist); o preflight checa dist só para os testes." -ForegroundColor DarkGray }

if ($DryRun) {
  Write-Host "`n-DryRun: nada foi arrancado. Remova -DryRun para iniciar/reaproveitar." -ForegroundColor Green
  exit 0
}

# 3) Build do app se falta (preview serve dist).
if (-not $appDist) {
  Write-Host "`n-- a compilar @cybersafe/app --" -ForegroundColor Yellow
  Push-Location $RepoRoot; npm run build -w "@cybersafe/app"; $code=$LASTEXITCODE; Pop-Location
  if ($code -ne 0) { Write-Host "build do app falhou (exit $code)." -ForegroundColor Red; exit $code }
}

# 4) Arranque em background com Jobs; Ctrl-C manda parar tudo.
$jobs = @()
$stopped = $false
function Stop-All() {
  if ($stopped) { return }; $stopped = $true
  Write-Host "`n-- a parar os processos iniciados por este script --" -ForegroundColor Yellow
  $jobs | ForEach-Object { try { Stop-Job $_; Remove-Job $_ -Force } catch {} }
  Write-Host "parado." -ForegroundColor Green
}
[Console]::TreatControlCAsInput = $true

if (-not $apiBusy) {
  Write-Host "`n-- API :$ApiPort --" -ForegroundColor Yellow
  $jobs += Start-Job -WorkingDirectory (Join-Path $RepoRoot "packages\api") -ScriptBlock {
    param($root)
    Set-Location (Join-Path $root "packages\api")
    npx tsx src/index.ts 2>&1
  } -ArgumentList $RepoRoot
}

if (-not $previewBusy) {
  Write-Host "`n-- vite preview :$PreviewPort --" -ForegroundColor Yellow
  $jobs += Start-Job -WorkingDirectory (Join-Path $RepoRoot "packages\app") -ScriptBlock {
    param($root, $port)
    Set-Location (Join-Path $root "packages\app")
    npx vite preview --host 127.0.0.1 --port $port 2>&1
  } -ArgumentList $RepoRoot, $PreviewPort
}

# 5) Readiness real da API por /health (não assume por tempo).
Write-Host "`n-- à espera de http://127.0.0.1:$ApiPort/health --" -ForegroundColor Yellow
$deadline = (Get-Date).AddSeconds(40); $healthy = $false
while ((Get-Date) -lt $deadline) {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$ApiPort/health" -TimeoutSec 3
    if ($r.StatusCode -eq 200) { $healthy = $true; break }
  } catch { Start-Sleep -Milliseconds 500 }
}
if (-not $healthy) {
  Write-Host "API não respondeu em /health em 40s. Ver o JWT_SECRET (o arranque aborta sem segredo válido)." -ForegroundColor Red
  # Mostra o erro do job SEM imprimir segredos.
  $jobs | Receive-Job -Keep | Select-Object -First 15 | ForEach-Object { Write-Host $_ -ForegroundColor DarkGray }
  Stop-All; exit 1
}
Write-Host "API READY (/health 200)." -ForegroundColor Green

# 6) Resumo operacional.
Write-Host "`n== PREVIEW pronta ==" -ForegroundColor Green
Write-Host ("  Abra no browser:  http://localhost:{0}" -f $PreviewPort)
Write-Host ("  API:              http://127.0.0.1:{0}  (CORS já permite http://localhost:{1} e http://127.0.0.1:{1})" -f $ApiPort, $PreviewPort)
Write-Host "  Contas/DB: usa a DB da instalação (~\.cybersafe-service). NÃO são criadas contas por este script."
Write-Host "  Ctrl-C para parar apenas os processos que este script lançou."
while (-not $stopped) {
  $ki = [Console]::KeyboardAvailable
  if ([Console]::KeyAvailable) {
    $key = [Console]::ReadKey($true)
    if ($key.Key -eq "C" -and ($key.Modifiers -band [ConsoleModifiers]::Control)) { break }
  }
  Start-Sleep -Milliseconds 400
}
Stop-All
