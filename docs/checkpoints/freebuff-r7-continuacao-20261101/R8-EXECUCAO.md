# R8 — execução dirigida

Data: 2026-11-01
Branch: `freebuff/r7-final-integration-20261101`
Base da missão: `c5d826c86d7992d66351aaf0ab5827784dac2ae2`
`main` intocada: `21fefa69352516c188f99c665966d4443588aa2b`

## Entregue

- `1204919` — a secção original “Definições de segurança” do Otimizar deixou de usar a grelha de três colunas de `.row-item`; tem `.optimize-source-row`, duas colunas e uma coluna abaixo de 720 px. A secção duplicada “Definições e motores” foi removida. Estados individuais de ClamAV, YARA e HashDB preservados.
- `1204919` — `quarantine-path-policy.ts` recusa Windows, Program Files, ProgramData, raiz do serviço e caminhos com reparse point antes de qualquer rename. As defesas de hash, inode, symlink, hardlink e identidade do `QuarantineManager` foram preservadas.
- `0b944ef` — `classifyInconclusiveReason` distingue `timeout`, `invalid-output`, `file-changed`, `archive-incomplete` e `cancelled` apenas quando o detalhe do motor contém o sinal; sem sinal mantém a causa genérica. Contrato partilhado e rótulos PT-PT alargados.
- `0b944ef` — o bloco de processo enviado à MATRIX ordena usar os valores de `selectedProcess`/`trends`, comparar a mesma instância, dizer quantas amostras existem e admitir ausência de tendência; proíbe inferir malware do consumo e exige risco ao recomendar fecho.

## Testes executados

- `packages/service/test/quarantine-path-policy.test.js`: 3 PASS.
- `packages/service/test/inconclusive-classification.test.js`: 2 PASS.
- `packages/api/test/recovery-process-validation.test.js`: 2 PASS.
- `packages/app` focado (`p0-design-otimizar` + `quarantine-display`): exit 0.
- `npm run typecheck -w @cybersafe/app`: exit 0.
- Build de `packages/api`: exit 0.

## Limitações e pendências

- Não houve captura Electron antes/depois: a validação visual do Otimizar continua pendente; o teste é estrutural/SSR, não prova renderização instalada.
- Não existe teste vm dedicado do IPC `service:set-quarantine-policy` e do preload; a cadeia de serviço está testada, o canal Electron não.
- A instrumentação interna por motor (ClamAV/YARA/HashDB/native/ZIP) não foi concluída; as fases externas do scanner já registadas não provam a meta de cinco minutos.
- MATRIX online, atualizações oficiais e WFP continuam bloqueados por credenciais, chave/manifesto de produção e provisionamento privilegiado. Nada foi inventado nem ativado.
- O `source-freeze.approved.json` não foi reescrito nem aprovado. Não há R8 gerada.
