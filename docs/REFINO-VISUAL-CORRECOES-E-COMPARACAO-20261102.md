# Correções visuais e comparação orbital

Pedido atual: corrigir os problemas das capturas e comparar duas órbitas reais antes da escolha visual. Esta orientação substitui a proibição anterior de qualquer segmento traseiro **para a variante experimental B**. O quinto perfil continua Personalizado; movimento reduzido é independente. Os dois documentos anexados eram idênticos e foram lidos; as correções explícitas da mensagem mais recente prevalecem sobre sugestões antigas neles contidas.

## Bugs reproduzidos e alterações

- **Indicadores circulares:** o ensaio Electron encontrou SVG de 100 × 60,6875 px sem viewBox. O contentor tinha 100 px, mas o SVG era comprimido pelo layout flexível. Agora tem dimensões explícitas, viewBox e posicionamento absoluto; o contentor não encolhe. O mesmo componente serve CPU/RAM/GPU.
- **PC Center:** removido o scroll interno e a altura forçada da página. O scroll principal do shell volta a governar o cabeçalho e o conteúdo. CPU/RAM/GPU alinham a altura entre si; armazenamento, rede e bateria conservam as alturas naturais previstas pelos testes existentes. As linhas de métricas podem quebrar sem comprimir indicadores.
- **Acentos:** a ponte V2 sobrescrevia os tokens de V1 escolhidos pelo utilizador. A camada de acentos passa a definir o acento V2, foco e seleção; os tokens de segurança não são alterados. Roxo e Rosa têm amostras próprias, evitando que a amostra Roxo usasse a superfície escura do tema. Botões têm nomes acessíveis inequívocos para selecionar cor/material.
- **Configurações:** navegação sem bloco opaco de fundo, largura útil aumentada; removida a mensagem DEV de migração do shell. Isso não é uma declaração de que todas as páginas terminaram o acabamento.

## Duas variantes executáveis, sem substituir a identidade

Comparação disponível apenas na proposta DEV existente (`VITE_CYBERSAFE_ORBITAL_PREVIEW=1`): botões **A · Exterior** e **B · Profundidade**. B não é persistida nem promovida à apresentação definitiva.

- **A:** raios maiores e precessão visível dos planos em ciclos independentes de 24/32 segundos. Mantém a trajetória projetada fora do corpo. O teste de separação cobre 160 segundos, com a oscilação global incluída.
- **B:** recupera a rotação mais ampla anterior com raios 1,45/1,75. Segmentos traseiros podem ser ocultos pelo corpo opaco e os frontais continuam na mesma cena. Usa profundidade real de Three.js; não há máscara CSS nem PNG colocado sobre os anéis.
- **Corpo V3:** espessura de 0,42, bevel real, laterais mais escuras e iluminação existente ciano/violeta; recurso oficial preservado. O plano da marca fica separado da face para evitar z-fighting.
- **Motores:** quatro símbolos CSS discretos voltam a ser visíveis sobre a cena, com opacidade contida; quatro nós 3D pequenos movem-se à volta. Continuam derivados do relatório dos motores, sem inferir proteção por animação.
- **Partículas:** quantidade e intensidade reduzidas, limitadas à área visual do núcleo e desligáveis no Personalizado. Não há starfield global nem partículas sobre o texto do hero.

## Referências técnicas consultadas nesta execução

