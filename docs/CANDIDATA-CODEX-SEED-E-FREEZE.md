# Candidata Codex: seed e preparação do freeze

Verificação: 2026-11-02, base de código `86ad8ce`. Não constitui aprovação de freeze, instalação ou distribuição.

## Seed: bloqueio resolvido sem alterar pinos

A cache `.r7-evidence/definitions/clamav` contém `daily.cvd`, obtida pelo FreshClam em 2026-11-01 (log local com teste de base e exit 0). Não corresponde ao artefacto diário fixado para a seed. A tentativa de a usar como fonte falhou corretamente antes de copiar.

A fonte correta já existia em `C:/Users/caioc/.cybersafe-integration/cybersafe-approvals/clamav-seed-r7`, identificada nos logs históricos de packaging. Foi revalidada agora, não aceite apenas pelo registo antigo: quatro ficheiros, 175 916 377 bytes, zero problemas de tamanho/SHA-256/manifesto/licença/allowlist.

Preparada uma cópia nova em `output/clamav-seed-codex-20261102` com o preparador existente. Pinos, formatos e nomes não foram alterados. `daily.cld` conserva SHA-256 `b93e7f501ac1cf9cc5858393609a8a7a683e770e02cf0d8e89dcdfa15bf88e00` e tamanho 86 543 360 bytes.

CVD é o arquivo oficial comprimido e assinado; CLD é a base local não comprimida produzida após aplicação de atualizações incrementais pelo FreshClam. Não são extensões intercambiáveis por renomeação. Fontes primárias: [terminologia ClamAV](https://docs.clamav.net/appendix/Terminology.html?highlight=update), [explicação CVD/CDIFF/CLD pelo projeto](https://blog.clamav.net/2021/03/clamav-cvds-cdiffs-and-magic-behind.html).

O ClamAV vendor 1.5.4 carregou a nova cópia e confirmou ACTIVE por prova de carga real em 6005 ms, usando o teste existente `clamav-load-proof-real.integration.test.js`, caso `base REAL autorizada`. A verificação SHA identifica os bytes fixados; não é uma nova autenticação criptográfica independente do CLD. Não se declara cobertura atualizada indefinidamente: a frescura continua a ser reavaliada pelo runtime.

```powershell
$env:CYBERSAFE_CLAMAV_SEED_DIR = (Resolve-Path output/clamav-seed-codex-20261102).Path
node scripts/prepare-clamav-seed.mjs --check --out $env:CYBERSAFE_CLAMAV_SEED_DIR
node scripts/package-windows.mjs --check
```

Com esta variável, o preflight aceita a seed e o bundle. Resta o gate de fontes/registo de aprovadores. A variável é de processo; não foi gravada no ambiente global do computador. As bases ficam fora do Git.

## Freeze: preparado, ainda não aprovado

O mecanismo existente é `scripts/source-freeze.mjs`; exige `CYBERSAFE_APPROVERS_FILE` a apontar para registo externo ao repositório. O proprietário deve confirmar as identidades reais e quem pode integrar. Nenhum ficheiro de aprovação foi criado nesta etapa e nenhuma aprovação histórica foi reutilizada.

Formato do registo, para preenchimento pelo proprietário fora do repositório:

```json
{"schema":1,"owners":["<proprietário confirmado>"],"integrators":[]}
```

O registo autoriza identidades; não aprova automaticamente uma candidata. A aprovação operacional separada exige `approvedBy`, `candidateId` e `approvedAt`, e deve ser emitida para a candidata exata quando a árvore estiver fechada.

Foi criado apenas `output/codex-source-readiness-20261102.json`, marcado `DRAFT-NOT-APPROVED`, sem approval e sem manifesto utilizável pelo packaging. Inventário: 1816 ficheiros; digest de trabalho `75d7bda2e43fd333d3923cca47fe8eb256b84a45880e8952a22601605597c35b`. Este digest envelhece com qualquer alteração e **inclui os cinco BMPs locais rejeitados**. Não pode ser promovido a aprovação da candidata.

Antes de solicitar freeze: concluir alterações funcionais e visuais aprovadas; resolver o destino dos BMPs sem perder as cópias; rever diff/segredos; testar/buildar o HEAD exato; confirmar seed e payload. Só então pedir aprovação específica, gerar novo manifesto com `--write --approval`, verificar com `--verify` e empacotar. Não executar agora esses passos de aprovação/publicação.
