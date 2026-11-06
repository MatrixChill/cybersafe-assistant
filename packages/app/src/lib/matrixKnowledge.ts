import { resolveIdentity } from "./buildIdentity";
/**
 * Conhecimento LOCAL da MATRIX: respostas determinísticas, sem fornecedor de IA.
 *
 * Porque existe (auditoria v0.2.2): a base antiga vivia no componente e fazia
 * `texto.includes(palavra)`. Substrings classificavam mal perguntas reais:
 *  - «Porque f**oi** este ficheiro is**ola**do?» → saudação («oi», «ola»);
 *  - «Como melhorar a minha **segura**nça?» → resposta de palavras-passe;
 *  - «**polít**ica de quarentena» → recusa «fora do tema».
 * Aqui cada chave é uma PALAVRA (ou expressão) inteira, comparada sem acentos.
 *
 * Regras de honestidade: estas respostas explicam o produto e conceitos; não
 * afirmam o estado atual do PC (isso vem das leituras do serviço noutro módulo)
 * nem fingem ser geradas por um modelo.
 */

export type MatrixIntent =
  | "clamav-degradado"
  | "prova-carga"
  | "cobertura-recuperacao"
  | "usb"
  | "arranque"
  | "versao"
  | "saudacao"
  | "identidade"
  | "capacidades"
  | "motores"
  | "clamav"
  | "yara"
  | "hashdb"
  | "nativo"
  | "eicar"
  | "quarentena-motivo"
  | "quarentena-restauro"
  | "quarentena"
  | "inconclusivo"
  | "degradado"
  | "tempo-real"
  | "scanner"
  | "atualizacoes"
  | "otimizar"
  | "lento"
  | "phishing"
  | "palavras-passe"
  | "ransomware"
  | "2fa"
  | "rede"
  | "backup"
  | "malware"
  | "engenharia-social"
  | "melhorar-seguranca";

