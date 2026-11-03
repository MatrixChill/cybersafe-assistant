# Preparação da Release — assinatura, LAB e integração

Estado: procedimentos preparados; assinatura real, ensaio instalado e publicação NÃO executados. Base recebida: 2867b6c. Versão permanece 0.2.0-rc.1. Complementa ASSINATURA-E-GITHUB-V020-20261103.md e VM-ESTABILIZACAO-V020-20261103.md; não os substitui.

## 1. Authenticode: integração futura

O instalador usa electron-builder 25.1.8 e NSIS existentes. A API instalada em node_modules/app-builder-lib/out/options/winOptions.d.ts suporta win.signtoolOptions.sign (hook remoto) ou certificateSubjectName/certificateSha1 para certificado já instalado pelo fornecedor, publisherName, signingHashAlgorithms e rfc3161TimeStampServer. Não acrescentar valores vazios fictícios à configuração de produção. Não usar signAndEditExecutable=false nem substituir o verificador Windows.

SignPath: o proprietário candidata o projeto, declara funcionalidades, licenças e terceiros, identifica committers/reviewers/approvers e espera aceitação. Só após aceitação configurar organização/projeto/artifact configuration/signing policy oficiais, identidade OIDC/token conforme documentação do fornecedor e aprovação manual de cada assinatura. A fundação assina binários próprios; não reassinar ClamAV/YARA upstream como se fossem nossos. A configuração do artefacto deve garantir product name/version e proveniência Git. Um hook de assinatura aprovado deve bloquear até receber e verificar o resultado, incluindo o desinstalador, antes de o builder montar o setup final. Não ativar um workflow com IDs ou segredos inventados.

Certum: obter certificado legítimo, validar identidade e instalar SimplySign conforme fornecedor; autenticação móvel/desktop controlada pelo proprietário. Selecionar certificado real por mecanismo suportado, com SHA-256 e timestamp RFC3161 autorizado pelo fornecedor. Não guardar password no package.json. Renovação/rotação exige rever o SimpleName real; o hash de certificado SHA1 usado para seleção não é o SHA-256 Ed25519 SPKI.

Ordem: assinar e validar componentes próprios conforme contrato de payload; regenerar pins/inventário apenas a partir dos bytes legitimamente assinados; fechar árvore; aprovação e freeze válidos; packaging oficial com assinatura do EXE/desinstalador; validação Authenticode de cada artefacto; hashes dos bytes finais; manifesto Ed25519; publicação apenas autorizada. Não assinar o setup e depois modificar recursos/branding. Se o serviço remoto não conseguir preservar o percurso real do desinstalador, gate NO-GO até integração comprovada.

Novo verificador read-only (não assina nem instala):

```powershell
node scripts/authenticode-readiness.mjs 'CAMINHO_ABSOLUTO_DO_ARTEFACTO.exe' --publisher 'SIMPLENAME_REAL_APROVADO'
```

Usa o mesmo adaptador Authenticode do updater. Só emite hash de release se assinatura/publisher válidos e bytes/identidade permanecerem iguais durante a consulta. Recusa ficheiros redirecionados e o publisher académico provisório. Saída 1 é bloqueio. O relatório não aprova a identidade nem impede alterações posteriores: verificar novamente imediatamente antes do manifesto/publicação. Não é substituto dos locks de staging existentes.

Fontes: https://signpath.org/terms ; https://shop.certum.eu/open-source-code-signing-on-simplysign.html ; contrato TypeScript do electron-builder instalado. Não existe candidatura, certificado ou identidade nova nesta ronda.

## 2. Cerimónia Ed25519 pelo proprietário (NÃO executada)

Escolher diretório NTFS local fora de TODOS os repos/worktrees e pastas sincronizadas. A ferramenta protege a sua raiz, não identifica todos os outros projetos. O PEM privado gerado é PKCS8 sem cifragem própria: ACL restrita e backup cifrado são obrigatórios. Não executar sob transcrição que recolha conteúdos, não abrir a privada em editor partilhado, não usar --force.

Exemplo a executar pelo proprietário só depois de confirmar o destino:

```powershell
$releaseKeyDir = Join-Path $env:LOCALAPPDATA 'CyberSafeReleaseKeys'
if (Test-Path -LiteralPath $releaseKeyDir) { throw 'Escolher pasta nova; não alterar ACL/chaves existentes.' }
New-Item -ItemType Directory -Path $releaseKeyDir | Out-Null
$releaseOwnerSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
icacls $releaseKeyDir /inheritance:r /grant:r "*${releaseOwnerSid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F'
if ($LASTEXITCODE -ne 0) { throw 'ACL não aplicada; não gerar.' }
Get-Acl -LiteralPath $releaseKeyDir | Format-List Owner,AccessToString
# Confirmar manualmente: apenas proprietário e SYSTEM têm acesso.
node scripts/release-key-setup.mjs --generate --dir $releaseKeyDir
if ($LASTEXITCODE -ne 0) { throw 'Geração recusada.' }
$releasePublic = Join-Path $releaseKeyDir 'cybersafe-publish-ed25519.pub.pem'
node scripts/release-key-setup.mjs --fingerprint --public $releasePublic
```

Registar a pública e o fingerprint por canal independente e aprová-los expressamente. O fingerprint é SHA-256 do DER SPKI, não Get-FileHash do texto PEM. Validar com --verify --public <publica> --expect <fingerprint-aprovado>. Para confirmar o PAR privado/público, usar release-signing.mjs --check-key <privada> <publica> <fingerprint>; --verify do gerador só compara a pública com o pin. Não enviar a privada pelo chat. Fazer backup cifrado offline e ensaiar recuperação do backup sem divulgar conteúdos.

