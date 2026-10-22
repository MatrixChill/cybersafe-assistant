/**
 * Modelo da página Otimizar (R5-L2).
 *
 * O problema que este módulo resolve é de SEMÂNTICA, não de aspeto: a página
 * antiga tinha uma prioridade `high|medium|low` escrita à mão em cada cartão e
 * mostrava-a como «Crítico / Importante / Sugestão». Como a prioridade era uma
 * opinião do catálogo, um computador saudável podia estar «Crítico» e uma dica
 * de senhas também. Aqui a classificação é derivada da EVIDÊNCIA: um cartão só
 * é «Crítico» depois de uma verificação real ter medido uma falha crítica.
 *
 * Tudo o que aqui está é puro e determinístico — é o que permite testar a
 * classificação, os estados e a matemática do progresso sem DOM nem Electron.
 */

/** O que o cartão é, antes de qualquer medição. */
export type OptimizeTipo = "problema-potencial" | "manutencao" | "boa-pratica";

/** O que o botão realmente faz. */
export type OptimizeAcaoTipo = "verificacao" | "correcao" | "educativa" | "inexistente";

/** Ciclo de vida do cartão. */
export type OptimizeEstado =
  | "pendente"
  | "a-verificar"
  | "verificado"
  | "corrigido"
  | "falhou"
  | "nao-aplicavel";

/** O que a verificação mediu. `null` = ainda não foi medido. */
export type OptimizeResultado = "sem-problema" | "problema" | null;

/** Severidade MEDIDA (vem do serviço/hardware, nunca do catálogo). */
export type OptimizeSeveridade = "critico" | "atencao" | null;

export interface OptimizeCartaoBase {
  id: string;
  /** Título honesto: diz o que o cartão faz, não o que o id histórico chama. */
  titulo: string;
  /** Porque é que isto importa, em linguagem de pessoa. */
  motivo: string;
  tipo: OptimizeTipo;
  acaoTipo: OptimizeAcaoTipo;
  /** Rótulo do botão. Nunca promete o que não executa. */
  botao: string;
  /** O que a pessoa faz à mão quando o CyberSafe não pode fá-lo. */
  instrucao?: string;
  /** Precisa de confirmação antes de correr (operação longa ou cara). */
  confirmar?: string;
}

/**
 * Os dez cartões que existiam, agora com o que cada um realmente é.
 *
 * `scanner-run` estava fundido com `update`: os dois chamavam
 * `updateDefinitions()` e quase tinham o mesmo título. Manter os dois era
 * oferecer duas vezes a mesma operação com números diferentes — o cartão ficou
 * marcado como `nao-aplicavel` e a razão está em `AUDITORIA_BOTOES`.
 */
