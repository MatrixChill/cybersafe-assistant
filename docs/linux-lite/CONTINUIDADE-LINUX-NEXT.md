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

## Sessão e canais partilhados

- `650772f`: identidade `arch-shared`, rotas de releases e download com limites.
- `3bc3933`: delegação FreshClam ao gestor do sistema quando observado.
- `f3bc060`: distribuição Windows, Arch e Nigor documentada. Preview 2 continua
  pública com um único pacote partilhado. Windows v0.2.4 continua Latest.
- `7cd41ca`: falha de persistência distinguida de autenticação e entrada
  temporária explícita. CI Windows e Linux passaram. Candidata interna
  0.2.4-3 construída e instalada no laboratório Arch, 207 ficheiros verificados,
  zero alterações. SHA-256 `c4dba182a134309013828f1a43a850a71cd221ed22936a61b0e74cf776e787c6`.
- A candidata `7cd41ca` inclui a correção de sessão e antecede o novo percurso
  assistido de instalação. Guardar para rastreabilidade. O pacote seguinte deve
  ser construído a partir do commit exato que inclua o novo percurso.
- No pacote `7cd41ca` instalado, o formulário autenticou uma conta sintética
  com «Lembrar-me», recuperou a sessão após reabrir, ofereceu entrada temporária
  sem D-Bus e voltou ao formulário após sair e reabrir. O logout foi exercitado
  separadamente no armazenamento Electron. Windows: app 3080/0 e desktop
  707/0/3 skip com as alterações de sessão e integração gráfica presentes.
- O verificador novo confirmou ao vivo a assinatura da Preview 2 e recusou o
  downgrade de `0.2.4-3` para `0.2.4-2`. Um ensaio A→B instalado permanece uma
  verificação separada.

## Entrega pública Preview 3

- Publicada a pré-release manual `linux-v0.2.4-arch-preview.3` a partir de
  `32e627bbbeaee0b933e2ab505f674499e688c354`. Os onze ficheiros foram conferidos
  por HTTPS e a tag aponta para o commit da CI verde. SHA-256 do pacote de
  112065428 bytes: `54bd4c2914c516cbf969d92db36eebd97d3e531ae9b2a81d65dbb18b65da2a3c`.
- Assinatura Ed25519, leitura do manifesto anexado com o verificador legado,
  disponibilidade para `0.2.4-2`, versão atual para `0.2.4-3`, recusa de downgrade,
  download e reuse de cache verificados. O endpoint `linux-update-channel`
  continua na Preview 2 porque o instalador legado passa ao pacman uma cache
  que pode mudar após a verificação. Para um canal assistido novo, separar o
  feed e o consumidor que suportam cópia protegida e validar o percurso polkit.
- [Entrega e aceitação Nigor](../nigor-handoff/PREVIEW-3.md). O código de entrada
  local por opção da [próxima edição](../nigor-handoff/EDICAO-NIGOR.md) está acima
  da tag Preview 3 na branch. Ainda precisa de pacote, migração e canal próprios.
