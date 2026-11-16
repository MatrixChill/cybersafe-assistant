# Continuidade Linux Next — 16/11/2026

- Branch `codex/nigor-arch-20261113`, PR #5; sem merge. Base recebida `ea0acba`.
- MIT aprovado e avisos preservados. Previews públicas anteriores intactas;
  Windows v0.2.4 não é alterado.
- Entregas: [Linux Next](../nigor-handoff/LINUX-NEXT-20261116.md) e
  [Lembrar-me](../nigor-handoff/SESSAO-LEMBRAR.md).
- Commits: `5e60414` sessão Nigor/porta-chaves; `c8c7229` quarentena EXDEV;
  `da1eee5` clamd opt-in, case sensitivity, processos POSIX e raízes adicionais;
  `4773c60` identidade/frescura do daemon; `8a9da12` contrato Nigor/C++ e receita
  pkgrel 3. Correções posteriores ficam no log da branch.
- Laboratório Arch/WSL2, sem dados Windows. Backend 317 benignos 1,845 s;
  watcher/motores 317 benignos + EICAR: P95 7,60 s, isolamento EICAR 5,76 s.
  Não comparar diretamente com o corpus Nigor.
- EXDEV/restauro em volumes reais distintos e falhas injetadas. USB/exFAT
  físicos por validar. Permissões e manifesto falham com recuperação explícita.
- Prova clamonacc numa pasta descartável: benigno permitido, EICAR negado;
  processos encerrados. Produto continua post-write, sem prevenção instalada.
- GNOME Keyring real: dois processos Electron gravaram/recuperaram uma sessão
  sintética. Falta confirmação no desktop Nigor real.
- Windows desktop 704/0/3 skip; app 3078/0. Core Linux amplo 1242/18/27 skip/1
  TODO; serviço 903/121/1 skip. Falhas reproduzidas na base anterior; não
  declarar suítes Linux amplas aprovadas. CI faz build e grupos dirigidos.
- Artefactos/logs privados: `output/linux-next/`, `output/linux-next-package/`.
  O pacote pkgrel 3 de `8a9da12` é **intermediário**, não distribuir após novas
  alterações; produzir o final da árvore consolidada.
- Próximo gate: payload final instalado, CI exata, hashes/licenças e assinatura
  Ed25519 do manifesto antes de atualizar o canal. Não publicar stable Linux.
- Pendências: USB/exFAT, Nigor/Wayland/keyring/tray, prevenção de produção,
  redescoberta geral de motores, corpus YARA representativo e testes legados.
  Não modificar Windows pessoal ou PAP. Nenhuma destas pendências é PASS.