/** Minúsculas e sem acentos: «Está» e «esta» são a mesma palavra para o leitor. */
export function normalizar(texto: string): string {
  return texto.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/** Expressão inteira, nunca dentro de outra palavra. */
export function contemTermo(texto: string, termo: string): boolean {
  const alvo = normalizar(texto);
  const t = normalizar(termo).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(String.raw`(?<![\p{L}\p{N}])` + t + String.raw`(?![\p{L}\p{N}])`, "u").test(alvo);
}

const algum = (texto: string, termos: readonly string[]) => termos.some((t) => contemTermo(texto, t));

/**
 * Ordem = prioridade. As intenções específicas (quarentena-motivo, EICAR,
 * ClamAV…) vêm antes das gerais, e a saudação vem por último: «olá, o que é o
 * ClamAV?» é uma pergunta sobre o ClamAV, não um cumprimento.
 */
const REGRAS: ReadonlyArray<readonly [MatrixIntent, (t: string) => boolean]> = [
  ["eicar", (t) => algum(t, ["eicar"])],
  ["quarentena-motivo", (t) => algum(t, ["quarentena", "isolado", "isolada", "isolei", "isolou"]) && algum(t, ["porque", "por que", "porquê", "motivo", "razao"])],
  ["quarentena-restauro", (t) => algum(t, ["restaurar", "restauro", "restaurado", "recuperar"]) && algum(t, ["quarentena", "ficheiro", "isolado", "isolada", "seguro", "risco", "riscos", "perigoso"])],
  ["quarentena", (t) => algum(t, ["quarentena"])],
  ["inconclusivo", (t) => algum(t, ["inconclusivo", "inconclusiva", "inconclusivos", "inconclusivas", "nao concluida", "nao concluido"])],
  // v0.2.3 — perguntas específicas sobre os problemas reais observados.
  ["prova-carga", (t) => algum(t, ["prova de carga", "vaga envenenada", "prova recusada"])],
  ["clamav-degradado", (t) => algum(t, ["clamav", "clamscan"]) && algum(t, ["degradado", "degradada", "indisponivel", "falha", "falhou", "nao funciona", "nao esta ativo"])],
  ["cobertura-recuperacao", (t) => algum(t, ["em recuperacao", "a recuperar", "recuperacao da cobertura", "cobertura em recuperacao"])],
  ["usb", (t) => algum(t, ["usb", "pen", "pendrive", "pen drive", "dispositivo externo", "disco externo"])],
  ["arranque", (t) => algum(t, ["arranque", "arrancar", "demorou a iniciar", "demora a abrir", "demorou a abrir", "demorou a arrancar", "tempo de espera"])],
  ["versao", (t) => algum(t, ["que versao", "qual a versao", "qual e a versao", "versao do cybersafe", "versao tenho"])],
  ["degradado", (t) => algum(t, ["degradado", "degradada", "limitacoes", "com limitacoes", "cobertura nao confirmada"])],
  ["clamav", (t) => algum(t, ["clamav", "clamscan"])],
  ["yara", (t) => algum(t, ["yara"])],
  ["hashdb", (t) => algum(t, ["hashdb", "base de hashes", "base de assinaturas", "hash", "sha-256", "sha256"])],
  ["nativo", (t) => algum(t, ["motor nativo", "native engine", "c++"])],
  ["motores", (t) => algum(t, ["motores", "quatro motores", "4 motores", "motor"])],
  ["tempo-real", (t) => algum(t, ["tempo real", "monitorizacao", "proteccao residente", "protecao residente"])],
  ["atualizacoes", (t) => algum(t, ["atualizacao", "atualizacoes", "atualizar", "actualizar", "nova versao", "updater"])],
  ["scanner", (t) => algum(t, ["scanner", "analise rapida", "analise profunda", "analise completa", "analise personalizada", "como analisar", "resultado da analise", "resultado da minha analise"])],
  ["lento", (t) => algum(t, ["lento", "lenta", "lentidao", "desempenho", "performance", "travar", "trava"])],
  ["otimizar", (t) => algum(t, ["otimizar", "optimizar", "otimizacao", "temporarios", "libertar espaco"])],
  ["phishing", (t) => algum(t, ["phishing", "email falso", "email suspeito", "link falso", "links falsos"])],
  ["palavras-passe", (t) => algum(t, ["palavra-passe", "palavras-passe", "palavra passe", "senha", "senhas", "password", "passwords"])],
  ["ransomware", (t) => algum(t, ["ransomware", "resgate"])],
  ["2fa", (t) => algum(t, ["2fa", "mfa", "dois fatores", "dois factores", "autenticacao em dois passos"])],
  ["rede", (t) => algum(t, ["firewall", "wifi", "wi-fi", "vpn", "rede publica", "redes publicas"])],
  ["backup", (t) => algum(t, ["backup", "backups", "copia de seguranca", "copias de seguranca"])],
  ["engenharia-social", (t) => algum(t, ["engenharia social", "burla", "golpe"])],
  ["malware", (t) => algum(t, ["malware", "virus", "trojan", "spyware", "worm", "adware"])],
  ["melhorar-seguranca", (t) => algum(t, ["melhorar a seguranca", "melhorar na seguranca", "melhorar a minha seguranca", "mais seguro", "proteger o pc", "proteger o computador"])],
  ["capacidades", (t) => algum(t, ["o que podes fazer", "o que sabes fazer", "o que consegues fazer", "como me podes ajudar", "para que serves", "ajuda"])],
  ["identidade", (t) => algum(t, ["quem es", "quem e a matrix", "o que es", "apresenta-te", "apresentate"])],
  ["saudacao", (t) => algum(t, ["oi", "ola", "bom dia", "boa tarde", "boa noite", "hello", "hey", "tudo bem"])],
];

export function classificarIntencao(texto: string): MatrixIntent | null {
  for (const [intencao, teste] of REGRAS) if (teste(texto)) return intencao;
  return null;
}

/** Apresentação da primeira mensagem de cada conversa. */
export const MATRIX_APRESENTACAO =
  "Olá! Sou a **MATRIX**, a tua assistente de segurança do CyberSafe.\n\n" +
  "Posso explicar o que os processos estão a fazer, interpretar os resultados das análises, ajudar com problemas de desempenho e orientar-te nas funcionalidades do CyberSafe — sempre com base no que o teu computador realmente mediu.\n\n" +
  "O que gostarias de fazer hoje?";

const RESPOSTAS: Record<Exclude<MatrixIntent, "versao">, string> = {
  "clamav-degradado":
    "O ClamAV só aparece **Ativo** depois de uma prova real: carrega a base de assinaturas e analisa um ficheiro benigno. Aparece degradado quando essa prova não se confirma. As causas mais comuns:\n\n" +
    "- **carga lenta** — o computador está ocupado ou outro antivírus está a analisar a base; o CyberSafe tenta de novo com mais tempo (até 2 minutos);\n" +
    "- **um clamscan anterior ainda não terminou** — o motor espera que o Windows confirme o fim antes de voltar a usar a vaga;\n" +
    "- **base em falta ou incompleta** — só aqui faz sentido atualizar as definições.\n\n" +
    "O detalhe exato está em **Ver estado dos motores** no Painel.",
  "prova-carga":
    "A **prova de carga** é o teste que o CyberSafe faz antes de dizer que o ClamAV está ativo: carrega a base completa e analisa um ficheiro benigno. Se falhar, o motor não é dado como ativo.\n\n" +
    "«Vaga envenenada» significa que um clamscan anterior foi mandado parar mas o Windows ainda não confirmou que terminou. Para não ter dois processos de ~1 GB ao mesmo tempo, o motor espera por essa confirmação e depois volta a tentar sozinho.",
  "cobertura-recuperacao":
    "**Cobertura em recuperação** quer dizer que, numa altura de muitos ficheiros novos (por exemplo, uma instalação), alguns não entraram logo na fila de análise. O CyberSafe está a voltar a tentá-los e a rever as pastas afetadas.\n\n" +
    "Os quatro motores continuam operacionais; o aviso só desaparece quando a versão atual de cada ficheiro tiver sido analisada. Ficheiros que entretanto foram apagados contam à parte, porque já não há nada para analisar.",
  usb:
    "A **proteção USB** deteta pens e discos externos e analisa-os **só em modo leitura** — nunca executa nem altera ficheiros do dispositivo.\n\n" +
    "- A análise automática só acontece se a ativares nas Definições; a manual pode ser feita a qualquer momento no painel USB.\n" +
    "- Se tirares o dispositivo a meio, a análise é cancelada e não aparece como concluída.\n\n" +
    "Para saber se o teu USB foi analisado, abre o painel **USB**: mostra o estado, o número de ficheiros analisados e o resultado da última análise desse dispositivo.",
  arranque:
    "Ao abrir, o CyberSafe liga-se ao serviço de proteção e verifica os motores. O ClamAV é o mais lento: tem de carregar uma base de ~170 MB e provar que funciona. Desde a v0.2.3 essa prova corre em segundo plano — o painel abre logo e o ClamAV aparece «A verificar» até a prova terminar.\n\n" +
    "Se o arranque demorar muito, o ecrã diz que continua a tentar e abre sozinho quando as leituras chegarem. Num computador lento ou com outro antivírus ativo, a primeira prova pode demorar mais.",
  saudacao: "Olá de novo! Em que posso ajudar? Posso explicar um processo, um alerta ou o estado da proteção.",
  identidade:
    "Sou a **MATRIX**, a assistente do CyberSafe. Explico o que o CyberSafe mede no teu computador — processos, análises, quarentena e estado da proteção — em linguagem simples.\n\n" +
    "Quando respondo no PC, digo-o (**Diagnóstico local**). Só uso um fornecedor de IA quando escolhes o modo **Online**, e nunca envio dados de processos sem a tua autorização.",
  capacidades:
    "Posso ajudar-te com:\n\n" +
    "- **Processos**: o que um processo é, porque consome CPU ou RAM e se há sinais que mereçam atenção (no Gestor de Tarefas, «Explicar na MATRIX»);\n" +
    "- **Análises**: o que significa um resultado, um alerta ou uma análise inconclusiva;\n" +
    "- **Quarentena**: porque um ficheiro foi isolado e quando restaurar é arriscado;\n" +
    "- **Proteção**: o estado dos quatro motores e do tempo real;\n" +
    "- **Desempenho**: porque o PC pode estar lento e o que é seguro fazer;\n" +
    "- **Boas práticas**: phishing, palavras-passe, backups, ransomware.\n\n" +
    "Não invento medições: se um dado não estiver disponível, digo-o.",
  motores:
    "O CyberSafe usa **quatro motores** que se complementam:\n\n" +
    "- **HashDB** — compara o SHA-256 do ficheiro inteiro com assinaturas conhecidas. Uma coincidência exata é a prova mais forte;\n" +
    "- **ClamAV** — antivírus de código aberto com uma base grande de assinaturas;\n" +
    "- **YARA** — regras que procuram padrões no conteúdo;\n" +
    "- **Motor nativo (C++)** — análise rápida do ficheiro feita no próprio PC.\n\n" +
    "Cada motor só aparece «ativo» com prova real de funcionamento. Se um não conseguir avaliar um ficheiro, o resultado diz-o em vez de o dar como limpo.",
  clamav:
    "O **ClamAV** é um motor antivírus de código aberto. O CyberSafe inclui-o e mantém a base de assinaturas atualizada.\n\n" +
    "Cada análise do ClamAV carrega a base completa, por isso pode demorar alguns segundos. No tempo real, se o hash do ficheiro já coincidir com uma assinatura verificada, a deteção não espera pelo ClamAV — e o resultado diz que ele não foi consultado.\n\n" +
    "Se o ClamAV aparecer «A verificar», é uma prova de saúde em curso, não uma avaria.",
  yara:
    "O **YARA** usa regras que descrevem padrões de malware (texto, bytes, estruturas). Uma regra marcada como evidência forte pesa mais do que uma genérica. Se o YARA não concluir a leitura de um ficheiro, isso aparece como lacuna, nunca como «limpo».",
  hashdb:
    "A **HashDB** compara o **SHA-256 do ficheiro inteiro** com uma base de assinaturas verificadas. Só uma coincidência exata conta: mudar um único byte muda o hash. É por isso a prova mais forte — e a única que o CyberSafe aceita para isolar automaticamente, quando ativas essa política.",
  nativo:
    "O **motor nativo** é um componente em C++ que analisa ficheiros diretamente no PC, de forma rápida. Se não estiver disponível ou falhar, o resultado da análise fica marcado como incompleto em vez de ser dado como seguro.",
  eicar:
    "O **EICAR** é um ficheiro de teste padrão da indústria: não é malware e não faz nada, mas todos os antivírus o tratam como ameaça para se poder testar a deteção com segurança.\n\n" +
    "No CyberSafe, o EICAR é reconhecido pelo hash exato (HashDB) e também pelo ClamAV. Atenção: o Windows Defender também o deteta e pode removê-lo primeiro — isso é uma deteção do Defender, não do CyberSafe.",
  "quarentena-motivo":
    "Um ficheiro vai para quarentena quando um motor encontrou evidência de ameaça e **tu confirmaste o isolamento** — ou quando escolheste a política automática e a prova é um hash exato verificado.\n\n" +
    "Para ver o motivo concreto, abre a entrada na **Quarentena** e carrega em **Detalhes**: mostra o motor, o motivo da deteção e o SHA-256.",
  "quarentena-restauro":
    "Restaurar devolve o ficheiro à pasta original, **tal como estava** — se era uma ameaça, continua a sê-lo.\n\n" +
    "Antes de restaurar:\n\n" +
    "- vê em **Detalhes** que motor o detetou e porquê;\n" +
    "- restaura só se tiveres a certeza da origem (por exemplo, um programa teu identificado por engano);\n" +
    "- depois de restaurar, podes analisá-lo de novo no **Scanner**.\n\n" +
    "O CyberSafe pede sempre confirmação («Confirmar restauro») e mostra para onde o ficheiro volta.",
  quarentena:
    "A **quarentena** guarda o ficheiro suspeito numa pasta protegida, onde não pode ser executado. Podes **restaurar** (volta ao local original, depois de confirmares) ou **eliminar** (permanente). O histórico mantém o motor, o motivo e o SHA-256 de cada entrada.",
  inconclusivo:
    "**Inconclusivo** significa que pelo menos um motor não conseguiu avaliar o ficheiro (por exemplo, um ficheiro compactado (ZIP) que não pôde ser aberto por inteiro, um ficheiro que mudou durante a análise, ou um motor ocupado).\n\n" +
    "Não é o mesmo que «seguro». Se houver uma deteção noutro motor, ela é mantida. Podes repetir a análise mais tarde ou analisar só esse ficheiro no **Scanner**.",
  degradado:
    "A proteção aparece com limitações quando há uma limitação **atual**. O CyberSafe separa as causas:\n\n" +
    "- **Motores**: um motor que não tem prova de funcionamento (ex.: sem base de assinaturas);\n" +
    "- **Cobertura do tempo real**: ficheiros que, numa sobrecarga, ainda não foram analisados na versão atual;\n" +
    "- **Rede**: o filtro WFP do CyberSafe é opcional e não é o Firewall do Windows.\n\n" +
    "Problemas já recuperados ficam no histórico e não mantêm o aviso. Abre os **detalhes da proteção** para ver a causa concreta.",
  "tempo-real":
    "A **proteção em tempo real** vigia pastas como Downloads e Temp. Quando aparece ou muda um ficheiro, ele entra numa fila de análise — os Downloads têm prioridade.\n\n" +
    "Se muitos ficheiros aparecerem de uma vez (ex.: uma instalação), a fila pode encher. Nesse caso o CyberSafe volta a tentar esses ficheiros e só dá a cobertura como confirmada quando a **versão atual** de cada um foi analisada. Se algum ficar por analisar, avisa.",
  scanner:
    "O **Scanner** tem três modos:\n\n" +
    "- **Rápida** — as áreas de maior risco (Downloads, Ambiente de trabalho, Temp);\n" +
    "- **Completa** — o disco inteiro, demora mais;\n" +
    "- **Personalizada** — uma pasta ou ficheiro à tua escolha.\n\n" +
    "No fim vês quantos ficheiros foram analisados, as ameaças e os inconclusivos com o motivo. Podes cancelar a qualquer momento.",
  atualizacoes:
    "As **atualizações** são verificadas a partir do GitHub oficial do projeto. Cada manifesto é assinado com uma chave **Ed25519** cuja impressão digital está fixada na aplicação, e o instalador é verificado por **SHA-256**; versões mais antigas são recusadas.\n\n" +
    "Como o instalador não tem assinatura Authenticode, a instalação é feita por ti (download manual), não automaticamente.",
  otimizar:
    "O **Otimizar** sugere ações seguras, como limpar ficheiros temporários e ver o que ocupa espaço. Pede confirmação antes de apagar e não mexe em ficheiros do sistema nem em dados pessoais. Não promete milagres: mostra o que mediu.",
  lento:
    "Um PC lento costuma ter uma destas causas: **CPU** ocupada por um programa, **RAM** quase cheia, **disco** sem espaço ou muito usado, ou programas a arrancar com o Windows.\n\n" +
    "O que é seguro fazer:\n\n" +
    "- no **Gestor de Tarefas**, vê os processos com mais CPU/RAM e pergunta-me por um deles;\n" +
    "- fecha aplicações que não estás a usar (guarda o trabalho primeiro);\n" +
    "- no **PC Center**, confirma o espaço livre em disco.\n\n" +
    "Consumo alto, sozinho, não significa malware.",
  phishing:
    "**Phishing** são mensagens falsas que tentam roubar dados. Para te protegeres:\n\n" +
    "- não cliques em links que pedem dados ou pagamentos com urgência;\n" +
    "- confirma o remetente real, não só o nome mostrado;\n" +
    "- entra nos sites escrevendo o endereço no navegador.",
  "palavras-passe":
    "**Palavras-passe fortes**: 12 ou mais caracteres, uma frase-passe fácil de lembrar, diferente em cada serviço, guardadas num gestor de palavras-passe e com **2FA** ativo. Nunca as partilhes num chat — nem comigo.",
  ransomware:
    "**Ransomware** cifra os teus ficheiros e pede resgate. A melhor defesa é ter **backups** desligados do PC (regra 3-2-1), manter o sistema atualizado e não abrir anexos suspeitos. Se acontecer, não pagues: não há garantia de recuperação.",
  "2fa":
    "**2FA** junta um segundo fator à palavra-passe. Prefere uma app autenticadora ou uma chave física; o SMS é melhor do que nada. Se a palavra-passe for roubada, o 2FA continua a proteger a conta.",
  rede:
    "Em redes: usa WPA2/WPA3, evita redes públicas sem VPN e mantém o **Firewall do Windows** ativo. O filtro WFP do CyberSafe é uma camada opcional e não substitui o Firewall do Windows.",
  backup:
    "Backups seguem a regra **3-2-1**: 3 cópias, em 2 suportes diferentes, 1 fora de casa. Testa a restauração de vez em quando e mantém uma cópia desligada do PC, para o ransomware não lhe chegar.",
  "engenharia-social":
    "**Engenharia social** é manipular pessoas com urgência, medo ou ofertas para obter dados ou acessos. Desconfia de contactos não pedidos e confirma por outro canal antes de agir.",
  malware:
    "**Malware** é software malicioso: trojans, spyware, worms, ransomware, adware. Instala programas só de fontes oficiais, mantém o sistema atualizado e analisa ficheiros suspeitos no **Scanner** do CyberSafe.",
  "melhorar-seguranca":
    "Para melhorar a segurança:\n\n" +
    "- mantém o Windows e os programas atualizados;\n" +
    "- deixa a **proteção em tempo real** ligada e corre uma **Análise Rápida** de vez em quando;\n" +
    "- usa palavras-passe únicas com 2FA;\n" +
    "- faz backups regulares;\n" +
    "- desconfia de links e anexos inesperados.\n\n" +
    "Para ver o estado atual da proteção, pergunta-me «Como está a proteção?».",
};

/**
 * Perguntas sobre o PRÓPRIO CyberSafe: a resposta local é a fonte exata (o
 * fornecedor genérico não conhece estes motores nem estas regras e podia
 * inventar). Temas gerais de segurança (phishing, backups…) podem ir ao
 * fornecedor no modo Online.
 */
export const INTENCOES_DO_PRODUTO: ReadonlySet<MatrixIntent> = new Set<MatrixIntent>([
  "saudacao", "identidade", "capacidades", "motores", "clamav", "yara", "hashdb", "nativo", "eicar",
  "quarentena-motivo", "quarentena-restauro", "quarentena", "inconclusivo", "degradado",
  "tempo-real", "scanner", "atualizacoes", "otimizar",
  "clamav-degradado", "prova-carga", "cobertura-recuperacao", "usb", "arranque", "versao",
]);

export function respostaLocal(intencao: MatrixIntent): string {
  if (intencao === "versao") {
    const id = resolveIdentity();
    const v = id?.version && id.version !== "desconhecida" ? id.version : null;
    return v
      ? `Tens o **CyberSafe Assistant ${v}**. Para procurar uma versão nova, abre **Atualizações** nas Definições: a atualização é verificada (assinatura Ed25519 e SHA-256) e instalada por ti.`
      : "Não consigo ler a versão desta compilação. Vê-a em **Definições → Sobre**.";
  }
  return RESPOSTAS[intencao];
}

/** Guarda de tema: palavras inteiras, para «política de quarentena» não ser política. */
const FORA_DO_TEMA = ["lasanha", "receita", "receitas", "bolo", "cozinhar", "futebol", "campeonato", "golo", "poema", "novela", "telenovela", "previsao do tempo", "eleicoes", "eleicao", "partido politico", "celebridade", "redacao escolar"];
export function foraDoTema(texto: string): boolean {
  return algum(texto, FORA_DO_TEMA);
}

const PERIGOSO = ["criar malware", "fazer malware", "escrever malware", "roubar credenciais", "phishing funcional", "invadir", "hackear", "persistencia maliciosa", "evadir antivirus", "evadir o antivirus", "desativar o antivirus", "crackar", "keylogger", "exploit funcional", "ransomware que", "destruir dados"];
export function pedidoPerigoso(texto: string): boolean {
  return algum(texto, PERIGOSO);
}
