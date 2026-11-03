# Updater visual — plano de implementação

Objetivo: janela reutilizável, nove estados e laboratório DEV sem IPC nem ativação de produção.
Arquitetura: modelo puro visual + adaptador conservador AppUpdateSnapshot; componente apresentacional; página de laboratório isolada pelo gate DEV em main.tsx. Reutilizar logo e tokens oficiais, sem dependências novas.

- [x] Testar progresso desconhecido, gates, ausência de sucesso inferido e render acessível.
- [x] Implementar modelo, janela, estilos responsivos e movimento reduzido.
- [x] Adicionar laboratório manual com todos os estados e indicação permanente de demonstração.
- [x] Executar testes dirigidos, typecheck/build e preview; registar limites da integração futura.

Não alterar backend, versão, manifesto congelado, instalação pessoal ou gates. Preparar instalação e conclusão são estados visuais: não existem ainda no snapshot e exigem evidências futuras do diário/rearranque. Instalação não é cancelável nesta UI. Fechar é callback do host, nunca encerramento implícito do instalador.
