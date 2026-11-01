import { useCallback, useEffect, useMemo, useState } from "react"
import {
  ShieldCheck, HardDrive, RefreshCw,
  Info, Globe,
  Cpu, Lock, Loader2, Stethoscope,
  CircleCheck, Play,
  ScanSearch, Power, Puzzle, DatabaseBackup,
} from "lucide-react"
import { cn } from "@/lib/utils"
import type { EngineHealth, HardwareSnapshot, ProtectionStatus } from "@cybersafe/shared-types"
import {
  describeDiskSpace,
  levelMeta,
  realtimeProtectionCopy,
  type ProtectionLevel,
  type RealtimeProtectionInfo,
} from "@/lib/protectionHealth"
import ProtectionDetails from "@/components/ProtectionDetails"
import { EngineGrid } from "@/components/visual/EngineGrid"
import { formatGb } from "@/lib/diskDisplay"
import { cpuUsageDisplay } from "@/lib/cpuUsage"
import { ramUsageDisplay } from "@/lib/ramUsageDisplay";
import { definitionUpdateCard } from "@/lib/definitionUpdateResult"
import {
  linhasDasDefinicoes,
  type LinhaDefinicoes,
} from "@/lib/definitionsStatusPresentation"
import {
  AUDITORIA_BOTOES,
  aplicarDesfecho,
  cartoesIniciais,
  classificacaoDe,
  elegivelParaVerificacaoRapida,
  estadoSaudePt,
  faseProgresso,
  fraseProgresso,
  grupoDe,
  interpretaFirewall,
  marcarRevisaoManual,
  ORDEM_SECOES,
  progressoDe,
  resumoEstado,
  ROTULO_SECAO,
  secaoDe,
  severidadeDe,
  type OptimizeCartao,
  type OptimizeClassificacao,
  type OptimizeSecao,
} from "@/lib/optimizeModel"

/** Ícone por cartão. O modelo é puro e não conhece o React. O ícone descreve o
    QUE A LINHA FAZ — não o tom do estado: uma análise profunda é uma busca, não
    um alerta, e o vermelho por omissão numa linha pendente era exatamente o
    defeito que a ronda 5 apanhou na cor. */
const ICONES: Record<string, React.ElementType> = {
  firewall: ShieldCheck,
  "saude-windows": Stethoscope,
  disco: HardDrive,
  update: RefreshCw,
  "analise-profunda": ScanSearch,
  startup: Power,
  "browser-update": Globe,
  senhas: Lock,
  extensoes: Puzzle,
  backup: DatabaseBackup,
};

/** O tom da classificação traduz-se nas primitivas de estado do sistema de
    design (index.css), não em classes inventadas aqui. */
const CHIP: Record<OptimizeClassificacao["tom"] | "proc", string> = {
  ok: "state-chip state-chip--ok",
  aviso: "state-chip state-chip--warn",
  critico: "state-chip state-chip--crit",
  neutro: "state-chip state-chip--na",
  proc: "state-chip state-chip--proc",
};

/* O chip do estado de uma base segue o rótulo, não a severidade agregada:
   «Nunca verificado» não é sucesso e por isso não fica verde. */
const CHIP_DEFINICOES: Record<string, string> = {
  Atualizado: "state-chip state-chip--ok",
  Desatualizado: "state-chip state-chip--warn",
  Degradado: "state-chip state-chip--warn",
  Indisponível: "state-chip state-chip--warn",
  "Nunca verificado": "state-chip state-chip--na",
};

const MOSAICO: Record<OptimizeClassificacao["tom"] | "proc", string> = {
  ok: "icon-tile icon-tile--ok",
  aviso: "icon-tile icon-tile--warn",
  critico: "icon-tile icon-tile--crit",
  neutro: "icon-tile",
  proc: "icon-tile icon-tile--proc",
};

/**
 * Tinta por NATUREZA da secção (15/10, feedback humano da C4: legível mas
 * monocromática). É o OUTRO eixo do `MOSAICO`: só entra numa linha que ainda não
 * tem estado medido, para o ícone poder dizer «isto é uma verificação» / «isto é
 * manutenção» / «isto fazes tu» sem que isso se confunda com um resultado. O chip
 * da direita continua a ser a única fonte de verde/âmbar/vermelho de estado.
 */
const MOSAICO_SECCAO: Record<OptimizeSecao, string> = {
  verificacoes: "icon-tile icon-tile--sec-check",
  manutencao: "icon-tile icon-tile--sec-maint",
  manuais: "icon-tile icon-tile--sec-manual",
};

/** Mosaico de uma linha: estado medido manda; sem medição, manda a natureza. */
function mosaicoDe(cartao: OptimizeCartao, tom: OptimizeClassificacao["tom"] | "proc"): string {
  if (tom === "proc") return MOSAICO.proc;
  if (tom !== "neutro") return MOSAICO[tom];
  return MOSAICO_SECCAO[secaoDe(cartao)];
}

/** O cartão em curso é o único estado que não vem da classificação. */
function tomVisual(cartao: OptimizeCartao): OptimizeClassificacao["tom"] | "proc" {
  if (cartao.estado === "a-verificar") return "proc";
  return classificacaoDe(cartao).tom;
}

