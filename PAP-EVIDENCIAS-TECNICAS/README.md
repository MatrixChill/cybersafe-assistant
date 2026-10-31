# Evidências técnicas da PAP — índice

Conjunto de oito documentos que sustentam o relatório do Projeto de Aptidão Profissional (PAP).
Descrevem o que foi **observado**, o que foi **executado** e o que **não** foi provado, com
referência ao código do repositório e à candidata interna ensaiada.

> **Base de código:** `MatrixChill/cybersafe-assistant` @ `212cb64c39f74f547d4ebc6c8bff7cc5bcbcdf56`
> **Candidata:** `0.1.10-internal.pap-r5.20261031` — SHA-256 `46718BCD…BD75` (interna, não assinada, não distribuível)
> **Data da recolha:** 2026-10-31

## Regra de leitura

Cada afirmação está marcada pela **natureza da prova**: código inspecionado, teste automatizado,
base de dados real, registo de execução ou ensaio manual. «Existe código» não é apresentado como
«funciona na instalação», e um resultado comunicado por quem executou um ensaio manual não é
apresentado como verificado neste repositório.

## Os oito documentos

| Documento | Conteúdo |
|---|---|
| [MATRIZ-EVIDENCIAS-PROFESSOR.md](./MATRIZ-EVIDENCIAS-PROFESSOR.md) | 19 observações com conclusão, prova, natureza e estado; factos que o relatório pode e não pode afirmar |
| [ESQUEMA-REAL-SQLITE.md](./ESQUEMA-REAL-SQLITE.md) | Esquema real da base (7 tabelas), DDL, relações lógicas e divergência face ao `schema.prisma` |
| [DICIONARIO-DE-DADOS.md](./DICIONARIO-DE-DADOS.md) | Coluna a coluna, com nulabilidade, índices e regras de escrita |
| [MATRIZ-PERSISTENCIA.md](./MATRIZ-PERSISTENCIA.md) | O que persiste, onde e em que formato: SQLite, JSON e JSONL |
| [AUTENTICACAO-E-COMUNICACAO.md](./AUTENTICACAO-E-COMUNICACAO.md) | Registo, login, JWT, revogação e autenticação do *pipe* desktop↔serviço |
| [TREINO-ESTADO-REAL.md](./TREINO-ESTADO-REAL.md) | Gravação e leitura de resultados de treino, incluindo a limitação do `userId` nulo |
| [MOTORES-E-INCONCLUSIVOS.md](./MOTORES-E-INCONCLUSIVOS.md) | Os quatro motores, atribuição de deteções e os 18 inconclusivos do ensaio de 800 ficheiros |
| [TESTES-AUTOMATICOS-VERIFICADOS.md](./TESTES-AUTOMATICOS-VERIFICADOS.md) | Comandos, logs e resultados: 315 PASS / 1 FAIL / 0 SKIP no conjunto dirigido |

## O que fica fora do repositório (e porquê)

Os documentos citam `raw/`, `logs/` e `_work/` como índice de reprodução. Essas pastas **não são
versionadas**, por duas razões concretas:

1. **`raw/` contém cópias de bases de dados reais** (`raw/db-install/db-copy/cybersafe.db`,
   `raw/e2e-api/e2e-cybersafe.db`). Mesmo com o conteúdo pessoal não exportado nos documentos,
   publicar o ficheiro publicaria as contas. Não é admitido.
2. **`logs/` contém caminhos absolutos com o perfil do utilizador** (pastas temporárias dos testes).
   O repositório público não expõe o perfil local.

As pastas ficam retidas localmente com a recolha. Para que a integridade seja verificável sem
publicar o conteúdo, os digests SHA-256 de todos os ficheiros dessas pastas estão em
[`EVIDENCIAS-LOCAIS.sha256`](./EVIDENCIAS-LOCAIS.sha256) (38 entradas, caminhos relativos:
`logs/…`, `raw/…`). `_work/clone-212cb64` é um clone descartável do commit `212cb64` com
`node_modules` ligado por *junction*; não é evidência e não tem digest.

## Como reproduzir os testes dirigidos

Do clone em `212cb64`, com as dependências instaladas:

```bash
cd packages/api
node --test --test-concurrency=1 \
  test/auth-role.test.js test/auth-role-production.test.js test/auth-jwt-secret.test.js \
  test/auth-api-guard.test.js test/r6-l12-logout.test.js test/dev-isolation.test.js \
  test/process-consent.test.js test/process-consent-r2.test.js \
  test/provision-admin.test.js test/rotate-jwt-secret.test.js
```

Os comandos completos, por ficheiro e por *workspace*, estão em
[TESTES-AUTOMATICOS-VERIFICADOS.md](./TESTES-AUTOMATICOS-VERIFICADOS.md) §2.

## Limitações do conjunto

- **Uma instalação, um retrato.** Esquema, contagens e ficheiros observados são desta máquina em
  2026-10-31 e mudam com o uso.
- **Testes no código-fonte, não no instalador.** Os resultados do conjunto dirigido vêm do clone em
  `212cb64`; os registos do ensaio de 800 ficheiros vêm da instalação da candidata. Não se
  transferem conclusões de um para o outro sem esta ressalva.
- **Nada foi corrigido nesta recolha.** As limitações documentadas (treino sem `userId`, quarentena
  sem motor, `schema.prisma` morto, palavra-passe mínima de 6) são registadas, não alteradas.
- **A suíte completa não foi executada.** 315 PASS / 1 FAIL / 0 SKIP é o resultado do conjunto
  dirigido necessário para autenticação, persistência, quarentena e *pipe*.
