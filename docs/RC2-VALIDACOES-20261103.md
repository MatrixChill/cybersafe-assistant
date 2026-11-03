# RC2 — validações técnicas de 3 novembro 2026

Worktree: codex-final-v020-20261103/repo. Base ff5af54. Correções autostart ff81fbc e 173311a; testes reconciliados em fa88a3e.

Resultados executados:
- App: 2899 passaram, zero falhas.
- Desktop: 656 passaram, zero falhas. Dois testes antigos foram corrigidos para respeitar a nova recusa de escrita DEV; o teste de projeção segura continua no modo empacotado.
- Serviço: 961 + 12 passaram, zero falhas.
- Core: 1081 passaram, zero falhas, 31 ignorados, um TODO. Os ignorados incluem carga real ClamAV; não são validação VM.
- Atualizador: 152 passaram (incluídos na suite desktop), incluindo transporte HTTPS de laboratório; confiança de produção e execução assistida continuam bloqueadas conforme o contrato.
- Build ordenado dos oito workspaces e typechecks de app/desktop aprovados. Motor C++ construído por CMake/Visual Studio.
- Scanner: o teste inicial falhou honestamente com Native indisponível. Após construir o binário, os dez testes de batch/cache passaram sem alterar veredictos ou cobertura. Não se executou o benchmark instalado de 800 ficheiros, nem se declara resolvido o tempo de 594 segundos sem logs equivalentes.
- Gestor individual, HashDB/WFP e inconclusivos: testes dirigidos executados, salvaguardas preservadas. Não houve terminação de processos pessoais nem ativação WFP.

Packaging --check: nenhum input em falta; ClamAV 1.5.4, 45 ficheiros/139195536 bytes e seed de quatro ficheiros/175916377 bytes aprovados. Bundle reutilizado por cópia de leitura do worktree RC1 e validado pelos pinos. Registo externo de aprovadores existente localizado e aceite. Único gate reportado pelo preflight: manifesto de source freeze aprovado ausente.

Inventário não aprovado: output/rc2-validation-20261103/source-inventory.unapproved.json, 1849 entradas, digest 268882e07a96e95ff6ca4446d798d9081d387c776e58d9e4c47a0670c21c2790. approval=null; não é freeze e não foi usado para empacotar.

Pendências reais: aprovação do freeze exato para uma RC2 interna; geração do setup/payload/checksum; ensaios humanos de instalação, autostart após reinício, tray físico, Notepad, Scanner, upgrade/reparação/desinstalação na VM. Não aceder à VM nesta missão. A confiança pública do atualizador, merge main, tag, Release e limpeza de branches continuam a precisar de autorização própria.

Este marco é TESTADO AUTOMATICAMENTE. Candidata empacotada: BLOQUEADA pelo freeze. Validação VM: NÃO EXECUTADA. Nenhum sucesso instalado ou Release estável é declarado.