export const CARTOES: OptimizeCartaoBase[] = [
  {
    id: "firewall",
    titulo: "Firewall do Windows",
    motivo: "É a primeira barreira às ligações que entram pela rede.",
    tipo: "problema-potencial",
    acaoTipo: "verificacao",
    botao: "Verificar estado",
    instrucao: "Se estiver desligado, liga-o em Definições → Privacidade e segurança → Segurança do Windows.",
  },
  {
    id: "saude-windows",
    titulo: "Saúde geral do Windows",
    motivo: "Concentra atualizações, serviços e proteção que o serviço consegue ler.",
    tipo: "problema-potencial",
    acaoTipo: "verificacao",
    botao: "Verificar saúde",
  },
  {
    id: "disco",
    titulo: "Espaço livre em disco",
    motivo: "Sem espaço, o Windows falha, não instala atualizações e os programas deixam de abrir.",
    tipo: "problema-potencial",
    acaoTipo: "verificacao",
    botao: "Reler agora",
  },
  {
    id: "update",
    titulo: "Atualizar definições de ameaças",
    motivo: "Definições velhas não conhecem as ameaças de hoje.",
    tipo: "manutencao",
    acaoTipo: "correcao",
    botao: "Atualizar agora",
  },
  {
    id: "analise-profunda",
    titulo: "Análise profunda do computador",
    motivo: "Procura ameaças para além das áreas vigiadas em contínuo.",
    tipo: "manutencao",
    acaoTipo: "correcao",
    botao: "Iniciar análise",
    confirmar:
      "Arranca uma análise demorada em todas as pastas do teu utilizador e arranques automáticos. Podes continuar a usar o computador.",
  },
  {
    id: "startup",
    titulo: "Programas que arrancam com o Windows",
    motivo: "Menos programas no arranque significa um computador utilizável mais cedo.",
    tipo: "manutencao",
    acaoTipo: "educativa",
    botao: "Marcar como revisto",
    instrucao: "Revisa a lista no Gestor de Tarefas, separador Arranque. Desativar é decisão tua.",
  },
  {
    id: "browser-update",
    titulo: "Navegador atualizado",
    motivo: "Navegadores desatualizados são a porta mais comum para descargas maliciosas.",
    tipo: "boa-pratica",
    acaoTipo: "educativa",
    botao: "Marcar como revista",
    instrucao: "Abre o menu do navegador e procura atualizações.",
  },
  {
    id: "senhas",
    titulo: "Senhas únicas por conta",
    motivo: "Uma base de dados vazada não chega a mais contas se as senhas forem diferentes.",
    tipo: "boa-pratica",
    acaoTipo: "educativa",
    botao: "Marcar como revista",
    instrucao: "O CyberSafe não gera nem guarda senhas: usa um gestor de senhas à tua escolha.",
  },
  {
    id: "extensoes",
    titulo: "Extensões do navegador",
    motivo: "Cada extensão vê o que escreves e por onde navegas.",
    tipo: "boa-pratica",
    acaoTipo: "educativa",
    botao: "Marcar como revista",
    instrucao: "Remove o que não reconheces; o que ficar, confirma de onde veio.",
  },
  {
    id: "backup",
    titulo: "Cópia de segurança dos dados",
    motivo: "É a única defesa que sobrevive a um ransomware.",
    tipo: "boa-pratica",
    acaoTipo: "educativa",
    botao: "Marcar como feito",
    instrucao: "O CyberSafe não faz cópias: escolhe um disco externo ou um serviço teu.",
  },
];

/** Estado de um cartão no ecrã. */
export interface OptimizeCartao extends OptimizeCartaoBase {
  estado: OptimizeEstado;
  resultado: OptimizeResultado;
  severidade: OptimizeSeveridade;
  /** O que foi medido, em texto. Vazio enquanto não houver medição. */
  evidencia: string;
  /** O que a ação devolveu, para ficar no cartão e não só num aviso que passa. */
  mensagem: string;
}

export function cartoesIniciais(): OptimizeCartao[] {
  return CARTOES.map((base) => ({
    ...base,
    estado: "pendente" as OptimizeEstado,
    resultado: null,
    severidade: null,
    evidencia: "",
    mensagem: "",
  }));
}

/* ═══ GRUPOS ═══════════════════════════════════════════════════════════════
   A separação pedida não é uma re-arrumação do catálogo: um cartão muda de
   grupo consoante o que a verificação mediu. «Problemas detetados e
   comprovados» começa VAGO — enquanto nada estiver medido, não há problema
   comprovado, e preencher a lista com opiniões era exatamente o defeito. */

export type OptimizeGrupo = "problemas" | "manutencao" | "boas-praticas";

export function grupoDe(cartao: OptimizeCartao): OptimizeGrupo {
  const medidoComFalha =
    cartao.tipo === "problema-potencial" && cartao.resultado === "problema";
  if (medidoComFalha) return "problemas";
  if (cartao.tipo === "boa-pratica") return "boas-praticas";
  return "manutencao";
}

export const ROTULO_GRUPO: Record<OptimizeGrupo, { titulo: string; descricao: string; vazio: string }> = {
  problemas: {
    titulo: "Problemas detetados e comprovados",
    descricao: "Cada linha abaixo vem de uma medição desta máquina, não de uma suposição.",
    vazio: "Ainda não há problemas comprovados. Esta lista enche-se com o resultado das verificações — não com recomendações.",
  },
  manutencao: {
    titulo: "Manutenção recomendada",
    descricao: "Tarefas que valem a pena fazer de vez em quando, estejam as coisas boas ou más.",
    vazio: "Nada de manutenção pendente.",
  },
  "boas-praticas": {
    titulo: "Boas práticas opcionais",
    descricao: "Hábitos que o CyberSafe não pode verificar por ti. Não são falhas.",
    vazio: "Nenhuma boa prática nesta lista.",
  },
};

