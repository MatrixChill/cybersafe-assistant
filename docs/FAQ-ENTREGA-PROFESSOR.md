# Perguntas frequentes para a entrega

Respostas curtas às perguntas que costumam aparecer na apresentação e na leitura do
repositório. Cada resposta corresponde ao que está no código hoje, não ao que se pretende
fazer.

## «O motor devia ser em C++?»

Em produtos clássicos de segurança, o núcleo de análise e os parsers binários costumam estar
em C, C++ ou Rust, e a interface, a API e a orquestração em linguagens de mais alto nível.
Este projeto segue essa divisão:

- **TypeScript** decide o fluxo, aplica heurísticas, chama YARA-X, consulta o VirusTotal e
  gere a quarentena. É também onde vive a pontuação de risco que a interface mostra.
- **C++ (`scan-engine.exe`)** faz análise estática de binários: SHA-256, entropia, cabeçalhos
  PE, secções executáveis e ausência de importações.

O motor nativo **já está integrado**: a ponte em `packages/service/src/native-engine-bridge.ts`
executa o binário, devolve o resultado em JSON e o serviço integra os seus sinais na pontuação e
acrescenta um fator próprio. Se o binário não estiver compilado, a análise continua apenas
com o motor TypeScript e o painel de saúde mostra o motor nativo como indisponível.

## «Porque é que o TypeScript domina a barra de linguagens do GitHub?»

O GitHub usa o Linguist, que conta linhas por tipo de ficheiro. O repositório tem muito
`.ts` e `.tsx` — interface, serviço, API, tipos partilhados — e o C++ está concentrado no
pacote do motor nativo, com poucas centenas de linhas. A barra reflete volume de linhas, não
importância: o motor nativo é pequeno e faz uma parte específica do trabalho.

## «O motor nativo não funciona sem ser compilado?»

Funciona o resto. A aplicação arranca e analisa ficheiros com o motor TypeScript; o que
perde é a segunda opinião nativa. Compilar exige CMake e é opcional
(`npm run build:native`). Na candidata de instalação de 21/10, o `scan-engine.exe` foi
incluído e a ponte procura-o primeiro na pasta de recursos.

## «O Electron não é pesado demais?»

É um compromisso: Chromium e Node na mesma aplicação. Permite partilhar TypeScript entre várias camadas e criar
uma interface rica; perde-se em memória e tamanho de instalação. As alternativas — Tauri, Qt
ou WPF — trocam esse compromisso por outro: menos consumo, mas outra stack e menos
componentes prontos. Para uma aplicação local com painel e serviço, o Electron foi a escolha
possível neste prazo.

## «Isto é um antivírus de verdade?»

Depende do que se entende por antivírus.

- **Como protótipo de segurança:** reúne análise de ficheiros, regras, consulta de reputação,
  quarentena e monitorização. Nem todas estas capacidades foram validadas no mesmo
  ambiente; os testes reais e os limites estão descritos no documento de progresso.
- **Como equivalente ao Windows Defender:** não. Faltam camadas de kernel, reputação à escala
  global, equipa de resposta a incidentes e operação contínua de assinaturas.

O próprio README diz que é uma ferramenta educacional e de monitorização. O produto
empacotado, além disso, ainda não foi instalado nem executado.

## «O instalador já foi testado?»

Não. A candidata de 21/10 foi gerada e verificada estaticamente: nome, produto, versão,
conteúdo do pacote e motores externos. Nunca foi instalada nem executada, porque neste
computador de desenvolvimento a instalação colide com nove elementos já existentes. Validar
uma instalação exige um ambiente isolado e está nos próximos passos.

## «Como são tratadas as chaves de API?»

Todas as chaves vêm de variáveis de ambiente. O repositório inclui um `.env.example` com os
nomes esperados e o `.gitignore` exclui os ficheiros `.env`. A branch de progresso não inclui ficheiros de configuração com credenciais reais. O
histórico antigo é separado e mantém valores de exemplo que exigem confirmação e eventual
rotação caso tenham sido usados; não se afirma que todo esse histórico está livre de segredos. A verificação de segredos feita sobre a candidata de 21/10 teve cobertura
zero de ficheiros de configuração, por isso não deve ser lida como prova de ausência de
segredos.

## «Porque não há capturas de ecrã no repositório?»

Porque não existem capturas sanitizadas. As sessões de validação foram registadas em texto e
em dados técnicos; as capturas referidas pela pessoa que testou não foram entregues. Em vez
de inventar imagens ou reaproveitar capturas antigas que já não representam o estado atual, a
entrega declara a lacuna. Ver [capturas](screenshots/README.md).

## «E hooks de processo, tipo NtCreateProcess?»

Não é esse o caminho. Em Windows moderno, as soluções suportadas passam por minifilter,
callbacks oficiais, ETW, AMSI e WFP, com assinatura de driver e risco de instabilidade. Este
projeto fica deliberadamente em modo de utilizador: monitorização e análise, sem driver. Um
hook clássico estilo rootkit não é uma opção suportada nem desejável.

## «O que falta para parecer indústria?»

Ver o [roadmap](ROADMAP.md). Em resumo: instalação validada, atualizações reais com rollback,
assinatura digital, acessibilidade em execução e muito trabalho fora do código — assinaturas,
operações e resposta a incidentes.
