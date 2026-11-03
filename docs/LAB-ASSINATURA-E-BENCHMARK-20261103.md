# Preparação laboratorial — assinatura e benchmark integrado

Estado: scripts preparados; assinatura, confiança da VM, benchmark integrado e instalação NÃO EXECUTADOS. Base dd6a0c5. Produção permanece fechada.

## 1. Assinatura exclusivamente na VM autorizada

Antes de executar: autorização nominal da VM/hostname, snapshot S0 e autorização para criar identidade de teste e confiar no certificado só nessa VM. Não executar os comandos seguintes no PC pessoal. Não ativar test-signing do Windows nem desativar políticas/SmartScreen. Sem possibilidade de confiar no certificado na VM autorizada, o ensaio fica bloqueado.

Após essa autorização, criar certificado de código de curta validade no CurrentUser\My da conta sintética, com chave não exportável:

```powershell
$cert = New-SelfSignedCertificate -Type CodeSigningCert `
  -Subject 'CN=CyberSafe Assistant LAB ONLY' `
  -FriendlyName 'CyberSafe LAB ONLY - NOT PRODUCTION' `
  -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 `
  -KeyExportPolicy NonExportable -CertStoreLocation 'Cert:\CurrentUser\My' `
  -NotAfter (Get-Date).AddDays(7)
Export-Certificate -Cert $cert -FilePath 'C:\lab\CyberSafe-LAB-public.cer'
# Apenas na VM e depois da autorização de confiança de laboratório:
Import-Certificate -FilePath 'C:\lab\CyberSafe-LAB-public.cer' -CertStoreLocation 'Cert:\CurrentUser\Root'
```

Não exportar PFX/chave privada, não guardar certificados privados no Git, não transportar roots para a máquina pessoal. O certificado público e thumbprint identificam o ensaio; não são identidade de produção. Reverter snapshot elimina o ambiente de confiança de ensaio; não usar uma limpeza genérica do store do computador.

Assinar só uma cópia num diretório novo fora do repositório. Obter SignTool do SDK oficial e confirmar a assinatura Microsoft. O script exige hash da entrada, thumbprint, publisher exato LAB ONLY, EKU Code Signing, validade, chave disponível e identidade do SignTool. Não instala nem executa o setup:

```powershell
.\scripts\lab-sign-artifact.ps1 -ExecuteAuthorized `
  -AuthorizedVmHostname '<hostname autorizado>' -SnapshotId '<id S0>' `
  -ArtifactPath 'C:\lab\unsigned\CyberSafe-setup.exe' `
  -ExpectedSha256 '<hash aprovado do setup não assinado>' `
  -CertificateThumbprint '<thumbprint público LAB>' `
  -SignToolPath '<SDK oficial>\signtool.exe' `
  -LabOutputDirectory 'C:\lab\signed-run-<id único>'