/**
 * O ESTADO GLOBAL da proteção, com a origem escrita junto do valor.
 *
 * A fonte é o motor de proteção lido pelo serviço — o MESMO objeto que alimenta
 * o Painel (`App.tsx`, `buildDashboard`/`deriveProtectionLevel`). Esta página
 * não derive nada próprio: a tentativa anterior de afirmar proteção a partir do
 * firewall media uma PEÇA e mostrava-a como se fosse o todo. Com o `nivel` a
 * vir de fora, o que a Otimizar pode fazer é mostrá-lo identificado, e manter
 * as suas próprias medições (firewall, saúde do Windows, disco) noutro plano.
 *
 * `ProtectionStatus` continua a ser lido aqui porque «sem leitura» é um estado
 * que tem de se poder dizer, não um 0.
 */
interface ProtecaoGlobal {
  /** Nível derivado pelo App. Nunca é calculado nesta página. */
  nivel: ProtectionLevel;
  /** O estado cru do motor; `null` = o serviço não devolveu nada. */
  estado: ProtectionStatus | null;
  motores?: EngineHealth;
  pontuacao: number | null;
  tempoReal: RealtimeProtectionInfo | null;
  servicoLigado: boolean | null;
  aCarregar: boolean;
}

/** Sem prop — arranque, testes, ou página aberta sem ligação ao serviço. */
const SEM_LEITURA: ProtecaoGlobal = {
  nivel: "degraded",
  estado: null,
  pontuacao: null,
  tempoReal: null,
  servicoLigado: null,
  aCarregar: false,
};

const TOM_DO_NIVEL: Record<ProtectionLevel, "ok" | "aviso" | "critico"> = {
  protected: "ok",
  attention: "aviso",
  degraded: "aviso",
  critical: "critico",
};

/** Os quatro sub-motores que o serviço pode reportar, por ordem fixa. */
const MOTORES = ["yara", "hashDb", "clamav", "nativeEngine"] as const;

/**
 * A verificação de espaço em disco, decidida fora do JSX e testável.
 *
 * `describeDiskSpace` devolve `unknown` quando `usedGb`/`totalGb` não são uma
 * leitura fiável. Antes, o cartão ignorava essa distinção, gravava `ok: true`
 * e escrevia «0 GB livres de 0 GB»: um zero inventado e uma verificação dada
 * como concluída sem medição. Sem leitura, a linha FALHA com o motivo.
 */
export function desfechoVerificacaoDisco(
  primary: HardwareSnapshot["disk"]["primary"],
  agora: string,
): { ok: boolean; severidade: "critico" | "atencao" | null; evidencia: string; mensagem: string } {
  if (!primary) {
    return {
      ok: false,
      severidade: null,
      evidencia: `tentativa às ${agora}`,
      mensagem: "O serviço não conseguiu ler os volumes de disco agora.",
    };
  }
  const guia = describeDiskSpace(primary.usedGb, primary.totalGb);
  if (guia.urgency === "unknown" || guia.freeGb === null || guia.totalGb === null) {
    return {
      ok: false,
      severidade: null,
      evidencia: `${primary.mount}: sem leitura fiável de espaço · tentativa às ${agora}`,
      mensagem: "Sem leitura fiável do volume: não foi possível medir espaço livre nem concluir a verificação.",
    };
  }
  const severidade = guia.urgency === "critical" ? "critico" as const : guia.urgency === "tight" ? "atencao" as const : null;
  return {
    ok: true,
    severidade,
    evidencia: `${primary.mount}: ${formatGb(guia.freeGb)} livres de ${formatGb(guia.totalGb)} (medido) · ${agora}`,
    mensagem: guia.action || guia.meaning,
  };
}

/**
 * A página. Três listas por NATUREZA (mede / faz-se / fazes tu), um resumo com
 * o que o SERVIÇO diz, e um progresso que nunca aparece sozinho: o número vai
 * sempre com a fase e com a frase que o define.
 */
