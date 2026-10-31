# Release readiness — marco recursos/trust/CI (31/10/2026)

Lane: `C:/Users/caioc/.cybersafe-integration/pap-freebuff-final-release-20261031/repo`
Branch: `pap/freebuff-final-release-20261031`
Base: `c99543a296db8bf67eefecd6ea27f72d4653c547`

Estado: **BLOCKED_WITH_EVIDENCE**. Os recursos e a infraestrutura independente
estão concluídos; faltam aprovações humanas e o freeze. **Não foi gerado
instalador, não houve instalação, VM, publicação ou Release.**

## Concluído nesta lane

### YARA

- Motor executável: YARA clássico oficial 4.6.0 por processo.
- `@litko/yara-x` removido do manifesto/lock/pins/asarUnpack; `ascii_tree 0.1.1`
  não é distribuído nem alcançável. Lock com 0 ocorrências `@litko`.
- `resources/yara` publicado por `extraResources`, com `yara64.exe`,
  `yarac64.exe`, `COPYING.txt` e `vcruntime140.dll`.
- `vcruntime140.dll`: 119 888 B, sha256 `02c6aa0e…` (prefixo confirmado),
  Authenticode
  `Status=Valid`, assinante Microsoft. Resolve o `STATUS_DLL_NOT_FOUND` da VM016.
- `verifyYaraVendor()` exige o conjunto exato (VENDOR + 4 ficheiros), recusa
  extras, duplicados, colisões de caixa, links/junctions e subdiretórios.
- Evidência: `EVIDENCIA-YARA-20261031.md` (fora do repo) e
  `logs-yara-20261031/`.

### ClamAV

- Provisionado pelo processo oficial `scripts/vendor-clamav.mjs`:
  - ClamAV 1.5.4 win-x64; ZIP oficial `225 774 978 B`,
    sha256 `0d9e0228b2674137ea1a2853566c98a0278ad52ab2582c3d6dbd75373848c395`;
  - fonte correspondente GPL `63 702 396 B`,
    sha256 `1af1117a228f1b5bc7fa91a0dabc37848a99e7d25188e9be8043332ce721dfd3`,
    incluída no bundle;
  - assinaturas GPG verificadas com a chave Talos
    `5BADCA2665EF59DCF8A23D8B707F0DB480836771`;
  - 43 ficheiros extraídos (75 492 339 B); bundle final com 45 ficheiros
    (139 195 536 B) e `clamscan --version` = `ClamAV 1.5.4`.
- `verifyClamavBundle` no `--check`: `bundle.ok=true`, versão 1.5.4,
  45 ficheiros, fonte correspondente presente.
- `vendor/clamav/` é ignorado pelo git (GPL + binários); é reproduzível com
  `node scripts/vendor-clamav.mjs` e não entra no commit.

### Assinatura Ed25519 e CI

- `scripts/release-signing.mjs`: assina/verifica os bytes canónicos de
  `manifest.ts`; recusa chave privada dentro do repo (incluindo symlink) e nunca
  imprime material da chave.
- Testes: `release-signing` 6/6; compatibilidade assinador↔updater 1/1.
- `.github/workflows/ci.yml`: build, testes dirigidos e suíte desktop; sem
  segredos e sem publicação.
- `.github/workflows/release-sign.yml`: manual, environment `release-signing`,
  exige chave/fingerprint por secrets/variable e só produz a assinatura.
- `docs/RELEASE-SIGNING-RUNBOOK.md`: geração offline, aprovação, ativação,
  rotação e limites.
- A chave de produção **não foi gerada**. `release-trust.json` continua
  `enabled: false`, com chave/fingerprint vazios.

### Build e packaging

- `npm run build:all`: exit 0 (8 workspaces).
- `npm run build:native`: exit 0; `scan-engine.exe` passou a ser emitido em
  `packages/native-engine/build/Release/scan-engine.exe` (o CMake/VS escrevia
  `bin/Release`, fora do contrato).
- `node scripts/stage-renderer.mjs`: exit 0.
- `node scripts/package-windows.mjs --check --json`:
  - `missing: []`;
  - `bundle.ok=true`, `yara.ok=true`, `licensing=prova-fecha`;
  - `freeze.ok=false` — único bloqueador do pipeline.

## Bloqueadores externos exatos

1. **Freeze de fontes aprovado (Codex Lead).**
   `scripts/source-freeze.approved.json` não existe; `source-freeze --verify`
   devolve `manifest-missing`. O `APPROVER` do script é `Codex Lead`; o Freebuff
   não pode inventar essa aprovação. Ação: o Codex revê a árvore e cria o
   manifesto com `{approvedBy:"Codex Lead", candidateId, approvedAt}` via
   `node scripts/source-freeze.mjs --write --approval <fora-do-repo>`. Só depois
   o pipeline deixa de falhar no freeze.

2. **Chave Ed25519 de produção (aprovação do proprietário).**
   Não existe chave aprovada nem fingerprint. Ação: gerar offline fora do repo,
   obter aprovação do fingerprint, definir
   `RELEASE_ED25519_PRIVATE_KEY`, `RELEASE_ED25519_PUBLIC_KEY` e
   `RELEASE_ED25519_FINGERPRINT` no environment `release-signing`, e só então
   atualizar `release-trust.json` com a pública/fingerprint. A privada nunca
   entra no repo, logs ou payload.

3. **Certificado Authenticode.**
   Não há certificado CodeSigning. O setup, quando existir, será interno e
   não assinado; não pode ser distribuído nesse estado. O modo académico manual
   continua fail-closed e não executa instaladores.

4. **Validação humana/VM e novo payload.**
   Não há payload novo medido. Depois do freeze, o setup tem de ser construído,
   medido (0 `@litko`/`ascii_tree`, `resources/yara` com os 4 ficheiros e DLL
   app-local), hasheado e validado na VM com o roteiro/rollback.

5. **Updater online.**
   Sem Release GitHub real, sem feed assinado e sem chave aprovada, o updater
   permanece `unconfigured`/desativado. Não há infraestrutura para ativar.

## Sequência após as aprovações

1. Codex aprova/fixa o freeze.
2. `node scripts/package-windows.mjs` gera o setup interno; medir o payload novo.
3. SHA-256 + manifesto + proveniência; checklist VM e rollback.
4. Assinatura Ed25519 do manifesto, se a chave for aprovada; Authenticode só
   com certificado real.
5. Instalação/upgrade na VM apenas com autorização explícita do proprietário.

## Veredito

`BLOCKED_WITH_EVIDENCE`: recursos YARA/ClamAV, build, gate de licenças e
infraestrutura de assinatura/CI estão concluídos e medidos. O freeze e a chave
Ed25519 são aprovações humanas pendentes; não há candidata para declarar
`READY_FOR_VM_VALIDATION` enquanto o setup não for gerado e medido.
