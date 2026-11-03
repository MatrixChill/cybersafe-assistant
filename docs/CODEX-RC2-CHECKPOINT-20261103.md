# RC2 — checkpoint técnico Codex

Base ff5af54; worktree codex-final-v020-20261103/repo; branch temporária codex/final-v020-20261103.

Implementado: arranque deixou de desativar a entrada Windows; IPC de autostart recusa DEV, perfil sem autorização, modo de leitura e payload inválido; Configurações relê o estado real após uma alteração. Commit inicial ff81fbc.

Testado automaticamente: 20 testes autostart/foreground; 152 testes atualizador, incluindo HTTPS de laboratório; build ordenado de oito workspaces; typecheck desktop e app. Não houve acesso à VM nem alteração da entrada Windows pessoal. Dependências instaladas com npm ci --ignore-scripts.

Atualizador: infraestrutura existente mantida; confiança de produção continua desativada, publisher/installer bloqueados. Aprovação da chave pública e publicação continuam pendentes; não afirmar atualização pública operacional.

Gestor: fa064a1 já é antepassado da base. Prova instalada do Notepad pendente do proprietário.

Ainda falta nesta missão: concluir validação funcional do autostart (UI, falhas e estado desativado pelo Windows), revisão dirigida de HashDB/WFP, diagnóstico Scanner por medições existentes, regressões afetadas e revisão final de segurança. Não se declara RC2 pronta, não se pede freeze de árvore ainda aberta e não se altera a versão para simular publicação.

VM, source freeze exato, confiança do atualizador, integração main, tag, Release e eliminação de branches dependem dos gates definidos pelo proprietário. Alterações visuais anteriores preservadas no worktree Codex antigo e não trazidas para esta missão.