/* ═══ SECÇÕES VISÍVEIS ═════════════════════════════════════════════════════
   A página (15/10) mostra três listas por NATUREZA da linha — o que mede, o que
   vale a pena fazer e o que só a pessoa pode confirmar — e não por resultado:
   assim uma lista não muda de nome quando a medição chega, e a manutenção
   recomendada nunca aparece debaixo de um título que diz «problemas».

   «Problemas comprovados» continua a existir, como NÚMERO: só sobe com uma
   medição (é o que `grupoDe` responde), e a página conta-os num cartão em vez
   de lhes dar uma lista com título próprio. */
export type OptimizeSecao = "verificacoes" | "manutencao" | "manuais";

export function secaoDe(cartao: OptimizeCartaoBase): OptimizeSecao {
  if (cartao.acaoTipo === "verificacao") return "verificacoes";
  if (cartao.acaoTipo === "correcao") return "manutencao";
  return "manuais";
}

/** A ordem de leitura: primeiro o que a app mede, depois o que se faz, no fim
    o que é hábito. */
export const ORDEM_SECOES: OptimizeSecao[] = ["verificacoes", "manutencao", "manuais"];

export const ROTULO_SECAO: Record<OptimizeSecao, { titulo: string; descricao: string }> = {
  verificacoes: {
    titulo: "Verificações automáticas",
    descricao: "Medem esta máquina sem pedir decisão a ninguém. É o que «Verificar tudo agora» corre.",
  },
  manutencao: {
    titulo: "Manutenção recomendada",
    descricao: "Vale a pena fazer de vez em quando, esteja o PC bom ou mau. Não é uma falha medida.",
  },
  manuais: {
    titulo: "Ações manuais",
    descricao: "O CyberSafe não consegue medir isto: marcas tu quando estiver feito.",
  },
};

/* ═══ CLASSIFICAÇÃO ════════════════════════════════════════════════════════
   A regra que evita o «Crítico» a tudo: a palavra só existe quando há uma
   severidade medida. Um cartão verificado como saudável diz «Saudável»; uma
   dica de senhas diz «Opcional», hoje e sempre. */

export interface OptimizeClassificacao {
  rotulo: string;
  /** Tom semântico do produto: ciano/âmbar/vermelho/verde, nunca azul. */
  tom: "ok" | "aviso" | "critico" | "neutro";
}

export function classificacaoDe(cartao: OptimizeCartao): OptimizeClassificacao {
  // Copiado para um local: o TypeScript estreita `cartao.estado` ramo a ramo e
  // isso tornaria as comparações seguintes «impossíveis» de escrever.
  const estado = cartao.estado;
  if (estado === "nao-aplicavel") return { rotulo: "Não aplicável", tom: "neutro" };
  if (estado === "a-verificar") return { rotulo: "A verificar", tom: "neutro" };
  if (estado === "falhou") return { rotulo: "Falhou", tom: "aviso" };

  // Severidade medida: é a única coisa que pode dizer «Crítico».
  if (cartao.severidade === "critico") return { rotulo: "Crítico", tom: "critico" };
  if (cartao.severidade === "atencao") return { rotulo: "Atenção", tom: "aviso" };

  if (estado === "corrigido") return { rotulo: "Corrigido", tom: "ok" };
  if (cartao.resultado === "sem-problema") return { rotulo: "Saudável", tom: "ok" };
  if (cartao.tipo === "problema-potencial") {
    return estado === "verificado"
      ? { rotulo: "Visto, sem medição", tom: "neutro" }
      : { rotulo: "Por verificar", tom: "neutro" };
  }
  if (cartao.tipo === "manutencao") {
    return estado === "verificado" ? { rotulo: "Em dia", tom: "ok" } : { rotulo: "Manutenção", tom: "neutro" };
  }
  return estado === "verificado" ? { rotulo: "Revista", tom: "ok" } : { rotulo: "Opcional", tom: "neutro" };
}

