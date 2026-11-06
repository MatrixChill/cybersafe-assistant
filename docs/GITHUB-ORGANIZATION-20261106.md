# Organização pública do GitHub — 06/11/2026

## Branches e preservação

PR #3 integrado por merge normal, após confirmar CI aprovada, ausência de conflitos e revisão do diff. A main contém o commit da tag v0.2.4. Mantidas no GitHub: main e experimental/linux-lite.

Removidas apenas as referências remotas já contidas na linha integrada: fix/v021-realtime-coverage, fix/v023-stability, fix/v024-clamav-proof, pap/rc9-protection-preview, pap/rc12-final-candidate, release/v0.2.0-final e release/v0.2.1. Não se eliminaram tags, releases, worktrees nem branches locais em uso.

Antes da remoção, foi criado e verificado um bundle Git recuperável com todas as referências e exportados os inventários de branches e releases, fora do repositório. Não houve force push nem reescrita de histórico.

## Inventário e decisões sobre ficheiros

Árvore inicial auditada: 2168 ficheiros versionados, 65663495 bytes. O inventário completo de caminhos, tamanhos, finalidade e decisão foi guardado no backup local. Nenhum ficheiro versionado com extensão .log/.tmp/.bak/.old, nem artefacto dentro de output, foi encontrado.

| Grupo | Finalidade / dependências | Decisão |
|---|---|---|
| Código e testes | Workspaces e contratos automatizados | Preservar integralmente |
| Scripts e workflows | Build, freeze, proveniência, assinatura e CI | Preservar; workflows não alterados |
| Vendor, definições e licenças | Inputs de análise e packaging | Preservar; não remover binários por serem binários |
| Branding, incluindo legacy | Assets e proveniência da migração; utilização pode ser dinâmica | Preservar duplicados sem prova suficiente de remoção segura |
| Documentos datados e checkpoints | Evidências PAP, diagnósticos e reprodução de decisões antigas | Preservar, identificar como históricos e navegar por índice |
| README principal | Apresentação pública | Substituído por uma entrada mais curta com links para guias |
| docs/images | Capturas reais da v0.2.0 | Preservar com versão explícita; não anunciar como capturas atuais da v0.2.4 |

**Ficheiros removidos: nenhum.** Não havia lixo público comprovadamente descartável. A limpeza consistiu na remoção segura de branches redundantes, redução do README, navegação documental, correção de descrições desatualizadas e separação entre factos atuais e arquivo histórico. Os artefactos locais ignorados não foram apagados.

## Verificações de privacidade e segurança

Pesquisa por padrões de tokens de fornecedores/GitHub e cabeçalhos de chaves privadas nos ficheiros textuais versionados, e padrões de credenciais no XML dos relatórios DOCX. Só apareceram três ocorrências de cabeçalhos em fixtures de segurança deliberadamente falsas; foram inspecionadas. Não se publicou email, morada ou credencial pessoal. Esta pesquisa não é certificação universal de ausência de segredos no histórico ou em todos os formatos binários.

Foram verificadas referências locais dos novos guias/README e a validade XML dos banners SVG. Capturas históricas não foram alteradas para simular outra versão. Nenhum build, versão do produto, configuração do updater ou binário publicado foi alterado por esta limpeza.

## Perfil e limitações

Criado o repositório público MatrixChill/MatrixChill, com apresentação em PT-PT, tecnologias usadas, destaque CyberSafe e Linux Lite explicitamente experimental. Sem estatísticas artificiais nem contactos privados. Descrição e tópicos do CyberSafe configurados; nenhuma homepage fictícia criada.

O perfil público foi aberto no navegador e a apresentação confirmada visualmente. Fixar o repositório permanece manual: no perfil autenticado, abrir Customize your pins, selecionar cybersafe-assistant e guardar. A API GraphQL disponível não expõe uma mutação para fixar repositórios e o navegador de verificação estava sem sessão iniciada.
