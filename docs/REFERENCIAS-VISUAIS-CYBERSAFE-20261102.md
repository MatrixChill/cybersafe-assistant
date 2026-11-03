# Referências visuais — análise para CyberSafe

Consulta pública em 2026-11-02 das dez fontes nomeadas pelo utilizador. Inspeção de páginas iniciais por navegador e conteúdo público; não é uma análise exaustiva das bibliotecas, trabalhos privados ou de todos os sites nelas listados. Não foram copiados recursos, instaladas dependências ou submetidos dados do projeto.

Capturas observadas permitem analisar composição; não demonstram FPS, custo de GPU, implementação WebGL ou qualidade temporal de uma animação. As decisões abaixo são propostas próprias para CyberSafe, não propriedades técnicas atribuídas sem prova às referências.

| Fonte consultada | Observação e limite | Aplicação proposta ao CyberSafe |
|---|---|---|
| [Linear](https://linear.app/) | Fundo quase preto, títulos claros, bordas discretas e demonstração de interface com navegação lateral, estados e atividade. | Hierarquia de Dashboard e Gestor; estados legíveis e superfícies contidas. Não transportar a escala de título de marketing para listas técnicas. |
| [Raycast](https://www.raycast.com/) | Navegação escura delimitada, ação Download destacada e hero tipográfico. Conteúdo público apresenta comandos e extensões. A captura inicial não prova partículas ou 3D. | Comandos e ação principal claros, feedback curto; evitar brilho constante em cada controlo. |
| [Vercel](https://vercel.com/) | Hero preto com marca central e halo localizado, texto e ações separados espacialmente. | Um foco luminoso no núcleo oficial CyberSafe; não reproduzir o triângulo ou identidade Vercel. O halo visível não prova renderização 3D. |
| [Framer](https://www.framer.com/) | Área demonstrativa enquadrada; brilho azul localizado e camadas de interface. Página mostra editor e composição responsiva. | Profundidade no hero/overlay; transições com propósito e adaptação de layout. Não aplicar o brilho do hero às tabelas. |
| [Arc](https://arc.net/) | Página atual de despedida, marca colorida, título central e ação simples; não é a antiga landing page do navegador. | Economia de elementos e foco numa mensagem. Não afirmar que se reviu o motion da antiga página. |
| [Mobbin](https://mobbin.com/) | Apresentação pública da biblioteca e categorias de ecrãs/fluxos; entrada observada com título amplo e banner de cookies. Não houve acesso à biblioteca paga. | Usar como referência de fluxos, navegação e estados, não como prova de desempenho de efeitos. |
| [Dribbble](https://dribbble.com/) | Conteúdo público textual apresenta categorias UI, animação e 3D. Pesquisa específica `3d-dashboard` no navegador exigiu verificação humana; não foi resolvida nem contornada. | Conceitos são inspiração a validar num produto real. Análise de motion dos projetos específicos ficou limitada; não se aprova uma solução apenas por uma imagem. |
| [Behance](https://www.behance.net/) | Leitura web devolveu 403; navegador normal abriu a página pública com hierarquia tipográfica, filtros e pesquisa. Não foram inspecionados projetos específicos. | Útil para apresentação e organização editorial; não atribuir efeitos 3D a projetos não abertos. |
| [Land-book](https://land-book.com/) | Galeria pública com Websites, Sections, Mobile e Motion; categorias e prévias de composições, incluindo imagens com profundidade. Banner de cookies limita parte da captura. | Comparar proporções e foco do hero; miniatura não comprova movimento nem tecnologia. |
| [Awwwards](https://www.awwwards.com/) | Destaque público GRIDS, tipografia de grande escala, imagem/vídeo em área ampla e navegação editorial. | Ritmo e alinhamento; rejeitar escala de espetáculo e navegação cenográfica nas operações de segurança. Não se mediu o site destacado. |

## Efeitos: direção proposta, ainda sujeita a aprovação

- **3D e órbitas:** concentrar no CoreScene/OrbitingCore existente. Núcleo opaco com volume e planos independentes; testar oclusão frontal/traseira com profundidade real. Glow transparente não pode tornar visível a parte traseira através do núcleo. A proposta DEV existente é ponto de partida, não aceitação final.
- **Partículas:** opcionais e locais ao hero, sem estrelas/galáxia, sem cobrir texto, sem perseguir o cursor nem simular ameaças. Não foram confirmados sistemas de partículas nas páginas observadas. Acrescentá-las apenas depois da organização e dentro do orçamento visual; controlo individual e zero loop quando desligadas.
- **Liquid Glass:** usar seletivamente em overlays, dropdowns e destaque do hero. Em listas, resultados e tabelas, fundo previsível e contraste estável. Não empilhar blur de vários painéis como substituto de hierarquia.
- **Reflexos e brilhos:** acento ciano/violeta localizado, bordas e sombras para separar planos. Evitar bloom global, reflexos contínuos em todos os cards e dependência de cor para comunicar segurança.
- **Animação:** comunicar mudança de estado e profundidade; sem atrasar uma ação. Evitar paralaxe ampla, zoom recorrente, scroll hijacking ou entradas que ocultem dados. Respeitar movimento reduzido e suspensão fora de vista.
- **Setup:** derivar a identidade aprovada da aplicação. As páginas de marketing consultadas não validam instalação, cancelamento, upgrade ou desinstalação. Preservar NSIS e os protótipos; aparência não pode inventar progresso ou sucesso.

## Ordem de execução e critério de decisão

Prioridades funcionais preservadas. Depois: organização global e estados → núcleo/oclusão → componentes e páginas → sistema adaptativo obrigatório → protótipo de setup coerente → acabamento opcional. Reutilizar tokens e componentes; não importar layouts ou arte de terceiros.

O contrato vinculativo dos cinco perfis, limites e ensaios está em [ORBITAL-V3-DESEMPENHO-ADAPTATIVO.md](ORBITAL-V3-DESEMPENHO-ADAPTATIVO.md). Qualidade máxima permite os efeitos compatíveis; Equilibrado modera; Económico simplifica; Personalizado dá controlo individual; Automático usa evidência. Nenhum perfil altera proteção.

Nesta atualização foram produzidos pesquisa e requisitos. Não se alterou o frontend nem se declara ganho de FPS/CPU, aprovação visual, instalador final ou candidata instalada. Faltam trabalhos específicos de motion acessíveis, comparação temporal em execução e medições do próprio CyberSafe para escolher parâmetros finais.