export const ROTULO_ESTADO: Record<OptimizeEstado, string> = {
  pendente: "Pendente",
  "a-verificar": "A verificar",
  verificado: "Verificado",
  corrigido: "Corrigido",
  falhou: "Falhou",
  "nao-aplicavel": "Não aplicável",
};

/** O estado é sempre dito com o verbo certo: verificar não é corrigir. */
export function resumoEstado(cartao: OptimizeCartao): string {
  switch (cartao.estado) {
    case "verificado":
      return cartao.resultado === "problema" ? "Verificado: encontrou uma falha" : "Verificado: sem falha";
    case "corrigido":
      return "Corrigido pela aplicação";
    case "falhou":
      return "A operação não concluiu";
    case "nao-aplicavel":
      return "Não se aplica neste computador";
    case "a-verificar":
      return "Em curso";
    default:
      return "Ainda não foi visto";
  }
}

/* ═══ TRANSIÇÕES ═══════════════════════════════════════════════════════════
   Uma máquina de estados curta, porque o bug original era «concluído» a ser
   tudo o que existia: uma verificação que não encontra nada não «conclui»
   nada, e um toggle manual não pode aparecer como correção. */

export interface OptimizeDesfecho {
  estado: OptimizeEstado;
  resultado?: OptimizeResultado;
  severidade?: OptimizeSeveridade;
  evidencia?: string;
  mensagem?: string;
}

/**
 * `acaoTipo` decide o que um desfecho significa. O mesmo `ok` é «verificado»
 * numa verificação e «corrigido» numa correção — era esta confusão que fazia o
 * progresso parecer arbitrário.
 */
export function aplicarDesfecho(
  cartao: OptimizeCartao,
  acao: OptimizeAcaoTipo,
  desfecho: { ok: boolean; severidade?: OptimizeSeveridade; evidencia?: string; mensagem: string },
): OptimizeCartao {
  const base: OptimizeDesfecho = desfecho.ok
    ? acao === "verificacao"
      ? {
          estado: "verificado",
          resultado: desfecho.severidade ? "problema" : "sem-problema",
          severidade: desfecho.severidade ?? null,
          evidencia: desfecho.evidencia ?? "",
          mensagem: desfecho.mensagem,
        }
      : {
          estado: "corrigido",
          evidencia: desfecho.evidencia ?? cartao.evidencia,
          mensagem: desfecho.mensagem,
        }
    : { estado: "falhou", mensagem: desfecho.mensagem, evidencia: desfecho.evidencia ?? cartao.evidencia };

  return {
    ...cartao,
    estado: base.estado,
    resultado: base.resultado ?? cartao.resultado,
    severidade: base.severidade ?? null,
    evidencia: base.evidencia ?? cartao.evidencia,
    mensagem: base.mensagem ?? cartao.mensagem,
  };
}

export function marcarRevisaoManual(cartao: OptimizeCartao, mensagem: string): OptimizeCartao {
  return {
    ...cartao,
    estado: "verificado",
    // Uma dica marcada pela pessoa não é uma medição: fica sem severidade e o
    // rótulo diz «Revista», não «Saudável».
    resultado: null,
    severidade: null,
    mensagem,
  };
}

/**
 * O que o botão «Verificar tudo agora» da página pode correr sem pedir
 * decisão a ninguém. A regra é a honestidade do cartão, não a conveniência:
 *
 *  - `verificacao`: mede esta máquina; não escreve nem executa nada;
 *  - sem `confirmar`: uma operação longa ou cara continua a ser humano primeiro;
 *  - `pendente` ou `falhou`: repetir o que já teve resposta é reler o mesmo,
 *    e um cartão já medido perde a evidência anterior sem ganho nenhum.
 */
export function elegivelParaVerificacaoRapida(cartao: OptimizeCartao): boolean {
  return (
    cartao.acaoTipo === "verificacao" &&
    cartao.confirmar === undefined &&
    (cartao.estado === "pendente" || cartao.estado === "falhou")
  );
}

/* ═══ PROGRESSO ════════════════════════════════════════════════════════════
   Dois números que a página antiga misturava: o que já foi VISTO e o que foi
   CORRIGIDO. `concluidos` era um toggle local, por isso uma verificação que
   não encontrou nada contava igual a uma correção real. */

