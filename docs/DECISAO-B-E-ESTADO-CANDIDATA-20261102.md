# Variante B aprovada e estado da candidata Windows

Base confirmada antes da implementação: HEAD local e remoto `51fc33981f4ac1a734de6483238510696c7263fb`, branch `codex/pap-final-integration-20261102`.

## Aprovação e aplicação

O utilizador aprovou expressamente **«A VARIANTE B — PROFUNDIDADE COMO DIREÇÃO VISUAL PRINCIPAL DO NÚCLEO CYBERSAFE»**. Esta decisão substitui o estado anterior de comparação A/B pendente, mas não aprova automaticamente o setup, um freeze ou uma Release.

A apresentação normal inicia agora em B, sem flag de laboratório. O CoreScene normal usa o corpo opaco com espessura e bevel da variante aprovada, preservando profundidade real, anéis independentes, marca oficial e nós derivados dos estados dos motores. Foi removido o caminho normal que ainda usava a placa translúcida antiga. A continua disponível no laboratório DEV; não é o valor inicial. Fora desse laboratório não há seletor A/B nem legenda de proposta não aprovada.

O novo teste SSR do consumidor real falhou antes da integração porque o default era exterior; passou depois. Testes dirigidos: 6 aprovados. Suite app: **2 891 aprovados, zero falhas**. Build/typecheck app aprovados, com o aviso já existente de bundles superiores a 500 kB.

`node scripts/dev-quarantine-electron-proof.mjs --approved-orbital-proof` passou sem `VITE_CYBERSAFE_ORBITAL_PREVIEW`: confirmou variante depth, canvas WebGL, ausência de seletor/flag, perfis, persistência, movimento reduzido e fallback com WebGL desligado. Cleanup: todos os filhos terminados.

Evidência: `output/orbital-b-approved-20261102/product-default/orbital-b-approved-product.png` e `appearance-facts.json`. As cores/limitações de proteção pertencem ao perfil isolado de ensaio; não se alterou qualquer motor para obter a imagem.

## Falha de WebGL: prova controlada fechada

O modo de teste anterior não ativava o domínio Page antes da injeção. O harness passou a ativá-lo e a instalar uma função isolada no documento, com execução imediata. Não se mudou a aplicação para forçar um resultado verde.

`--webgl-failure-proof` passou: indisponibilidade de criação de contexto injetada na plataforma → fallback CSS → aviso dispensado e dispensa recuperada após reload → recuperação do canvas após remover a injeção e fazer reload. Todos os processos de ensaio terminaram. Não é uma medição de desempenho nem um ensaio de driver/GPU física incompatível.

## Setup: composição executável, ainda não instalador final

O estudo anterior dos oito percursos foi preservado em commit próprio e em `installer-preview-before-layout.nsi`. O mesmo protótipo NSIS foi evoluído, sem criar outra cadeia de instalação: janela de 720×460 a 96 DPI, escalada pelo DPI da própria janela; área útil medida com RECT; navegação lateral, marca oficial, título, conteúdo e estado separados; moldura escura quando o Windows a suporta. Foram corrigidos um erro inicial de medida e o separador herdado do wizard, observados em capturas reais.

Fonte: `scripts/prototypes/installer-native-preview.nsi`. Executável: `output/installer-native-preview/CyberSafe-native-branded-preview.exe`. SHA-256: `e53d9d22e81fa5db8660b4c84ab1d0b87840744a73c15b2794534c48d294a1be`.

Compilação aprovada; aviso esperado do NSIS: não há página instfiles e nenhuma secção será executada. O protótipo não instala, não descarrega, não consulta instalações, não cria serviços/atalhos nem apresenta percentagens de progresso. A abertura e o layout foram observados; a janela foi fechada antes de concluir os cliques nos percursos. A aceitação de navegação, múltiplos DPI e acabamento do setup continua pendente. O botão e a lista ainda são controlos nativos; não se declara o acabamento final aprovado.

Captura: `output/orbital-b-approved-20261102/setup-native-welcome.png`. Não se integrou esta composição no instalador produtivo nem se alteraram os cinco BMPs locais preexistentes.

## Packaging e VM

Executado `node scripts/package-windows.mjs --check --json`, com a seed local preparada. Resultado factual:

- ClamAV 1.5.4: bundle aprovado, 45 ficheiros, sem problemas.
- Seed: aprovada, 4 ficheiros, 175 916 377 bytes, pinos preservados.
- YARA 4.6.0: runtime aprovado, 4 ficheiros, sem problemas.
- Obrigação documental de licenças: fechada pelo mecanismo existente.
- Packaging bloqueado por `approver-registry-missing`: `CYBERSAFE_APPROVERS_FILE` não definido. O manifesto antigo existente não é aprovação válida para a árvore atual.

Relatório: `output/orbital-b-packaging-check.json`. Não foi criado freeze, candidata empacotada ou instalação. A aprovação da B não foi usada como aprovação fictícia de fontes. A árvore ainda inclui BMPs locais sem decisão final e o setup ainda necessita de integração/aceitação visual antes de um freeze exato.

Estados separados: **app compilada e B validada em DEV isolado**; **protótipo de setup compilado e aberto**; **candidata empacotada pendente**; **instalação/upgrade/remoção na VM pendentes**; **Release estável não aprovada**. Não se fizeram instalações no computador pessoal, merge na main, tag ou Release.
