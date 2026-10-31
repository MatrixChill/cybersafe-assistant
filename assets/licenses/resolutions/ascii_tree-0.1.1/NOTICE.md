# ascii_tree 0.1.1 — resolução documental pendente (NÃO fecha o gate)

**Estado: BLOCKED.** Este documento preserva a evidência disponível e explica por que o
licenciamento continua pendente. Não é a notice canónica do detentor, não declara
conformidade jurídica e não foi enviado a ninguém.

## Identificação verificada

- crate: `ascii_tree` 0.1.1, publicado no crates.io em `2018-06-05T19:32:11Z`.
- arquivo oficial: `ascii_tree-0.1.1.crate`, 1 781 bytes,
  sha256 `ca6c635b3aa665c649ad1415f1573c85957dfa47690ec27aebe7ec17efe3c643`;
  membros e hashes em `SOURCE-PROOF.json`.
- licença declarada no manifesto do crate: **MIT** (`Cargo.toml.orig` e metadata oficial).
- autor indicado no manifesto: `d.maetzke@bpressure.net` — é metadado do crate,
  **não** um aviso de copyright.
- repositório declarado: `https://github.com/bpressure/ascii_tree`, que respondia
  HTTP 404 na verificação de 2026-10-24 (evidência em `FINDING-ASCII_TREE-20261024.md`,
  sha256 `dcd350998f0c4382f0c09af2764310eead926e33b9ca41dc1ddf7ddf5dd3df26`).

## O que o upstream publica

- O `include` do próprio crate lista apenas `.gitignore`, `Cargo.toml`, `src/*.rs`
  e `README.md`; não existe `LICENSE`, `COPYING` ou `NOTICE` no arquivo.
- Nenhum dos quatro membros contém `copyright`, `(c)` ou `©`: **0 ocorrências**
  (verificado membro a membro; hashes em `SOURCE-PROOF.json`).
- **Não foi encontrado qualquer aviso de copyright autêntico** para esta versão.

## O que este pacote contém

- `MIT.txt`: o texto integral da licença MIT, no template SPDX, reproduzido sem
  alterações e **sem preencher** o placeholder `<year> <copyright holders>`.
- `SOURCE-PROOF.json`: prova do arquivo, dos membros, da cadeia de produção e da
  ausência de aviso.
- `NOTICE.md`: este documento.

Não foi inventado titular, ano, aviso nem autorização. Não se afirma que o upstream
publicou este texto. O autor não foi contactado.

## Avaliação e limite

A obrigação MIT de incluir o aviso de copyright e a permissão é reconhecida. O
detentor nunca publicou a primeira; este pacote inclui a segunda e identifica o autor
apenas pelo metadado oficial. Isto é uma **resolução documental de boa-fé**, não a
notice canónica, e pode não satisfazer literalmente o requisito de incluir o aviso de
copyright. Por isso o gate permanece **BLOCKED** até decisão do utilizador ou
confirmação autorizada do titular.

Não é parecer jurídico. A cadeia que incorpora a crate é
`@litko/yara-x@0.5.0 → yara-x@1.10.0 → yara-x-parser@1.10.0 → ascii_tree@0.1.1`.