export interface OptimizeProgresso {
  total: number;
  vistos: number;
  corrigidos: number;
  falhados: number;
  /** 0–100 inteiro. Sem divisões por zero nem NaN. */
  percentagem: number;
}

const estadosTerminais = new Set<OptimizeEstado>(["verificado", "corrigido", "falhou", "nao-aplicavel"]);

export function progressoDe(cartoes: OptimizeCartao[]): OptimizeProgresso {
  const total = cartoes.length;
  const vistos = cartoes.filter((c) => estadosTerminais.has(c.estado)).length;
  const corrigidos = cartoes.filter((c) => c.estado === "corrigido").length;
  const falhados = cartoes.filter((c) => c.estado === "falhou").length;
  const percentagem = total > 0 ? Math.round((vistos / total) * 100) : 0;
  return { total, vistos, corrigidos, falhados, percentagem };
}

/** Frase do topo: diz o que o número é, para não ser mais um percentual solto. */
export function fraseProgresso(p: OptimizeProgresso): string {
  const faltam = p.total - p.vistos;
  const base = `${p.vistos} de ${p.total} vistos (${p.percentagem}%)`;
  const resto = faltam > 0 ? ` · faltam ${faltam}` : " · tudo visto";
  const erros = p.falhados > 0 ? ` · ${p.falhados} falharam` : "";
  return `${base}${resto}${erros}`;
}

/**
 * A FASE do progresso, numa palavra. Existe para o número nunca aparecer
 * sozinho: uma percentagem de 0% sem fase ao lado lê-se como resultado, e 0%
 * não é um resultado — é «ainda não se mediu nada».
 */
export function faseProgresso(p: OptimizeProgresso): string {
  if (p.vistos === 0) return "Por começar";
  if (p.vistos >= p.total) return "Tudo visto";
  return "A meio";
}

/* ═══ AUDITORIA DOS DEZ BOTÕES ═════════════════════════════════════════════
   A tabela pedida, em código para o teste a poder verificar em vez de eu a
   escrever à mão em prosa. O `original` é o rótulo que estava na página;
   `real` é o que o botão faz com as pontes que existem hoje. */

export interface OptimizeBotaoAuditado {
  original: string;
  id: string;
  real: "verificação real" | "ação real" | "abertura de ferramenta externa" | "recomendação educativa";
  chamada: string;
  passa: string;
}

export const AUDITORIA_BOTOES: OptimizeBotaoAuditado[] = [
  {
    original: "Verificar (Firewall Windows Ativo)",
    id: "firewall",
    real: "verificação real",
    chamada: "getWindowsHealth().firewall",
    passa: "Deixa de contar como concluído: fica verificado e a classificação vem da leitura (perfis ativos, ou falha real).",
  },
  {
    original: "Atualizar (Atualizar Definições de Ameaças)",
    id: "update",
    real: "ação real",
    chamada: "updateDefinitions()",
    passa: "Corrigido só com `success`; a data devolvida vai para a evidência.",
  },
  {
    original: "Iniciar (Análise Profunda do Computador)",
    id: "analise-profunda",
    real: "ação real",
    chamada: "startScan(\"full\", undefined, \"optimize-page\")",
    passa: "Inicia; não corrige nada. Passa a «Corrigido» seria mentira, por isso fica em curso e o resultado vê-se no Scanner.",
  },
  {
    original: "Verificar (Atualizar Navegador)",
    id: "browser-update",
    real: "recomendação educativa",
    chamada: "nenhuma",
    passa: "O rótulo «Verificar» era falso: nada era verificado. Passa a «Marcar como revista».",
  },
  {
    original: "Gerar (Revisar Senhas)",
    id: "senhas",
    real: "recomendação educativa",
    chamada: "nenhuma",
    passa: "«Gerar» não gerava nada — o botão só fazia toggle. Rótulo mentiu; corrigido.",
  },
  {
    original: "Revisar (Revisar Extensões do Navegador)",
    id: "extensoes",
    real: "recomendação educativa",
    chamada: "nenhuma",
    passa: "Não abre o navegador: não existe ponte para abrir ferramentas externas.",
  },
  {
    original: "Revisar (Otimizar Programas de Inicialização)",
    id: "startup",
    real: "recomendação educativa",
    chamada: "nenhuma",
    passa: "Sem escrita para a lista de arranque no bridge; a instrução diz onde o fazes tu.",
  },
  {
    original: "Configurar (Backup dos Dados Importantes)",
    id: "backup",
    real: "recomendação educativa",
    chamada: "nenhuma",
    passa: "«Configurar» não abria nada; passou a marcar, com a instrução escrita.",
  },
  {
    original: "Atualizar (Atualizar a Base de Dados de Segurança)",
    id: "scanner-run",
    real: "ação real",
    chamada: "updateDefinitions()",
    passa: "A MESMA chamada do cartão «Atualizar definições»: fundido com `update`, porque oferecer duas vezes a mesma operação com títulos quase iguais era a repetição de que a pessoa se queixou.",
  },
  {
    original: "Verificar (Verificar Saúde do Windows)",
    id: "saude-windows",
    real: "verificação real",
    chamada: "getWindowsHealth()",
    passa: "Mostrava `overallStatus` cru (token interno) e um score; agora traduz o estado e usa-o como severidade medida.",
  },
];

