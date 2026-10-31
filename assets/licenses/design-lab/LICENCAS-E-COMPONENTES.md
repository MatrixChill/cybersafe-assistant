# Componentes, origem e licenças

Registo para avaliação local no Design Lab. Os estados aprovados abaixo significam que a experiência foi adaptada para este protótipo, nunca que o componente está aprovado para integração comercial. `references/` guarda snapshots das páginas, código, versões e licenças consultadas.

| Componente visível | Fonte e decisão | Licença / dependências | Desempenho e movimento | V1 → V2 |
|---|---|---|---|---|
| Refração da superfície B | Aceternity Liquid Glass, código do registry adaptado em `src/vendor/AceternityGlass.tsx`; refrata o fundo no Chromium e degrada para frost | A página do componente não declara uma licença clara. Manter apenas no laboratório local e confirmar direitos antes de distribuir ou integrar. React, SVG, ResizeObserver, backdrop-filter | Mapa de deslocamento gerado ao redimensionar; fallback frost / opaque | Blur CSS → refração observável |
| Shader C | Liquid Glass Studio, renderer GLSL original de Charles Yin adaptado em `src/StudioRenderer.tsx`; textura de calibração criada localmente; não foram usados fundos fotográficos do projeto | MIT, Charles Yin. Conversão de cor inclui `GLSL-Color-Functions`, MIT, Adam Lastowka. WebGL2 nativo | Um único desenho por input/redimensionamento; DPR limitado pelo perfil; fallback CSS em perda de contexto | Shader experimental pequeno → shader de dispersão, Fresnel e glare numa cena maior |
| Aurora | React Bits, `src/vendor/Aurora.tsx`; shader e ciclo de vida adaptados para pausar em movimento reduzido, ecrã oculto e perda de contexto | MIT + Commons Clause, David Haz. React e WebGL2. Requer manter a licença e não vender/redistribuir o componente isoladamente | Duas camadas, DPR controlado; fallback estático | Gradiente CSS → fundo WebGL opcional |
| Spotlight Card | React Bits, `src/vendor/SpotlightCard.tsx` e CSS; luz por cursor/foco aplicada aos cartões de motores | MIT + Commons Clause, David Haz. React, CSS | Sem luz ambiente; pausa em repouso, fora do ecrã e com movimento reduzido | Borda fixa → luz local acionada por interação |
| Orbiting Circles | Magic UI, adaptação de transformações em `src/Effects.tsx`; sem Tailwind | MIT, Magic UI. React e CSS | Quatro nós; animação desligada com movimento reduzido | Órbitas sem significado → quatro nós identificados |
| Input agrupado | 21st.dev, shadcn, página exata `https://21st.dev/@shadcn/components/input/grouped-with-button`; estrutura observada e reescrita em HTML/React no Playground | Página marca MIT; exemplo original usa React/Tailwind e Button; esta adaptação não importa código de terceiros nem Tailwind | Campo local, resposta fictícia, sem animação | Campo e ação separados → composição agrupada |
| Núcleo tridimensional | Geometria própria Three.js em `src/CoreScene.tsx`, com textura do monograma CyberSafe | Three.js MIT, versão 0.186.1; asset CyberSafe é do staging, direitos de distribuição a confirmar com o responsável da marca | Geometria/luzes reais, renderizador limpo ao desmontar, fallback de órbitas 2D | Escudo Lucide genérico → monograma original sobre núcleo hexagonal |
| Poeira de dados | Canvas 2D próprio em `src/Effects.tsx` | Código local, sem dependência | 20–130 pontos; pausa fora do ecrã/aba e com movimento reduzido | Ausente → partículas temáticas opcionais |
| Grelha e fundo da demonstração | Código local; SVG Chart existente preservado | Código local | Sem loops | Painéis maioritariamente opacos → material e luz por identidade |

O pacote `react-bits` conserva texto da licença no repositório. A licença não permite vender, sublicenciar ou redistribuir os componentes isoladamente; permite utilizá-los como parte de um produto. Os termos públicos do Aceternity que encontramos descrevem sobretudo conteúdo Pro e não resolvem a licença do ficheiro gratuito deste componente. Por isso o código está isolado e marcado como avaliação, sujeito a confirmação antes de uma entrega externa.

## Pesquisa e exclusões

- Motion Primitives: página de documentação consultada, resposta 403; sem versão/licença/código verificáveis. Não copiado.
- Rare UI Bounce Sidebar: documentação consultada; MIT + Commons Clause exige ligação visível e proíbe redistribuição isolada. O menu atual precisa de preservar atalhos e navegação existente, por isso não foi copiado.
- Uiverse: catálogo consultado, sem selecionar um item concreto; nenhum código externo copiado.
- shadcn/ui: padrões de composição e acessibilidade usados como referência. A entrada agrupada foi identificada através da página específica 21st.dev e reescrita.
- Kokonut UI e UI Layouts: páginas não acessíveis nesta pesquisa; não foi possível selecionar ou licenciar uma peça concreta.
- Inspora e MotionSites: usados apenas como referências editoriais; nenhum layout ou asset foi copiado.

## Snapshot de pesquisa

- React Bits: commit `e12c22192ac7b4b452c5e2feb9b586d74765d696`.
- Magic UI: commit `efe76fc5755eca1142dd4f74c1d6f0ace2887e3c`.
- Liquid Glass Studio: commit `f7b28c36305a862f5cffed3ddd51511cf1204f56`.
- Apple Design Skill remota: commit `914b6a377c22755597e4405e54911b996de822d7`; skill legível como Markdown, sem licença raiz identificada nesta inspeção. Não instalada nem executada; usou-se a skill local `apple-design-principles`.
- Aceternity Liquid Glass: página e registry observados em 27/10/2026; o JSON está em `references/aceternity-liquid.json`.

As dependências do V2 foram fixadas no lockfile. `npm ci --ignore-scripts` terminou com zero vulnerabilidades na árvore instalada observada.