```

Validar SignTool verify /pa /all /v e Get-AuthenticodeSignature=Valid/Authenticode. O script não usa timestamp público; o resultado é temporário e expira com o certificado. Guardar lab-signing-evidence.json. Falha de qualquer etapa deixa artefacto NÃO DISTRIBUÍVEL. A assinatura altera os bytes: gerar SHA-256 e manifesto Ed25519 somente DEPOIS de assinar, nunca reaproveitar o hash unsigned.

Referências oficiais: [New-SelfSignedCertificate](https://learn.microsoft.com/en-us/powershell/module/pki/new-selfsignedcertificate) e [SignTool](https://learn.microsoft.com/en-us/windows/desktop/seccrypto/signtool). /pa aplica a política Authenticode, não a política de drivers.

## 2. Confiança Ed25519 e atualização real

Preservar validação Ed25519, download HTTPS/GitHub e SHA-256. Chave de laboratório separada, privada apenas num local externo protegido no ambiente autorizado; não gerar/substituir chave de produção. Aprovar previamente PEM público, fingerprint SHA-256 e publisher LAB para o ensaio. Manifesto deve conter versão real distinta, bytes/hash do setup já assinado e assinatura Ed25519 canónica pelo contrato existente.

IMPORTANTE: assinar um setup não ativa o updater atual. enabled=false e assistedInstallationEnabled=false permanecem no release-trust.json. Um ensaio ponta-a-ponta pela aplicação exige uma configuração/build LAB explicitamente aprovada, isolada da produção, com âncoras públicas fixadas e feed legítimo. Não editar a confiança instalada nem usar mocks para ultrapassar o gate. Este build/configuração ainda não foi produzido nem aprovado. Os cinco testes nativos anteriores continuam apenas laboratório de protocolo.

Para duas versões de ensaio é necessária aprovação de versionamento; o produto atual permanece 0.2.0-rc.1. Nenhuma segunda versão ou candidata foi gerada nesta ronda.

## 3. Benchmark de motores reais preparado

Executar só na VM autorizada. Primeiro construir/verificar os inputs e copiar uma seed oficial com SEED-MANIFEST.json íntegro. Definir CYBERSAFE_CLAMAV_SEED_DIR para essa seed e CYBERSAFE_CLAMSCAN_PATH para o binário verificado compatível. O serviço usa base temporária própria; não apontar para o perfil pessoal. Documentar versões/pins de ClamAV, YARA, HashDB e Native. O modo NODE_ENV=test do harness isola efeitos de arranque; não equivale a um serviço instalado. A análise efetiva continua a usar os motores reais e o relatório recusa completude se algum deles não estiver ativo.

```powershell
$env:CYBERSAFE_CLAMAV_SEED_DIR='C:\lab\verified-seed'
$env:CYBERSAFE_CLAMSCAN_PATH='C:\lab\verified-runtime\clamscan.exe'
.\scripts\vm-scanner-benchmark.ps1 -ExecuteAuthorized `
  -AuthorizedVmHostname '<hostname autorizado>' -SnapshotId '<id>' `
  -NodePath '<node.exe aprovado>' -Files 40 `
  -EvidenceDirectory 'C:\lab\evidence\benchmark-<id único>'
```

O runner executa o benchmark integrado existente e recolhe stdout/stderr, benchmark.json e process-samples.json. O relatório contém inventário dos ficheiros/bytes/SHA-256 gerados, timings, estado/inconclusivos, fontes de cache, chamadas ClamAV, health e trace correlacionado de fases. O sampler associa PID+creation e parentesco, recolhe CPU cumulativa e working set em intervalos de um segundo. Filhos breves podem escapar; não somar amostras de CPU cumulativa nem anunciar pico de memória exato. Não mede overhead de criação de processo isoladamente; os eventos de spawn e fases permitem localizar esse custo para investigação posterior.

Começar por 40 ficheiros, rever saúde/erros; 800 só após autorização de carga e com recursos da VM registados. Corpus sintético novo identificado, não comparação histórica. A pesquisa de nomes de corpus/benchmarks nos worktrees encontrou fixtures de teste e não recuperou um inventário equivalente dos 800 ficheiros históricos. Os 594 segundos permanecem sem causa demonstrada.

Após cada medição, verificar health ClamAV/carga, transições, timeouts, batches e processos remanescentes. Medir novamente só quando houver hipótese concreta. Não alterar veredictos/cobertura para acelerar. Para YARA, carregar corpus real aprovado e registar cobertura limitada; para Gestor usar apenas a fixture benigna na VM e matriz existente. Não houve terminação física nesta preparação.

## 4. Preflight e autorização que falta

O check de packaging read-only desta ronda confirmou bundle ClamAV 1.5.4 (45 entradas) e YARA 4.6.0 (4 entradas), sem inputs de build em falta. Não aprovou candidata: CYBERSAFE_APPROVERS_FILE não está configurado. Sem candidate-id, seed não é exigida nesse check; a verificação separada da seed existente passou, mas o build candidato terá de receber o caminho explícito e revalidá-la.

Antes de packaging: aprovar o HEAD final/inventário, disponibilizar registo legítimo de aprovadores externo e autorização de freeze desse HEAD pelo processo oficial. Não existe manifesto aprovado novo. Inventário de trabalho/digest não é uma aprovação.

Depois: autorização da VM/hostname/snapshots, criação de identidade LAB e root local, assinatura de cópias e versões/configuração LAB separadas para upgrade. Autorizações de instalação, execução NSIS, reparação/desinstalação e terminação benigna devem abranger a matriz VM. Nenhuma está inferida dos scripts preparados. Sem merge, tag ou publicação.