/** Tradução do `overallStatus` do serviço — o valor cru não é texto de ecrã. */
export function estadoSaudePt(status: string): { rotulo: string; severidade: OptimizeSeveridade } {
  if (status === "good") return { rotulo: "sem falhas medidas", severidade: null };
  if (status === "attention") return { rotulo: "com avisos", severidade: "atencao" };
  if (status === "critical") return { rotulo: "com falha crítica", severidade: "critico" };
  return { rotulo: "estado desconhecido", severidade: null };
}

/** Severidade medida de uma recomendação do serviço. */
export function severidadeDe(recommendationSeverity: string): OptimizeSeveridade {
  if (recommendationSeverity === "high") return "critico";
  if (recommendationSeverity === "medium") return "atencao";
  return null;
}

/**
 * O que o parser da saúde do Windows entrega sobre o firewall (contrato R5-L1,
 * 11/10/2026): quando a leitura não é fiável, `available` é `false` e
 * `enabled` passa a NON ser fiável — pode ser `false` só porque ninguém leu.
 *
 * Por isso a ordem é sempre: primeiro `available`, depois `enabled`. Tratar
 * `enabled === false` sem `available === true` como «desligado» seria dizer a
 * uma pessoa que ela está desprotegida com base na ausência de uma medição — o
 * erro inverso ao que o parser acabou de corrigir.
 */
export interface FirewallLido {
  available?: boolean;
  enabled?: boolean;
  profiles?: { name: string; enabled: boolean }[];
}

export interface InterpretaFirewall {
  confirmado: boolean;
  severidade: OptimizeSeveridade;
  evidencia: string;
  mensagem: string;
}

export function interpretaFirewall(fw: FirewallLido | null | undefined): InterpretaFirewall {
  if (!fw || fw.available !== true) {
    return {
      confirmado: false,
      severidade: null,
      evidencia: "sem leitura fiável do firewall",
      mensagem: "Não foi possível confirmar o estado do firewall do Windows a partir do serviço. Não se afirma ativo nem desativado.",
    };
  }
  const perfis = fw.profiles ?? [];
  const ligados = perfis.filter((perfil) => perfil.enabled).map((perfil) => perfil.name);
  const desligados = perfis.filter((perfil) => !perfil.enabled).map((perfil) => perfil.name);
  if (fw.enabled === true) {
    return {
      confirmado: true,
      severidade: null,
      evidencia: `ativo nos perfis: ${ligados.join(", ") || "pelo menos um"}`,
      mensagem: "Nada a fazer: o firewall está ativo.",
    };
  }
  return {
    confirmado: true,
    severidade: "critico",
    evidencia: `desligado nos perfis: ${desligados.join(", ") || "não identificado"}`,
    mensagem: "O firewall do Windows está desligado nos perfis acima. Liga-o em Definições → Privacidade e segurança → Segurança do Windows.",
  };
}