export default function OtimizarPage({
  hardware,
  protecao: protecaoGlobal,
}: {
  hardware?: HardwareSnapshot | null;
  protecao?: ProtecaoGlobal | null;
}) {
  const [cartoes, setCartoes] = useState<OptimizeCartao[]>(() => cartoesIniciais());
  const cpuUsage = cpuUsageDisplay(hardware?.cpu);
  const ramUsage = ramUsageDisplay(hardware?.ram);
  const [aExecutar, setAExecutar] = useState<string | null>(null);
  /** Confirmação humana antes de operações longas ou caras. */
  const [aConfirmar, setAConfirmar] = useState<string | null>(null);
  /** O ecrã de detalhes da proteção é o do Painel — a mesma primitiva, aberta
      por um botão explícito aqui em vez do chip de estado. */
  const [detalhesAbertos, setDetalhesAbertos] = useState(false);

  /* Estado por fonte das definições, lido AO SERVIÇO. `null` é «sem leitura
     disponível» — não é «nenhuma base» nem «tudo atualizado». Uma leitura por
     montagem; `definitions.status` está na fila de leituras independentes do
     serviço, por isso não compete com os snapshots nem se repete em cada render. */
  const [fontesDefinicoes, setFontesDefinicoes] = useState<LinhaDefinicoes[] | null>(null);

  const lerDefinicoes = useCallback(async (): Promise<LinhaDefinicoes[]> => {
    // Preload sem este canal: sem leitura, a página não afirma nada sobre as bases.
    if (typeof window.electronAPI?.getDefinitionsStatus !== "function") return [];
    try {
      const linhas = linhasDasDefinicoes(await window.electronAPI.getDefinitionsStatus());
      setFontesDefinicoes(linhas.length > 0 ? linhas : null);
      return linhas;
    } catch {
      setFontesDefinicoes(null);
      return [];
    }
  }, []);

  useEffect(() => {
    void lerDefinicoes();
  }, [lerDefinicoes]);

  /* As três perguntas separam-se, cada uma com o seu estado de leitura, e
     nenhuma se soma às outras: o chip é o nível GLOBAL (fonte: motor de
     proteção, via App); por baixo dizem-se o tempo real e os motores; o estado
     do PC é outra medida e vive nos cartões e nas listas desta página. */
  const protecao = protecaoGlobal ?? SEM_LEITURA;
  const semLeitura = protecao.estado === null && protecao.motores === undefined;
  const aLerEstado = protecao.aCarregar && semLeitura;
  const metaNivel = levelMeta(protecao.nivel);
  const tempoReal = realtimeProtectionCopy(protecao.tempoReal);
  const motoresRespostas = protecao.motores
    ? MOTORES.filter((chave) => protecao.motores?.[chave]?.status === "active").length
    : null;

  const progresso = useMemo(() => progressoDe(cartoes), [cartoes]);
  const porSecao = useMemo(() => {
    const secoes: Record<OptimizeSecao, OptimizeCartao[]> = {
      verificacoes: [], manutencao: [], manuais: [],
    };
    for (const cartao of cartoes) secoes[secaoDe(cartao)].push(cartao);
    return secoes;
  }, [cartoes]);
  const progressoVerificacoes = useMemo(
    () => progressoDe(porSecao.verificacoes),
    [porSecao],
  );

  /** Problemas comprovados = medição de falha, não contagem de opiniões. */
  const problemasComprovados = cartoes.filter((c) => grupoDe(c) === "problemas").length;
  const porVerificar = cartoes.filter(elegivelParaVerificacaoRapida);

  /** Só com uma medição a fase pode vestir o tom de concluído. */
  const tomFase = progresso.vistos >= progresso.total && progresso.falhados === 0
    ? CHIP.ok
    : CHIP.neutro;

  const disco = hardware?.disk.primary ?? null;
  const espaco = disco ? describeDiskSpace(disco.usedGb, disco.totalGb) : null;

  function substituir(id: string, novo: OptimizeCartao) {
    setCartoes((prev) => prev.map((c) => (c.id === id ? novo : c)));
  }

  const agora = () => new Date().toLocaleTimeString("pt-PT");

  /** O trabalho de um cartão, sem o portão de confirmação: é isto que a
      verificação em bloco chama, um cartão de cada vez. */
  async function correr(cartao: OptimizeCartao) {
    if (!window.electronAPI) {
      substituir(cartao.id, {
        ...cartao,
        estado: "nao-aplicavel",
        mensagem: "Sem ligação ao motor de proteção nesta janela: nada foi medido nem alterado.",
      });
      return;
    }

    setAExecutar(cartao.id);
    try {
      if (cartao.id === "disco") {
        substituir(cartao.id, aplicarDesfecho(cartao, "verificacao", desfechoVerificacaoDisco(hardware?.disk.primary ?? null, agora())));
        return;
      }

      if (cartao.id === "firewall" || cartao.id === "saude-windows") {
        const saude = await window.electronAPI.getWindowsHealth();
        if (!saude) {
          substituir(cartao.id, aplicarDesfecho(cartao, "verificacao", {
            ok: false,
            mensagem: "O serviço devolveu uma leitura vazia: não é possível afirmar nada.",
          }));
          return;
        }
        if (cartao.id === "firewall") {
          // A interpretação vive em lib/optimizeModel e está testada: sem
          // leitura fiável (`available !== true`, contrato R5-L1 do parser)
          // não se afirma ativo NEM desativado.
          const fw = interpretaFirewall(saude.firewall);
          substituir(cartao.id, aplicarDesfecho(cartao, "verificacao", {
            ok: fw.confirmado,
            severidade: fw.severidade,
            evidencia: `${fw.evidencia} · lido às ${agora()}`,
            mensagem: fw.mensagem,
          }));
          return;
        }
        const estado = estadoSaudePt(saude.overallStatus);
        const medidas = saude.recommendations.map((r) => severidadeDe(r.severity));
        const piorSeveridade = medidas.includes("critico")
          ? "critico"
          : medidas.includes("atencao")
            ? "atencao"
            : null;
        const pior = saude.recommendations.find((r) => piorSeveridade && severidadeDe(r.severity) === piorSeveridade);
        substituir(cartao.id, aplicarDesfecho(cartao, "verificacao", {
          ok: true,
          severidade: piorSeveridade ?? estado.severidade,
          evidencia: `estado medido: ${estado.rotulo} · nota do serviço ${saude.score}/100 · ${saude.recommendations.length} recomendação(ões) · lido às ${agora()}`,
          mensagem: pior ? `${pior.title}: ${pior.suggestion || pior.description}` : "Sem recomendações com severidade medida.",
        }));
        return;
      }

      if (cartao.id === "update") {
        const res = await window.electronAPI.updateDefinitions();
        const cartaoOperacao = definitionUpdateCard(cartao, res);
        // O resultado do pedido não confirma o estado por fonte: a página volta a
        // perguntá-lo ao serviço. Sem leitura, o cartão fica só com o confirmado.
        const linhas = await lerDefinicoes();
        substituir(cartao.id, linhas.length > 0
          ? { ...cartaoOperacao, evidencia: `${cartaoOperacao.evidencia} · ${linhas.map((l) => l.texto).join(" · ")}` }
          : cartaoOperacao);
        return;
      }

      if (cartao.id === "analise-profunda") {
        const res = await window.electronAPI.startScan("full", undefined, "optimize-page");
        if (res?.success) {
          // Não é «corrigido»: uma análise que começou não encontrou nada ainda.
          substituir(cartao.id, {
            ...cartao,
            estado: "a-verificar",
            mensagem: `Análise iniciada (id ${res.id}). O resultado vê-se em Análise de Segurança.`,
            evidencia: `iniciada às ${agora()}`,
          });
        } else {
          substituir(cartao.id, aplicarDesfecho(cartao, "correcao", {
            ok: false,
            mensagem: res?.error ?? "Não foi possível iniciar a análise. Pode já haver uma em curso.",
          }));
        }
        return;
      }

      substituir(cartao.id, aplicarDesfecho(cartao, "correcao", {
        ok: false,
        mensagem: "Esta linha não tem nenhuma operação ligada: nada foi feito.",
      }));
    } catch (erro) {
      substituir(cartao.id, aplicarDesfecho(cartao, "correcao", {
        ok: false,
        mensagem: `Falhou: ${erro instanceof Error ? erro.message : String(erro)}`,
      }));
    } finally {
      setAExecutar(null);
    }
  }

  async function executar(cartao: OptimizeCartao) {
    if (aExecutar) return;

    if (cartao.confirmar && aConfirmar !== cartao.id) {
      setAConfirmar(cartao.id);
      return;
    }
    setAConfirmar(null);

    // Educativo: a pessoa afirma que tratou disso. Não é medição nem correção.
    if (cartao.acaoTipo === "educativa") {
      substituir(cartao.id, marcarRevisaoManual(cartao, `Marcado como revisto por ti às ${agora()}.`));
      return;
    }

    await correr(cartao);
  }

  /** A ação única do ecrã: corre sozinha as verificações que não pedem
      decisão nem escrevem em lado nenhum. */
  async function verificarTudo() {
    if (aExecutar) return;
    setAConfirmar(null);
    for (const alvo of porVerificar) await correr(alvo);
  }

  function desfazer(cartao: OptimizeCartao) {
    substituir(cartao.id, { ...cartao, estado: "pendente", resultado: null, severidade: null, mensagem: "", evidencia: "" });
  }

  return (
    <div className="page-shell animate-in fade-in slide-in-from-bottom-4 duration-500" aria-busy={aExecutar !== null}>
      {/* CABEÇALHO — duas linhas no máximo. O que a página faz diz-se uma vez,
          em uma linha; a explicação longa de cada lista vive na lista dela. */}
      <header className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
        <div className="min-w-[260px] flex-1">
          <p className="eyebrow-label">Segurança do sistema</p>
          <h1 className="page-title mt-1.5 text-2xl font-bold font-mono tracking-tight leading-tight text-foreground">
            Otimizar Sistema
          </h1>
          <p className="mt-2 max-w-[64ch] text-sm leading-relaxed text-muted-foreground">
            O que foi medido nesta máquina, o que vale a pena fazer e o que só tu podes confirmar.
          </p>
        </div>

        {/* O progresso nunca aparece sozinho: o número vai com a fase ao lado, a
            barra, a frase que o define E a legenda do que a palavra «vistos»
            conta. Zero visto não é resultado nenhum, por isso o número só veste
            o acento do tema depois de haver a primeira medição. */}
        <div className="w-[min(100%,300px)] shrink-0">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
            <span className="eyebrow-label">Progresso</span>
            <span className={tomFase}>{faseProgresso(progresso)}</span>
          </div>
          <div className="mt-2 flex items-baseline justify-between gap-3">
            <span className={cn(
              "text-2xl font-semibold tabular-nums",
              progresso.percentagem > 0 ? "text-primary" : "text-muted-foreground",
            )}>
              {progresso.percentagem}
              <span className="text-base font-normal text-muted-foreground">%</span>
            </span>
          </div>
          <div
            className="progress-bar-track mt-2 h-1.5"
            role="progressbar"
            aria-valuenow={progresso.percentagem}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Progresso das linhas vistas"
          >
            <div className="progress-bar-fill" style={{ width: `${progresso.percentagem}%` }} />
          </div>
          <p className="row-meta mt-2" aria-live="polite">{fraseProgresso(progresso)}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
            {/* Verificar e corrigir são números separados, e os dois visíveis:
                uma verificação que não encontra nada não é uma correção. */}
            <span className={progresso.corrigidos > 0 ? CHIP.ok : CHIP.neutro}>
              {progresso.corrigidos} correç{progresso.corrigidos === 1 ? "ão" : "ões"}
            </span>
            <span className="row-meta">«Vistos» é o que já foi medido ou tentado.</span>
          </div>
        </div>
      </header>

      {/* ═══ RESUMO — três medidas REAIS, lado a lado ═══
          Todas as que aqui estão são leituras: o motor de proteção (a fonte
          única do App), o que foi medido nas verificações desta máquina e a
          telemetria do PC. Nenhuma é uma estimativa e nenhuma soma as outras.

          SEM RESULTADO NÃO MEDIDO COMO DISPONÍVEL: enquanto não há leitura, o
          chip diz «a ler» ou «sem leitura» — nunca herda um verde do valor por
          omissão. O nível por omissão é `degraded` (ver SEM_LEITURA). */}
      <section className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {/* 1 · Proteção global — o painel do serviço, com a origem escrita. */}
        <div className="stat-card flex flex-col gap-3 p-4">
          <div className="min-w-0">
            <p className="eyebrow-label">Estado global da proteção</p>
            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5">
              {aLerEstado ? (
                <span className="state-chip state-chip--proc">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  A ler o estado de proteção…
                </span>
              ) : semLeitura ? (
                <span className={CHIP.neutro}>{metaNivel.label} · sem leitura do motor</span>
              ) : (
                <span className={CHIP[TOM_DO_NIVEL[protecao.nivel]]}>{metaNivel.label}</span>
              )}
            </div>
            <div className="row-meta mt-2 flex flex-wrap gap-x-3 gap-y-1">
              <span>Tempo real: {tempoReal ? tempoReal.text : "sem leitura"}</span>
              <span>Motores: {motoresRespostas === null ? "sem leitura" : `${motoresRespostas} de ${MOTORES.length} a responder`}</span>
              {protecao.pontuacao != null && <span>Nota do motor: {protecao.pontuacao}/100</span>}
            </div>
            <p className="row-meta mt-2">
              {protecao.servicoLigado === false
                ? "Sem ligação ao serviço: nada aqui foi lido, e o nível mostrado é o valor por omissão do produto, não uma medição."
                : protecao.estado === null
                  ? "Ainda sem leitura do motor de proteção. O nível por omissão é «precisa de atenção»; nada é afirmado saudável."
                  : "Origem: motor de proteção do CyberSafe — a mesma leitura do Painel. O estado do PC é outra medida e vê-se nos cartões e nas listas abaixo."}
            </p>
          </div>

          {/* O acesso aos detalhes era só o chip de estado no Painel — uma coisa
              que se parece com uma etiqueta e só é um botão depois de se clicar
              nela. Aqui é um botão com nome, no contorno de linha (nunca cheio:
              a ação cheia deste ecrã é uma só). */}
          <button
            type="button"
            onClick={() => setDetalhesAbertos(true)}
            className="mt-auto inline-flex h-9 w-fit items-center gap-2 rounded-lg border border-border px-3 text-sm font-semibold text-foreground transition-colors hover:bg-secondary/60"
          >
            <ShieldCheck className="h-4 w-4" aria-hidden />
            Ver detalhes da proteção
          </button>
        </div>

        {/* 2 · Verificações automáticas — o número é o das que JÁ responderam
            (medidas, corrigidas ou falhadas), não o das que o catálogo tem. */}
        <div className="stat-card flex flex-col gap-3 p-4">
          <p className="eyebrow-label">Verificações automáticas</p>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-semibold tabular-nums text-foreground">
              {progressoVerificacoes.vistos}
            </span>
            <span className="row-meta">
              de {progressoVerificacoes.total} já com resposta
            </span>
          </div>
          <p className="row-meta">
            Medem esta máquina sem pedir decisão e sem escrever nada. O que falhou volta a correr.
          </p>

          <div className="mt-auto space-y-1.5">
            <button
              type="button"
              onClick={() => void verificarTudo()}
              disabled={aExecutar !== null || porVerificar.length === 0}
              className="cyber-glow inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground transition-all hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {aExecutar ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              {aExecutar ? "A verificar…"
                : porVerificar.length === 0 ? "Nada por verificar"
                : `Verificar tudo agora (${porVerificar.length})`}
            </button>

            {/* Um botão desativado sem explicação é um beco. A frase só aparece
                quando não há nada para correr, e diz o critério em vez de
                prometer uma ação que não existe. */}
            {!aExecutar && porVerificar.length === 0 && (
              <p className="row-meta max-w-[82ch]">
                Não há nada por verificar: esta ação corre só o que ainda não foi visto ou o que
                falhou. Para repetir uma linha que já respondeu, usa o botão dessa linha.
              </p>
            )}
          </div>
        </div>

        {/* 3 · Problemas comprovados — um NÚMERO, não uma lista com título
            próprio: só conta o que uma verificação REAL mediu, e por isso pode
            ficar em zero sem que isso seja uma boa notícia. */}
        <div className="stat-card flex flex-col gap-3 p-4">
          <div className="flex items-start gap-3">
            {/* A contagem vazia tem duas razões muito diferentes, e o ícone tem
                de as distinguir: «medimos e não havia nada» é um check; «ainda
                não medimos nada» não é bom resultado nenhum — é o Info de uma
                coisa que se vai fazer. */}
            <span
              className={cn(
                "icon-tile",
                // A cor segue a MEDIDA, nunca o desejo: âmbar só quando há
                // problemas comprovados, verde só quando houve medição limpa,
                // ciano quando ainda é uma verificação por fazer.
                problemasComprovados > 0 ? "icon-tile--warn"
                  : progresso.vistos > 0 ? "icon-tile--ok"
                    : "icon-tile--sec-check",
              )}
              aria-hidden
            >
              {progresso.vistos > 0 ? <CircleCheck className="h-4 w-4" /> : <Info className="h-4 w-4" />}
            </span>
            <div className="min-w-0">
              <p className="eyebrow-label">Problemas comprovados</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums text-foreground">{problemasComprovados}</p>
            </div>
          </div>
          <p className="row-meta">
            {problemasComprovados > 0
              ? "Cada um veio de uma medição desta máquina. As linhas marcadas estão nas listas abaixo."
              : progresso.vistos > 0
                ? "As verificações que correram não encontraram falhas. Isto não é uma aprovação do que ainda não foi visto."
                : "Ainda não há problemas comprovados: esta contagem só sobe com uma medição — não com recomendações."}
          </p>
        </div>

        {/* 4 · Este PC agora — telemetria. É OUTRA medida e fica fora da faixa
            do motor de proteção, sem se somar a ela. */}
        <div className="stat-card flex flex-col gap-3 p-4">
          <p className="eyebrow-label">Este PC agora</p>
          {hardware && cpuUsage.value != null && ramUsage.value != null ? (
            <p className="text-2xl font-semibold tabular-nums text-foreground">
              CPU {cpuUsage.text} · RAM {ramUsage.text}
            </p>
          ) : (
            <p className="text-2xl font-semibold text-muted-foreground">Sem leitura</p>
          )}
          <p className="row-meta">
            {espaco && espaco.urgency !== "unknown" && espaco.freeGb != null
              ? `Disco ${disco?.mount}: ${formatGb(espaco.freeGb)} livres de ${formatGb(espaco.totalGb ?? 0)}.`
              : "Carga instantânea do sistema. Sem disco medido nesta leitura."}
          </p>
        </div>
      </section>

      {/* ═══ MOTORES E DEFINIÇÕES ═══
          Os quatro motores sempre presentes, com o estado que o serviço
          reportou. É informação diferente das verificações desta página:
          aqui não se mede o PC, lê-se o que os motores de análise dizem de si.
          Sem ligação confirmada, o próprio EngineGrid recusa pintar estado. */}
      <section className="space-y-2" data-optimize-engines>
        <div className="px-0.5">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="text-sm font-mono font-bold uppercase tracking-wider text-foreground">Definições e motores</h2>
            <span className="row-meta">Estado reportado pelo serviço</span>
          </div>
          <p className="row-meta mt-1 max-w-[92ch]">
            YARA, HashDB e ClamAV são motores distintos. Um motor indisponível não é o mesmo que uma definição desatualizada.
          </p>
        </div>
        <EngineGrid engine={protecao.motores} conexao={protecao.servicoLigado} />
        <p className="row-meta">
          {protecao.motores?.definitionsUpdatedAt && Number.isFinite(Date.parse(protecao.motores.definitionsUpdatedAt))
            ? `Última atualização de definições reportada: ${new Date(protecao.motores.definitionsUpdatedAt).toLocaleString("pt-PT")}.`
            : "O serviço não reportou a data da última atualização de definições nesta leitura."}
        </p>
      </section>

      {/* ═══ AS TRÊS LISTAS ═══
          Cada secção diz o que as linhas dela SÃO e conta-as. O título não é um
          veredicto: «manutenção recomendada» nunca aparece debaixo de um título
          que afirme um problema, e um problema medido aparece marcado na linha,
          não no cabeçalho da lista. */}
      {ORDEM_SECOES.map((secao) => {
        const linhas = porSecao[secao];
        return (
          <section key={secao} className="space-y-2">
            <div className="px-0.5">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                {/* Ponto de secção: cor de NATUREZA, não de estado. `manuais` é
                    uma argola vazia de propósito — ali não há resultado a mostrar. */}
                <span className={cn("sec-dot", `sec-dot--${secao}`)} aria-hidden />
                <h2 className="text-sm font-mono font-bold uppercase tracking-wider text-foreground">
                  {ROTULO_SECAO[secao].titulo}
                </h2>
                <span className="row-meta tabular-nums">
                  {linhas.length} linha{linhas.length === 1 ? "" : "s"}
                </span>
              </div>
              <p className="row-meta mt-1 max-w-[92ch]">{ROTULO_SECAO[secao].descricao}</p>
            </div>

            {linhas.length === 0 ? (
              <div className="stat-card flex items-start gap-3 p-4">
                <span className="icon-tile" aria-hidden>
                  <Info className="h-4 w-4" />
                </span>
                <p className="row-note">Nada nesta lista.</p>
              </div>
            ) : (
              <div className="stat-card overflow-hidden">
                <div className="row-list">
                  {linhas.map((cartao, i) => (
                    <LinhaOtimizar
                      key={cartao.id}
                      cartao={cartao}
                      indice={secao === "manuais" ? i + 1 : null}
                      aOcupado={aExecutar !== null}
                      aCorrer={aExecutar === cartao.id}
                      emConfirmacao={aConfirmar === cartao.id}
                      onExecutar={() => void executar(cartao)}
                      onDesfazer={() => desfazer(cartao)}
                      onCancelarConfirmacao={() => setAConfirmar(null)}
                    />
                  ))}
                </div>
              </div>
            )}
          </section>
        );
      })}

      {/* Estado por fonte, lido ao serviço ao montar. Não é um nível de proteção:
          cada linha afirma uma base e nada mais. */}
      <section className="animate-in fade-in slide-in-from-bottom-4 duration-500">
        <div className="mb-3 flex items-center gap-2">
          <h2 className="text-sm font-mono font-bold uppercase tracking-wider text-foreground">
            Definições de segurança
          </h2>
          <span className="row-meta tabular-nums">
            {fontesDefinicoes === null ? "sem leitura" : `${fontesDefinicoes.length} fonte(s)`}
          </span>
        </div>
        {fontesDefinicoes === null ? (
          <div className="stat-card flex items-start gap-3 p-4">
            <span className="icon-tile" aria-hidden>
              <Info className="h-4 w-4" />
            </span>
            <p className="row-note">
              O serviço não devolveu o estado por fonte. Nenhuma base é dada como atualizada —
              o botão «Atualizar definições» mostra o que o pedido confirmou, mas não prova
              que alguma base mudou.
            </p>
          </div>
        ) : (
          <div className="stat-card overflow-hidden">
            <div className="row-list">
              {fontesDefinicoes.map((fonte) => (
                <div key={fonte.fonte} className="row-item">
                  <div className="min-w-0 flex-1">
                    <p className="row-title">{fonte.nome}</p>
                    <p className="row-note">
                      {fonte.texto.startsWith(`${fonte.nome} — `)
                        ? fonte.texto.slice(fonte.nome.length + 3)
                        : fonte.texto}
                    </p>
                  </div>
                  <span className={CHIP_DEFINICOES[fonte.rotulo] ?? "state-chip state-chip--na"}>
                    {fonte.rotulo}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* Progressive disclosure: a auditoria dos botões fica fechada. É prova
          técnica, não leitura de todos os dias. */}
      <details className="group">
        <summary className="row-title flex cursor-pointer list-none items-center gap-2 rounded-lg border border-border px-3 py-2 transition-colors hover:bg-secondary/40">
          <Info className="h-4 w-4 text-muted-foreground" aria-hidden />
          O que cada botão faz realmente
          <span className="row-meta ml-auto tabular-nums">{AUDITORIA_BOTOES.length} cartões auditados</span>
        </summary>
        <div className="mt-2 space-y-3 rounded-lg border border-border bg-secondary/30 p-3">
          <p className="row-note">
            {AUDITORIA_BOTOES.filter((b) => b.real === "verificação real").length} linhas verificam,{" "}
            {AUDITORIA_BOTOES.filter((b) => b.real === "ação real").length} executam operações,{" "}
            {AUDITORIA_BOTOES.filter((b) => b.real === "recomendação educativa").length} são hábitos
            que marcas tu. Nenhuma linha abre uma ferramenta externa: o bridge do CyberSafe não tem
            essa ponte, e um botão a dizê-lo seria falso.
          </p>
          <ul className="space-y-2">
            {AUDITORIA_BOTOES.map((b) => (
              <li key={b.original} className="row-note border-b border-border pb-2 last:border-0">
                <b className="row-title">{b.id}</b>
                <span className="row-meta"> · {b.real} · chama {b.chamada}</span>
                <span className="mt-0.5 block">{b.passa}</span>
              </li>
            ))}
          </ul>
        </div>
      </details>

      {/* A MESMA primitiva do Painel, com a MESMA fonte: o nível global e os
          motores chegam pelo `App` (`buildDashboard`/`deriveProtectionLevel`),
          e a pontuação é a do Painel. Quando não há leitura, nada é passado —
          o diálogo diz «sem leitura» campo a campo, que é o contrato dele. */}
      <ProtectionDetails
        level={protecao.nivel}
        engine={protecao.motores}
        score={protecao.pontuacao ?? undefined}
        open={detalhesAbertos}
        onClose={() => setDetalhesAbertos(false)}
      />
    </div>
  );
}

interface LinhaProps {
  cartao: OptimizeCartao;
  /** Número só nas ações manuais: ali a ordem é leitura, não medição. */
  indice: number | null;
  aOcupado: boolean;
  aCorrer: boolean;
  emConfirmacao: boolean;
  onExecutar: () => void;
  onDesfazer: () => void;
  onCancelarConfirmacao: () => void;
}

/** Uma linha por cartão. O que era dez caixas iguais é uma lista com
    separadores: o peso visual vai para o estado medido, não ao contentor.
    Exportado para os testes da página poderem renderizar um cartão em cada
    estado — a página só mostra o estado inicial em markup estático. */
export function LinhaOtimizar({
  cartao, indice, aOcupado, aCorrer, emConfirmacao,
  onExecutar, onDesfazer, onCancelarConfirmacao,
}: LinhaProps) {
  const Icone = ICONES[cartao.id] ?? Cpu;
  const classe = classificacaoDe(cartao);
  /* O tom DE CARREGAMENTO vem do pedido em voo, não do estado gravado: enquanto
     a linha tem um pedido ao serviço, o que se mostra é «a ler» — nunca o verde
     por omissão nem o vermelho emprestado do catálogo. É assim que o firewall
     e a saúde do Windows têm estado de carregamento visível. */
  const tom = aCorrer ? "proc" : tomVisual(cartao);
  const terminal = cartao.estado === "verificado" || cartao.estado === "corrigido";
  // Só uma medição pode pôr tinta de alerta na linha. Pendente é neutro.
  const medidoCritico = cartao.severidade === "critico";
  const medidoAviso = cartao.severidade === "atencao";
  /* Há resposta para ler: a linha passa a liderar com ela. O `motivo` é frase
     fixa do catálogo — diz porque é que a linha existe, não o que aconteceu —
     por isso desce um degrau em vez de ficar à frente do resultado. E o
     `resumoEstado` sai de cena: com resposta escrita, os dois diriam a mesma
     coisa, e «Verificado: sem falha» sobre um cartão marcado à mão afirmava uma
     verificação que não aconteceu (`marcarRevisaoManual` não mede nada). */
  const comResposta = cartao.mensagem !== "";

  return (
    <article
      className={cn(
        "row-item",
        medidoCritico && "border-l-2 border-l-cyber-red",
        medidoAviso && "border-l-2 border-l-cyber-yellow",
      )}
    >
      {indice === null ? (
        <span className={mosaicoDe(cartao, tom)} aria-hidden>
          {aCorrer ? <Loader2 className="h-4 w-4 animate-spin" /> : <Icone className="h-4 w-4" />}
        </span>
      ) : (
        <span className="row-meta pt-1 text-right tabular-nums">{String(indice).padStart(2, "0")}</span>
      )}

      <div className="min-w-0 space-y-1.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h3 className="row-title">{cartao.titulo}</h3>
          <span className={CHIP[tom]}>{aCorrer ? "A consultar…" : classe.rotulo}</span>
          {!comResposta && <span className="row-meta">{resumoEstado(cartao)}</span>}
        </div>

        {/* O portão de confirmação vive na linha que o pediu: era um painel no
            topo da página, fora do ecrã de quem clicou numa linha do meio, e
            deixava dois botões «Confirmar» no mesmo ecrã. */}
        {emConfirmacao && cartao.confirmar && (
          <p role="alert" className="row-note text-foreground rounded-lg border border-border bg-secondary/30 p-2.5">
            {cartao.confirmar}
          </p>
        )}

        {comResposta && <p className="row-note text-foreground">{cartao.mensagem}</p>}
        {cartao.evidencia && (
          <p className="evidence-line"><b className="font-semibold">Medido:</b> {cartao.evidencia}</p>
        )}
        <p className={comResposta ? "row-meta" : "row-note"}>{cartao.motivo}</p>
        {cartao.instrucao && cartao.estado !== "corrigido" && (
          <p className={cn("row-note", medidoCritico ? "text-cyber-red" : "text-muted-foreground")}>
            {cartao.instrucao}
          </p>
        )}
      </div>

      {cartao.acaoTipo !== "inexistente" && (
        <div className="row-act flex shrink-0 flex-col items-end gap-1.5">
          {/* O rótulo visível e o nome acessível são a MESMA string mais o
              título da linha: num ecrã com dez botões «Verificar», a árvore de
              acessibilidade não diz qual é qual, e um leitor de ecrã lê
              exatamente isso. */}
          <button
            type="button"
            onClick={onExecutar}
            disabled={aOcupado}
            aria-label={`${aCorrer ? "A executar" : emConfirmacao ? "Confirmar" : terminal ? "Repetir" : cartao.botao} — ${cartao.titulo}`}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-sm font-semibold whitespace-nowrap transition-all disabled:cursor-not-allowed disabled:opacity-50",
              emConfirmacao ? "bg-primary text-primary-foreground" : "text-foreground hover:bg-secondary/60",
            )}
          >
            {aCorrer && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
            {aCorrer ? "A executar…" : emConfirmacao ? "Confirmar" : terminal ? "Repetir" : cartao.botao}
          </button>
          {emConfirmacao && (
            <button
              type="button"
              onClick={onCancelarConfirmacao}
              aria-label={`Cancelar a confirmação de ${cartao.titulo}`}
              className="row-meta underline underline-offset-2 text-muted-foreground transition-colors hover:text-foreground"
            >
              Cancelar
            </button>
          )}
          {terminal && cartao.estado === "verificado" && (
            <button
              type="button"
              onClick={onDesfazer}
              aria-label={`Desmarcar a verificação de ${cartao.titulo}`}
              className="row-meta underline underline-offset-2 text-muted-foreground transition-colors hover:text-foreground"
            >
              Desmarcar
            </button>
          )}
        </div>
      )}
    </article>
  );
}
