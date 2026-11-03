# Orbital Glass V3 — desempenho visual adaptativo obrigatório

Estado em 2026-11-02: requisito aceite para a fase visual; implementação completa e aceitação pendentes. Não antecipa as prioridades funcionais. Complementa a revisão visual e substitui os perfis apenas sugeridos no documento de referência do utilizador.

## Contrato de produto

Configurações → Aparência → Desempenho visual, com aplicação imediata quando possível e preferências recuperadas no arranque:

| Perfil | Comportamento exigido |
|---|---|
| Automático (predefinido) | Considera disponibilidade real de WebGL, preferências de movimento e, quando mensurável, fluidez observada. Adapta os efeitos sem deduzir capacidade gráfica apenas de CPU/RAM. |
| Qualidade máxima | Efeitos premium existentes e compatíveis: núcleo 3D, órbitas, partículas, reflexos, transparências e animações. Não ultrapassa incompatibilidades nem movimento reduzido. |
| Equilibrado | Identidade CyberSafe com efeitos moderados, orçamento de renderização limitado. |
| Económico | Componentes estáticos ou simplificados; reduz animações, blur, partículas e trabalho de renderização. |
| Personalizado | Interruptores independentes para núcleo 3D, partículas, Liquid Glass, brilhos, animações e outros efeitos opcionais realmente implementados. Não apresentar controlos de efeitos inexistentes. |

Os perfis só controlam apresentação. Nunca modificam ClamAV, YARA, HashDB, Native, Scanner, quarentena, consentimento de transmissão, monitorização ou proteção. Não devem chamar IPC de configuração de segurança.

## Integração a executar na fase visual

- Reutilizar AppearanceContext, CoreScene, OrbitingCore e os tokens existentes. Não criar outro sistema de temas.
- Separar preferência solicitada, capacidade comprovada e efeitos efetivamente ativos, incluindo motivo de fallback. Não confundir WebGL permitido com contexto criado com sucesso.
- Preservar a chave e as migrações existentes; migrar `high` para a apresentação «Qualidade máxima» sem perder escolhas anteriores. Guardar controlos personalizados, validar dados corrompidos e comunicar falha de persistência.
- Um efeito desativado não pode importar/inicializar desnecessariamente o respetivo renderizador. Libertar recursos e subscrições ao desativar; manter fallback estático/CSS no arranque, erro ou perda de contexto.
- Limitar FPS e resolução interna conforme perfil; valores concretos dependem de medição e qualidade visual. Não anunciar limites como ganhos comprovados.
- Suspender loops pesados com janela oculta/minimizada ou elemento fora de vista; retomar sem salto temporal. Manter as funções de proteção ativas.
- Respeitar mudanças em `prefers-reduced-motion` durante a sessão em todos os perfis. O modo máximo não deve reativar movimento suprimido por acessibilidade.
- Garantir contraste, foco, navegação por teclado e leitura de estados em todos os perfis; nenhum estado de segurança pode depender de brilho/animação.

## Automático: evidência e limites

A criação de contexto e o suporte de recursos são evidência de compatibilidade, não de velocidade. Uma falha WebGL conduz a fallback; não impede abrir a aplicação. Não recolher identificadores gráficos detalhados ou transmitir medições para este fim.

Quando houver instrumentação, usar amostras limitadas de intervalos de frames com janela visível e condições registadas. Descartar arranque, retoma, janela oculta e intervalos inválidos. Separar carga concorrente de uma incompatibilidade permanente: uma análise pesada pode justificar reduzir decoração naquele momento, não classificar o computador como fraco.

Aplicar margem/histerese e intervalo mínimo entre mudanças para evitar oscilação. Sem amostra válida, apresentar desempenho não medido e usar uma opção conservadora; nunca inventar FPS, consumo de GPU ou classificação de hardware. Preferência explícita do utilizador deve manter-se; os limites de compatibilidade e acessibilidade continuam aplicáveis.

## Avisos discretos e verdadeiros

- Incompatibilidade comprovada: «O núcleo 3D não está disponível nesta sessão. O CyberSafe está a utilizar a apresentação estática.»
- Redução automática baseada em evidência: «Alguns efeitos visuais foram reduzidos para manter o CyberSafe fluido neste dispositivo. Pode personalizá-los em Configurações → Aparência → Desempenho visual.»
- Movimento reduzido escolhido no sistema: identificar essa preferência; não a apresentar como falha gráfica.

Mostrar motivo e acesso à configuração sem modal bloqueante. Guardar a dispensa por motivo/versão relevante para não repetir a cada abertura. Não emitir aviso de problema por uma escolha manual Económico ou Personalizado. Uma nova falha distinta pode ser comunicada uma vez.

## Estado real de partida

Existem persistência V2, quatro perfis (`auto/high/balanced/economy`), movimento, permissão WebGL e controlos nas Configurações. A proposta Orbital V3 permanece experimental, isolada em DEV e sem aprovação visual definitiva.

`packages/app/src/v2/theme.ts` ainda usa contagem de CPUs como critério de baixo consumo em Automático. Isso **não cumpre** o novo contrato e deve ser substituído na implementação. Não existem ainda o perfil Personalizado completo, a adaptação por fluidez validada nem os avisos deduplicados descritos aqui. Os testes anteriores de persistência/fallback não certificam este sistema novo.

## Aceitação obrigatória na implementação

1. Exercitar os cinco perfis e cada interruptor existente; confirmar alteração sem reinício, reload, migração, storage indisponível/corrompido.
2. WebGL ausente, criação falhada, perda de contexto e recuperação: aplicação utilizável e fallback legível, sem renderizador residual.
3. Movimento reduzido inicial e alterado em execução; janela oculta/retomada; sem loops decorativos pesados ativos quando desligados.
4. Automático com amostras válidas/insuficientes/inválidas e adaptação estável; CPU/RAM isoladas não decidem a qualidade.
5. Avisos corretos por motivo, dispensa persistente, sem repetição a cada abertura; opções manuais não geram falso aviso de incompatibilidade.
6. Confirmar que a alteração de perfil não altera configuração nem atividade dos motores e serviços de segurança.
7. Capturas reais nos perfis e fallback, teclado/contraste, medições comparáveis quando houver ambiente adequado. Registar máquina, versão, cenário, duração, FPS/frame times e CPU apenas quando realmente medidos. Sem alegar ganhos antes desses ensaios.

Referências técnicas: [Page Visibility API](https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API), [movimento reduzido em Motion](https://motion.dev/docs/react-use-reduced-motion), [Three.js](https://threejs.org/docs/). Não constituem autorização para acrescentar dependências.
