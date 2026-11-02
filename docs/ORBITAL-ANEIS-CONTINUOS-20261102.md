# Correção de trajetórias — anéis completos

A instrução mais recente do utilizador substitui a aceitação anterior de segmentos ocultos pelo núcleo. O corpo continua opaco e volumétrico; as trajetórias é que devem ficar fora da silhueta projetada. Não se desliga o depth test nem se sobrepõe um PNG para esconder o problema.

Alterações: raios 1,6/1,85; precessão limitada dos planos, períodos independentes de 48/64 segundos; oscilação global reduzida; distância da câmara ajustada ao menor eixo do contentor para evitar corte das órbitas em composições estreitas. O fallback OrbitingCore conserva o percurso CSS exterior ao símbolo. Não se alteram motores nem estados de proteção.

Teste geométrico: amostras de 160 segundos, passo temporal de 0,5 s e angular de 2 graus, incluindo a rotação global. Cada segmento deve manter raio projetado superior a 1,16 no plano frontal do emblema (corpo de raio 1,05 com bevel e margem). Este é um teste de separação geométrica; não substitui a inspeção das capturas nem mede FPS.

Evidência anterior preservada em `output/orbital-continuous-20261102/before.png`. Capturas desta correção em `output/orbital-continuous-20261102/rotation-and-profiles`: instantes distribuídos até 64 segundos, cinco perfis, movimento reduzido e fallback por WebGL desligado. São capturas do Electron com perfil isolado, dados de ensaio e leituras locais; não são renders externos. Os ficheiros de evidência ficam fora do Git.

Gravação real: `output/orbital-continuous-20261102/orbital-real-electron.mp4`, 66 segundos, 960×676, 12 fps de codificação; 1 624 frames de origem recolhidos por CDP durante 65,97 segundos. Esta cadência não é uma medição de FPS da aplicação. Não se declara ganho de CPU/GPU. Layouts capturados em larguras de 900 e 1280 px, altura 900, escalas emuladas 1/1,25/1,5; não houve overflow horizontal do documento. Não é validação nativa de DPI.

Verificação executada: quatro testes dirigidos da geometria/poses aprovados; regressão da aplicação com 2 889 testes aprovados; build e typecheck aprovados (mantém-se o aviso de bundles superiores a 500 kB). Os dois ensaios Electron desta correção terminaram com `cleanup.allDead=true`. A prova principal confirmou 3D nos perfis auto/high/balanced e ausência de canvas em economy/custom desligado, persistência após reload, movimento reduzido e fallback CSS.

Comandos de reprodução: `node scripts/dev-quarantine-electron-proof.mjs --orbital-proof` e `--orbital-capture`; requerem as bases locais do harness. O modo separado `--webgl-failure-proof`, iniciado antes desta correção, ainda não está validado: a injeção de falha por CDP não impediu a criação do canvas e terminou por timeout. Isso não equivale a testar uma GPU incompatível; não se confunde com o fallback por opção WebGL desligada, que passou. Não houve nova tentativa de rede nem mudança de política.

A melhoria do volume continua na proposta V3 isolada em DEV. A correção das trajetórias é partilhada pelo CoreScene para não deixar o comportamento anterior no caminho normal. Acabamento visual definitivo continua por aprovar. O setup e os seus ficheiros locais não fazem parte desta correção.
