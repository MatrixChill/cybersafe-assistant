# Propostas para aprovação — Orbital V3 e setup

Estado: propostas isoladas, não aprovadas. Não é uma candidata instalada. Capturas em `output/codex-review-20261102`, fora do Git; são janelas reais, não imagens geradas. As contas e métricas mostradas pertencem ao perfil sintético de ensaio.

## Núcleo Orbital V3

Código: `943accb`. Reutiliza CoreScene, recursos oficiais, iluminação, gestão de WebGL e contexto de aparência existentes. Corrige na proposta uma limitação concreta: rodar um torus simétrico apenas no seu próprio eixo quase não altera o aspeto; agora os dois planos mudam independentemente, em sentidos/velocidades diferentes. O núcleo CSS é ocultado quando a cena WebGL da proposta existe, mantendo-o como fallback.

Ativação exclusiva em DEV: `VITE_CYBERSAFE_ORBITAL_PREVIEW=1`. Em produção, o flag não ativa a proposta. Build de produção passou; a legenda de proposta não aparece no JS produzido. Não foi substituída a identidade aprovada por defeito.

Capturas: `dashboard-before.png` (referência anterior, 1200 px); `orbital-v3-proposal-a.png` e `orbital-v3-proposal-b.png` (1280 px, separadas por 1,2 s), `orbital-v3-reduced-motion.png`, `orbital-v3-css-fallback.png`. Os tamanhos diferentes impedem comparações métricas de layout; a proposta diz respeito ao núcleo, não a uma reformulação do Dashboard.

Provas: dois testes geométricos verificam mudança efetiva dos planos e inclinações distintas. O ensaio `node scripts/dev-quarantine-electron-proof.mjs --orbital-proof`, com a base local explicitamente configurada no harness, confirmou canvas WebGL, preferência de movimento reduzido e fallback CSS. Cleanup: todos os filhos terminaram. Não foi medido consumo de GPU nem validado hardware fraco/driver na VM; não se declara essa aceitação.

Decisão pedida: aprovar ou ajustar a direção específica do núcleo (planos ciano/violeta independentes, sem acrescentar partículas ou alterar logótipo). A aprovação não abrange automaticamente todas as páginas nem o setup.

## Controlos funcionais de aparência

`15f1f7c` expõe nas Configurações os setters que já existiam: movimento, desempenho visual e WebGL. Persistência confirmada após reload no Electron isolado: reduced/economy/webgl=false, com movimento efetivo reduzido. Rótulos distinguem permissão de WebGL de disponibilidade real. Se storage falhar, a UI avisa que a preferência vale apenas para a sessão.

Captura: `appearance-controls-persisted-real.png`. Escalas de renderização 1, 1,25 e 1,5 foram emuladas por CDP e não apresentaram overflow; não são ensaios de DPI nativo do Windows. Não se alteraram definições de segurança do computador.

## Estudo nativo NSIS

Fonte: `scripts/prototypes/installer-native-preview.nsi`, commit `5acb9cd`. Compilado com o NSIS já existente na cache do electron-builder, versão lida de `product-version.json`, ícone oficial atual e cores dos tokens Núcleo. Executável local: `output/installer-native-preview/CyberSafe-native-preview.exe`.

SHA-256: `faf502ad067741518e083b18ff36ae5def7daaaf1c30316cf1ac07816b6b3705`.

Capturas: `native-before-selection.png`, `native-install-proposal.png`. A seleção foi exercitada e mudou o texto; não houve instalação. O script não tem payload, operações de registo, serviço, atalhos, download ou desinstalador; a secção é vazia e não há página instfiles. O aviso do compilador “no sections will be executed” é esperado neste protótipo. Corrigiram-se a codificação UTF-8 e os botões cortados observados na primeira tentativa.

Este estudo **não satisfaz ainda o setup final**: a moldura e rodapé continuam nativos, alguns detalhes de layout precisam de refinamento e só há composição demonstrativa, sem páginas de progresso/erro/desinstalação reais. Não foi integrado no instalador do produto e não usa os cinco BMPs rejeitados.

| Opção | Evidência atual | Consequência |
|---|---|---|
| Personalização nativa avançada do NSIS existente | Diálogo programático compilado e executado, ícone oficial, labels/controlos acessíveis; hooks reais já existem no instalador | Menor alteração da cadeia de instalação. Próximo protótipo deve unificar também moldura, rodapé e página de progresso real, sem prometer animações Web. |
| Interface própria ligada ao NSIS | Ainda não prototipada nem validada | Exigiria contrato autenticado de progresso/erros/cancelamento, supervisão do processo instalador, DPI/foco, reparação e desinstalação; não basta abrir um segundo executável. |

Direção técnica proposta: continuar primeiro a personalização nativa, preservando o NSIS/electron-builder e a extração real. Só avaliar um shell separado se um protótipo completo demonstrar que os limites nativos impedem a identidade aprovada. Nenhuma opção está aprovada por este documento.

## O que continua pendente

Terminação individual instalada e upgrade com dados preservados: VM autorizada. Quarentena: UI isolada e pipe real autenticado foram provados separadamente, não como uma única instalação empacotada. Scanner: falta ensaio comparável de desempenho com cobertura final. MATRIX online: bloqueio documentado, sem nova tentativa. Freeze: exige árvore fechada, BMPs definitivos e registo/aprovação externos reais. Sem merge, tag ou Release.
