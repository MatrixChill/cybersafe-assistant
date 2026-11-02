# PC Center e tray — checkpoint de execução

Base confirmada: `e119168`, branch `codex/pap-final-integration-20261102`. Preservados todos os commits anteriores e os cinco BMPs locais do instalador. Não houve alteração na main, tag, Release, instalação pessoal ou freeze.

## Alterações concretas

- Orbital B continua a apresentação principal aprovada. Comparação A/B preservada no laboratório DEV; não foi transformada numa nova preferência do produto.
- PC Center: removido o esticamento CPU/RAM/GPU; colunas independentes CPU/armazenamento, RAM/rede e GPU/energia. Adaptadores GPU expansíveis, nomes sem truncatura e bateria com ausência comprovada num bloco compacto. Estado desconhecido não é convertido em ausência nem em zero.
- Superfície de carregamento da saúde do Windows sem altura fixa desnecessária. Camadas decorativas dos cartões não interceptam os cliques.
- Tray: evento nativo `double-click` chama `requestMainWindowForeground`. Menu de abertura e `showWindow` reutilizam o mesmo mecanismo. Preservados encerramento, recriação segura, pedido antecipado e arranque oculto explícito.
- Instalador: preservados `runAfterFinish=true` e o percurso real do electron-builder/MUI. A função StartApp usa `--updated` no upgrade, sem transformar esse argumento em `--hidden`. Não se alterou a cadeia de instalação para simular uma prova.

## Verificação

- Aplicação: 2892 testes aprovados; build aprovado, aviso de chunks superiores a 500 kB permanece.
- Desktop: 32 testes dirigidos aprovados, typecheck e build aprovados. Incluem duplo clique com janela minimizada/oculta, encerramento, pedido antes de ready, recriação sem duplicação e argumento `--updated`.
- Testes com objetos de janela simulados não comprovam o evento físico do tray nem o foreground imposto pelo Windows. Esses ensaios continuam na VM.
- Harness Electron ampliado: indicadores a 1100/1440/1900; vista avançada a 900/1440 e escalas 1/1,25/1,5, altura 720; capturas de topo/fim e sequência completa a 1440. As escalas são fatores de escala do dispositivo emulados, não uma medição de desempenho nem todos os modos de zoom do Electron.
- Ensaio intermediário invalidado por HMR durante uma alteração: terminou sem processos sobreviventes, mas não conta como aprovação. A evidência final será a execução sem alterações concorrentes.

## Entrega ainda pendente

O setup personalizado continua um protótipo, sem aprovação visual definitiva nem payload instalado. O registo externo de aprovadores e a aprovação da árvore exata continuam necessários antes de gerar freeze/candidata. Não se reutilizou o manifesto antigo.

Pendente em VM Windows autorizada: instalação limpa com opção final marcada e desmarcada, abertura visível, tray físico, primeiro arranque, upgrade, reparação e desinstalação. Roteiro ampliado em `VM-ACEITACAO-CANDIDATA.md`. Não declarar candidata instalada, Authenticode ou versão v0.2.0 com base nestes testes DEV.


## Resultado final do ensaio Electron

Execução sem alterações concorrentes: `cybersafe-dev-run-zOQxoN`, aprovada, `cleanup.allDead=true`, sem `smokeError`. Evidência copiada para `output/pc-center-tray-20261102/`: `result.json`, `ui-repair-facts.json`, capturas `pc-advanced-top-*`, `pc-advanced-bottom-*` e sequência `pc-advanced-full-*`. As seis combinações avançadas ficaram sem overflow horizontal; indicadores disponíveis mantiveram largura e altura iguais. O ensaio recuperou GPU real com modelo e temperaturas, sem fabricar leituras; as temperaturas da CPU continuaram identificadas como pendentes e a rede como sem leitura.

A sequência final foi revista visualmente: a rede surge imediatamente sob a RAM, o armazenamento sob a CPU e o bloco compacto de energia sob a GPU. A comparação com o ensaio anterior motivou esta segunda correção, em vez de aceitar a lacuna ainda visível na primeira composição.

Commits funcionais iniciais: `12a8be9` (PC Center/ensaio) e `c8c91f5` (tray). A correção adicional de colunas é entregue num commit próprio. O evento físico do tray, abertura pós-instalação e instalação real continuam **não executados**; não confundir estes estados com o sucesso dos testes dirigidos.