| Fonte primária | Técnica útil / decisão |
|---|---|
| [React Bits Orb](https://reactbits.dev/backgrounds/orb) | Movimento de luz e brilho circular como referência estética; não substituir a marca por um orb genérico. |
| [Magic UI Orbiting Circles](https://magicui.design/docs/components/orbiting-circles) | Ritmo e direção independente dos nós; reutilizar a adaptação já existente no projeto. |
| [Magic UI Particles](https://magicui.design/docs/components/particles) | Controlo de quantidade, escala e movimento; manter a implementação local simples. |
| [Aceternity Glowing Effect](https://ui.aceternity.com/components/glowing-effect) | Borda luminosa localizada, não iluminação constante em todas as superfícies. O SpotlightCard existente é preservado. |
| [Rare UI Fluid Orb](https://www.rareui.com/components/fluidorb) | Movimento ambiente e frame estático com movimento reduzido; inspiração, sem copiar código nem importar a biblioteca. |
| [21st Liquid Glass](https://21st.dev/community/components/explore/liquid-glass-components), [3D UI](https://21st.dev/community/components/explore/3d-ui) | Comparação de superfícies e composição; a coleção não constitui prova de compatibilidade, licença ou desempenho de cada componente. |
| [Three.js Clearcoat](https://threejs.org/examples/webgl_materials_physical_clearcoat.html), [Material](https://threejs.org/docs/pages/Material.html), [Bloom](https://threejs.org/examples/webgl_postprocessing_unreal_bloom.html) | Geometria opaca, profundidade e highlights locais. Não se acrescentou pipeline de bloom de ecrã inteiro. |
| [Codrops Matrix Sentinels](https://tympanus.net/codrops/2025/05/05/matrix-sentinels-building-dynamic-particle-trails-with-tsl/), [Glass Torus](https://tympanus.net/codrops/2025/03/13/warping-3d-text-inside-a-glass-torus/) | Referências avançadas para rastos e transmissão. Não se introduziram compute shaders, Drei, React Three Fiber ou refração pesada nesta correção. |

As páginas foram consultadas, mas não se mediu o desempenho desses sites. Não foram instalados componentes, pacotes, skills ou snippets externos. Não se presume que as licenças de todos os componentes comunitários sejam iguais. A implementação desta ronda reutiliza Three.js, Motion e componentes já presentes.

## Evidência e limites

Artefactos locais: `output/visual-refinement-20261102`. Os ensaios usam perfis Electron isolados e mantêm a evidência fora do Git. `--ui-repair-proof` reproduziu a falha do SVG e dos acentos antes da correção e passou depois; mede os indicadores disponíveis e distingue a ausência de leitura GPU, em vez de inventar um valor.

Capturas em larguras 1100/1440/1900 para os indicadores. Comparação orbital em duas variantes com vídeo real por CDP; larguras 900/1280 e escalas emuladas 1/1,25/1,5. A codificação do vídeo não mede FPS da aplicação. Não se declara ganho de CPU/GPU ou validação de DPI nativo.

Permanecem gates: preferência visual A/B pelo utilizador; validação em drivers e DPI nativo adicionais; acabamento final de todas as páginas e setup definitivo. Sem alterações à lógica de proteção, terminação de processos, quarentena, Scanner, MATRIX, updater ou seed; sem main, tag, Release ou freeze.

## Resultado verificado desta ronda

- Build/typecheck aprovados; suite da aplicação: **2 890 testes, zero falhas**. Mantém-se o aviso de bundles superiores a 500 kB. Um mock de AppearanceContext usado pelos testes de ligação foi atualizado para fornecer os efeitos que o App passou a consumir; não se alterou a lógica de ligação ou proteção para fazer os testes passar.
- O teste adicional do painel revelou overflow transitório de 17 px: largura útil 1209, scrollWidth 1226. A causa era a transição horizontal de 20 px entre páginas. Passou a deslocamento vertical de 6 px, respeitando `effects.transitions`; resultado posterior **1209/1209**. Não se escondeu o conteúdo com overflow-x hidden.
- `--ui-repair-proof`: sete acentos distintos; verde/âmbar/vermelho sem mudança; cor recuperada após reload; materiais liquid/light/solid aplicados; vista simples em 900/1440 px e escalas emuladas 1/1,25/1,5; indicadores disponíveis em 1100/1440/1900 px com SVG 100×100 e viewBox correto. A leitura GPU não esteve disponível em parte dos ensaios: não se preencheu artificialmente o sensor para a captura.
- `--orbital-compare`: quatro símbolos orbitais presentes e visíveis; vídeos reais `orbital-exterior-real-electron.mp4` (cerca de 44,57 s recolhidos) e `orbital-depth-real-electron.mp4` (cerca de 44,39 s). Codificação 12 fps, sem interpretação como benchmark. Capturas de cada variante no arranque e após 11/22/33/44 s.
- `--orbital-fallback-proof`: cinco perfis, persistência, movimento reduzido e fallback CSS por WebGL desligado passaram após a revisão das órbitas. Os seletores A/B só aparecem na proposta DEV com 3D permitido.
- Todos os ensaios finais tiveram `cleanup.allDead=true`. A primeira tentativa foi recusada porque a sessão DEV do utilizador ocupava as portas; o utilizador fechou-a e os ensaios seguintes usaram perfis isolados. Nenhum processo alheio foi terminado.
- Capturas finais estáveis em `ui-final-stable/`: o harness espera pelas animações finitas de entrada antes de fotografar, para não confundir uma captura a meio do fade com um fundo preto persistente. A faixa opaca das categorias foi removida no código.

Reprodução: `node scripts/dev-quarantine-electron-proof.mjs --ui-repair-proof`, `--orbital-compare` ou `--orbital-fallback-proof`. Requerem as bases locais do harness e portas disponíveis. As capturas/vídeos ficam em `output/visual-refinement-20261102`; a aprovação visual A/B continua em aberto.