--trust imprime a configuração com ambos os gates false; rever pública, publisher e feed antes de integrar. Nunca mudar enabled ou assistedInstallationEnabled nesta cerimónia. Preferir assinatura offline. Se CI for escolhido, criar environment release-signing com aprovadores/restrições reais e provisionar os nomes já previstos em release-sign.yml; o workflow é manual e não publica. Não presumir que a proteção de environment está configurada só porque o YAML o nomeia.

## 3. Ensaio ponta a ponta entre duas versões LAB

Pré-condições obrigatórias: VM descartável especificamente autorizada, snapshot confirmado, dois commits/versionamentos SemVer crescentes aprovados (não build metadata), freezes válidos, artefactos legitimamente assinados, publisher e chave LAB aprovados separados de produção. Não gerar certificados LAB nem instalar confiança no PC pessoal. O produtor stable atual recusa prerelease: escolher canal/versões honestos por decisão própria antes de construir; não editar o manifesto assinado para contornar o gate.

A distribuição necessita HTTPS acessível ao cliente atual. Releases draft/privadas não funcionam sem autenticação nesse downloader. Possível opção futura: repositório de distribuição LAB separado, público e explicitamente autorizado, com latest/download separado, sem dados/chaves privadas; não criar nem publicar agora. GitHub Releases dispensa servidor próprio. No produto público o feed continua bloqueado até prova da cadeia.

| Passo | Ação autorizada | Aceitação |
|---|---|---|
| S0 | Snapshot Windows limpo; guardar hash/setup/versão e estado de proteções | Identidade/snapshot registados; Defender/SmartScreen/UAC intactos |
| S1 | Instalar versão A; criar conta, histórico e preferências sintéticos | Arranque visível; SQLite quick_check=ok e esquema/IDs/contagens registados |
| S2 | Encerrar normalmente; cópia SQLite consistente (backup API ou DB/WAL/SHM sem escritores); snapshot | Backup legível/verificável, nunca só copiar DB aberto |
| Descoberta | Publicar B apenas no canal aprovado; procurar pela UI A | Versão B e notas corretas; nenhuma transferência/instalação sem consentimento |
| Download | Aceitar transferência; interromper/repetir numa cópia de snapshot | Percentagem real, cancelamento terminal, sem processo instalador iniciado |
| Verificação | Repetir com manifesto alterado/hash errado/publisher divergente em casos separados | Todos recusados antes de shutdown/handoff; motivos e logs guardados |
| Preparação | Manifesto e EXE válidos; confirmar instalação da versão exata | Consentimento não reutilizado se versão/estado mudou; staging e diário reais |
| Instalação | Fechar só processos próprios, executar NSIS real autorizado | Instalação e progresso reais; código zero ainda não significa completed |
| Reinício | Aguardar aplicação B visível e confirmação pós-arranque | Versão B real, saúde/API/SQLite prontas e diário confirmado, sem órfãos |
| Persistência | Rever sessão/tema/acento/consentimento/exclusões/auto-check e histórico | IDs/registos essenciais preservados; quick_check=ok; migração esperada |
| Falhas | Snapshots isolados: rede, recusa de consentimento, NSIS não-zero, ausência de confirmação | Sem retry/instalação em loop; estado honesto; dados e evidência preservados |
| Recuperação | Preservar diário/staging; diagnosticar; restauro/reinstalação só autorizados | Não anunciar rollback automático; snapshot é recuperação da VM |

Por caso recolher: run-id, operador, commit A/B, versões, snapshot, hashes, assinatura/publisher, fingerprint público, duração, resultado esperado/observado, logs redigidos, capturas e estado do diário. Nunca incluir JWT, passwords, DPAPI ou privada. Resultado inicial de TODOS os casos: NÃO EXECUTADO. Interromper perante alteração de hash/assinatura, perda de dados, processo errado, elevação inesperada ou consumo descontrolado. O simulador de handoff não aprova este ensaio.

## 4. PR, freeze e Release

Após fetch desta ronda, origin/main é antepassado da base 2867b6c: 0 commits exclusivos de main, 134 exclusivos da base. A linha Windows integrada também é antepassada. Preservar esses 134 commits por PR normal da branch atual para main e estratégia merge commit autorizada no momento certo, sem squash/rebase se o objetivo é manter hashes. Não fazer merges prévios de branches já contidas. Novos commits desta ronda acrescentam-se aos 134; não os substituem. Freebuff/worktrees preservados. Se main avançar, repetir merge-base e revisão diferencial antes da aprovação, não aplicar este número antigo cegamente.

PR ainda NÃO criada. Preparar descrição com: apresentação updater/NSIS, adaptação de tooling, métricas reais, testes e limitações. Exigir CI do HEAD final, revisão de segredos/licenças, diff completo contra main, árvore sem alterações versionadas pendentes e aprovação dos gates externos. output/ é evidência local não versionada e não deve ser incluída por git add -A.

Novo freeze: decidir versão final explicitamente; configurar confiança legítima sem a ativar prematuramente; estabilizar componentes/assinaturas e payload; calcular inventário oficial; obter aprovação ligada ao HEAD/digest exatos através do registo externo legítimo; source-freeze --write com --approval apenas após essa aprovação; --verify e package-windows --check. Nunca reutilizar manifesto 497e634. Mudança posterior exige novo inventário/aprovação.

Release: packaging oficial assinado, payload/licenças/SBOM exigidos pelo fornecedor, Authenticode e Ed25519 verificados, SHA256SUMS finais, ensaio completo aprovado, notas finais e aprovação separada de merge/tag/Release. Só depois autorizar gates de produção. Nenhuma dessas autorizações é inferida deste documento.
