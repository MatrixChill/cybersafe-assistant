import { ConsolidatedReportModal } from "./ConsolidatedReportModal";
import { Fragment, useCallback, useEffect, useState } from "react";
import {
  AlertTriangle, ChevronDown, ChevronRight, History, Loader2, Printer, ScanSearch,
  FileText,
} from "lucide-react";
import type { ScanHistoryEntry, ScanType, UsbDeviceState } from "@cybersafe/shared-types";
import { cn } from "@/lib/utils";
import { conclusiveHistoryCount, describeScanHistoryOutcome, describeScanTarget, formatDuration } from "@/lib/scanHistoryReport";
import { inconclusiveReasonsLabel, inconclusiveEnginesLabel, type InconclusiveCauseCount, type InconclusiveEngineCount } from "@/lib/scanSession";

/**
 * R7-L3-FOLLOWUP — painel do histórico, DENTRO de "Análise de Segurança".
 *
 * O desenho anterior tinha uma página própria no menu e o teste humano do
 * utilizador disse-o por palavras: fragmenta. Isto é o mesmo conteúdo, como
 * componente: o arranque de uma análise, a que está em curso e o último
 * resultado continuam no topo da página; o arquivo fica por baixo.
 *
 * O que o painel NÃO faz, por contrato:
 *  · não decide estado de análise — quem o alimenta é o `FileScannerPage`, que
 *    passa `sessaoTerminada` (o id do scan que acabou de atingir terminal). É a
 *    única forma de o histórico se refrescar sozinho sem tocar na subscrição,
 *    na adopção de sessão nem no ecrã de recuperação, que são L1/L2;
 *  · não inventa números: um campo ausente não vira `0` mostrado, e sem
 *    limitação reportada pelo motor não há linha de limitação nenhuma;
 *  · não afirma proteção: os estados são `concluída` / `cancelada` / `falhou`.
 *    Não há aqui as palavras «sucesso» nem «protegido»;
 *  · não mostra o que não foi lido: sem bridge diz-se que não consultou, em vez
 *    de uma lista vazia que se leria como «não há análises».
 */

const ESTADO_LABEL: Record<ScanHistoryEntry["status"], string> = {
  completed: "concluída",
  cancelled: "cancelada",
  failed: "falhou",
};

const ESTADO_CHIP: Record<ScanHistoryEntry["status"], string> = {
  completed: "state-chip state-chip--ok",
  cancelled: "state-chip state-chip--na",
  failed: "state-chip state-chip--crit",
};

const MOSAICO_ESTADO: Record<ScanHistoryEntry["status"], string> = {
  completed: "icon-tile icon-tile--ok",
  cancelled: "icon-tile",
  failed: "icon-tile icon-tile--crit",
};

const TIPO_LABEL: Record<ScanType, string> = {
  quick: "Rápida",
  full: "Profunda",
  custom: "Pasta",
};

const AMBITO_LABEL: Record<ScanHistoryEntry["target"], string> = {
  default: "Computador",
  custom: "Pasta escolhida",
};

/**
 * Alvo do registo, como o utilizador o vê.
 *
 * A única coisa que muda face ao rótulo de sempre é a PROVA de USB: quando o
 * registo se liga a uma unidade USB detetada (pelo `scanId` que a unidade
 * publica), diz-se «USB (H:\)» com o nome do volume. Sem essa ligação — ou sem
 * lista de unidades — fica exatamente o rótulo de sempre. O histórico não
 * guarda caminhos do utilizador (é regra do produto, com teste próprio), por
 * isso nunca se adivinha que uma pasta é USB pela letra.
 */
function escopoDe(e: ScanHistoryEntry, usb: readonly UsbDeviceState[] | null): string {
  const prova = describeScanTarget({ kind: e.target, scanId: e.id }, usb);
  return prova.startsWith("USB ") ? prova : AMBITO_LABEL[e.target];
}

/** Fuga de HTML do A4: os campos vêm do serviço e vão para um documento que o
    main renderiza. Sem escapar, um registo com `<` num detalhe seria marcado. */
function esc(valor: unknown): string {
  return String(valor ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// A duração vive em `@/lib/scanHistoryReport` (`formatDuration`): uma so copia,
// ja com o caso medido (818496 ms -> «13 min 38 s»).

/** Data e hora PT-PT; um ISO ilegível diz isso, não «Invalid Date». */
function dataHora(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "data ilegível no registo";
  return d.toLocaleString("pt-PT", { dateStyle: "short", timeStyle: "short" });
}

/** Um campo numérico só se mostra se vier. Ausente não é zero. */
function numero(valor: unknown): number | null {
  return typeof valor === "number" && Number.isFinite(valor) ? valor : null;
}

function contagem(rotulo: string, valor: unknown): string {
  const n = numero(valor);
  return `<li><b>${esc(rotulo)}</b>: ${n === null ? "sem leitura" : esc(n)}</li>`;
}

/**
 * O que a contagem `filesAnalyzed` de um registo PROVA, em palavras.
 *
 * O serviço publica `filesAnalyzed = max(ciclo por ficheiro, veredictos
 * terminais do batch)`: é COBERTURA DE MOTORES, não conclusão do pipeline — é o
 * contrato que `lib/scanSession.ts` declara e que
 * `test/scan-batch-terminal-reconcile.test.js` exige (não recua, nunca é soma).
 * Num scan `cancelled` a etiqueta «Analisados N» lê-se «N ficheiros completaram
 * a análise», e o registo não sustenta isso: medido nesta manutenção, um scan
 * cancelado gravou 2003 enquanto o ciclo por ficheiro fechou 490.
 *
 * O NÚMERO fica intacto — mexer nele seria mudar um contrato aprovado. O que
 * muda é a palavra, e só no `cancelled`; `completed` e `failed` continuam a
 * dizer o que sempre disseram.
 */
export function rotuloDeCobertura(status: ScanHistoryEntry["status"]): {
  label: string;
  nota: string | null;
} {
  if (status === "cancelled") {
    return {
      label: "Verificados por motores",
      nota:
        "Contagem até ao cancelamento: cobertura dos motores. Não prova que cada ficheiro passou por todas as etapas.",
    };
  }
  return { label: "Analisados", nota: null };
}

/**
 * O A4 de UM registo. Só campos reais daquele registo: nada de score, nada de
 * veredicto de proteção, nada de número emprestado de outra página. A rodapé
 * diz o que o documento é e o que não é.
 */
export function htmlDoRelatorio(e: ScanHistoryEntry, usb: readonly UsbDeviceState[] | null): string {
  const resultado = describeScanHistoryOutcome(e.status, e.filesInconclusive);
  const limitacoes = Array.isArray(e.engineLimitations) && e.engineLimitations.length > 0
    ? `<p><b>Limitações medidas pelos motores:</b> ${e.engineLimitations.map((l) => esc(l)).join(" · ")}</p>`
    : "";
  const motivos = inconclusiveReasonsLabel(e.inconclusiveByReason);
  const nota = rotuloDeCobertura(e.status).nota;
  const notaCobertura = nota ? `<li><b>${esc(rotuloDeCobertura(e.status).label)}</b>: ${esc(nota)}</li>` : "";
  return `<!doctype html>
<html lang="pt-PT">
<head>
<meta charset="utf-8" />
<title>Histórico de análises — ${esc(dataHora(e.startedAt))}</title>
<style>
  @page { size: A4; margin: 14mm; }
  body { font-family: 'Segoe UI', system-ui, sans-serif; color: #102b39; margin: 0; padding: 18px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .meta { font-size: 12px; color: #4a646d; margin-bottom: 14px; }
  .estado { display: inline-block; font-size: 12px; font-weight: 700; text-transform: uppercase;
            letter-spacing: .04em; padding: 3px 8px; border: 1px solid currentColor; border-radius: 999px; }
  .ok { color: #166534; } .aviso { color: #9a4a06; } .crit { color: #b91c1c; }
  ul { font-size: 13px; line-height: 1.7; padding-left: 18px; }
  p { font-size: 13px; line-height: 1.6; }
  .footer { margin-top: 18px; font-size: 11px; color: #4a646d; border-top: 1px solid #cfdcdf; padding-top: 10px; }
</style>
</head>
<body>
  <h1>Histórico de análises — registo individual</h1>
  <div class="meta">${esc(escopoDe(e, usb))} · análise ${esc(TIPO_LABEL[e.type])}</div>
  <p><span class="estado ${e.status === "completed" ? "ok" : e.status === "failed" ? "crit" : "aviso"}">${esc(ESTADO_LABEL[e.status])}</span>${resultado.label ? ` <span class="estado aviso">${esc(resultado.label)}</span>` : ""}</p>
  <ul>
    <li><b>Início</b>: ${esc(dataHora(e.startedAt))}</li>
    <li><b>Fim</b>: ${esc(dataHora(e.endedAt))}</li>
    <li><b>Duração</b>: ${esc(formatDuration(e.durationMs))}</li>
    ${contagem("Considerados", e.filesConsidered)}
    ${contagem(rotuloDeCobertura(e.status).label, e.filesAnalyzed)}
    ${notaCobertura}
    ${contagem("Conclusivos", conclusiveHistoryCount(e))}
    ${contagem("Inconclusivos", e.filesInconclusive)}
    ${contagem("Excluídos", e.filesExcluded)}
    ${contagem("Falhados", e.filesFailed)}
    ${contagem("Ameaças encontradas", e.threatsFound)}
  </ul>
  ${limitacoes}
  ${motivos ? `<p><b>Motivos dos inconclusivos:</b> ${esc(motivos)}</p>` : ""}
  <p>Identificador do registo: ${esc(e.id)}</p>
  <div class="footer">
    <p>Este documento é o registo de UMA análise terminada. Não é auditoria formal e não afirma
       que o computador esteja protegido: «concluída» quer dizer que a análise chegou ao fim.</p>
    <p>«Excluídos» é a política de exclusões do motor — nenhum motor viu esses ficheiros.
       «Falhados» são ficheiros que não puderam ser analisados.</p>
    <p>«Inconclusivos» são ficheiros sem resultado conclusivo dos motores; quando a contagem não foi reportada, não se presume zero.</p>
  </div>
</body>
</html>`;
}

/** Nome de ficheiro a partir do id do registo: sem caminhos, sem separadores. */
function nomeDoRegisto(e: ScanHistoryEntry): string {
  const seguro = String(e.id ?? "").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40);
  return `cybersafe-analise-${seguro || "registo"}.pdf`;
}

type Fase = "a_consultar" | "pronto" | "sem_ligacao" | "sem_confirmacao" | "erro";

/**
 * UI-D2 — o que uma resposta de `getScanHistory` PROVA.
 *
 * `null`/`undefined` não é «não há análises»: é a bridge a devolver nada, porque
 * `desktop/src/preload.ts` resolve `Promise.resolve(null)` durante o
 * encerramento, ou porque não houve resposta. Um objeto sem `entries` também não
 * prova lista vazia — `ScanHistoryPage` exige `entries`, pelo que uma resposta
 * dessas não é uma página.
 *
 * Sem página confirmada não se escreve `entradas`: a lista anterior deixa de
 * estar coberta por esta leitura e passa a ir rotulada como tal.
 */
export function decidePaginaHistorico(pagina: unknown):
  | { confirmada: true; entradas: ScanHistoryEntry[]; cursor: string | null }
  | { confirmada: false } {
  if (!pagina || typeof pagina !== "object") return { confirmada: false };
  const obj = pagina as { entries?: unknown; nextCursor?: unknown };
  if (!Array.isArray(obj.entries)) return { confirmada: false };
  return {
    confirmada: true,
    entradas: obj.entries as ScanHistoryEntry[],
    cursor: typeof obj.nextCursor === "string" ? obj.nextCursor : null,
  };
}

export const HISTORICO_SEM_CONFIRMACAO_NOTE =
  "O serviço não devolveu nenhuma página de histórico nesta consulta (sem ligação confirmada, ou pedido cancelado pelo encerramento). Isto não quer dizer que não existam análises registadas.";
export const HISTORICO_FALHA_NOTE =
  "A leitura do histórico ao serviço falhou. Nada é afirmado sobre o que existe — use Recarregar para tentar de novo.";
export const HISTORICO_MAIS_SEM_CONFIRMACAO_NOTE =
  "O serviço não confirmou mais análises nesta página; a lista fica onde estava.";
export const HISTORICO_ULTIMA_LEITURA_NOTE =
  "As linhas em baixo vêm da última leitura confirmada; esta consulta não confirmou nada.";

/** Estado da gravação do PDF por registo. `canceled` não é erro: volta a inerte. */
type PdfEstado =
  | { tipo: "inerte" }
  | { tipo: "a_guardar" }
  | { tipo: "guardado"; caminho: string }
  | { tipo: "erro"; mensagem: string };

export interface ScanHistoryPanelProps {
  /** Id do scan que acabou de atingir estado terminal. Mudar isto refresca a
      lista. `null`/`undefined` = nada acabou de terminar. */
  sessaoTerminada?: string | null;
}

export function ScanHistoryPanel({ sessaoTerminada = null }: ScanHistoryPanelProps) {
  const [fase, setFase] = useState<Fase>("a_consultar");
  const [entradas, setEntradas] = useState<ScanHistoryEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [erroMais, setErroMais] = useState<string | null>(null);
  const [aCarregarMais, setACarregarMais] = useState(false);
  const [aberto, setAberto] = useState<string | null>(null);
  const [pdf, setPdf] = useState<Record<string, PdfEstado>>({});
  /**
   * Unidades USB detetadas — a ÚNICA prova que autoriza «USB (H:\)» num registo.
   * Sem bridge, sem leitura ou sem dispositivo correspondente, os rótulos ficam
   * como sempre estiveram: aqui não se adivinha.
   */
  const [usbDrives, setUsbDrives] = useState<UsbDeviceState[] | null>(null);
  const [modalConsolidadoAberto, setModalConsolidadoAberto] = useState(false);

  const consultar = useCallback(async (motivo: "inicial" | "terminal"): Promise<void> => {
    const api = window.electronAPI?.getScanHistory;
    if (typeof api !== "function") {
      setFase("sem_ligacao");
      return;
    }
    if (motivo === "inicial") setFase("a_consultar");
    setErro(null);
    try {
      // Sem `limit`: a página por omissão é decisão do serviço (20 por omissão,
      // 100 no teto), e a UI não passa por cima da retenção configurável dele.
      const pagina = await api();
      const decisao = decidePaginaHistorico(pagina);
      if (!decisao.confirmada) {
        // Nada de lista nova, nada de «sem análises»: não houve página.
        setFase("sem_confirmacao");
        return;
      }
      setEntradas(decisao.entradas);
      setCursor(decisao.cursor);
      setFase("pronto");
    } catch (e) {
      // A razão técnica vai para o registo; o ecrã diz o que o utilizador pode
      // fazer, nunca um `TypeError` interno em inglês.
      console.warn("[ScanHistory] leitura da página falhou", e);
      setErro(HISTORICO_FALHA_NOTE);
      setFase("erro");
    }
  }, []);

  useEffect(() => {
    void consultar("inicial");
  }, [consultar]);

  useEffect(() => {
    const api = window.electronAPI?.getUsbProtection;
    if (typeof api !== "function") return;
    let cancelado = false;
    void (async () => {
      try {
        const snapshot = await api();
        if (!cancelado && snapshot && Array.isArray(snapshot.devices)) setUsbDrives(snapshot.devices);
      } catch {
        // Sem leitura das unidades fica-se pelo rótulo de sempre; nada de supor.
      }
    })();
    return () => { cancelado = true; };
  }, []);

  /**
   * O refresco sozinho ao terminar. Não é polling nem temporizador: a mudança
   * de `sessaoTerminada` é o único gatilho, e o React só corre o efeito quando
   * o id muda — por isso um terminal repetido não volta a pedir nada.
   */
  useEffect(() => {
    if (!sessaoTerminada) return;
    void consultar("terminal");
  }, [sessaoTerminada, consultar]);

  async function carregarMais() {
    if (cursor === null || aCarregarMais) return;
    const api = window.electronAPI?.getScanHistory;
    if (typeof api !== "function") return;
    setACarregarMais(true);
    setErroMais(null);
    try {
      const mais = await api({ cursor });
      const decisao = decidePaginaHistorico(mais);
      if (!decisao.confirmada) {
        // Cursor intacto: a próxima tentativa pode usar a mesma página.
        setErroMais(HISTORICO_SEM_CONFIRMACAO_NOTE);
        return;
      }
      setEntradas((atual) => [...atual, ...decisao.entradas]);
      setCursor(decisao.cursor);
    } catch (e) {
      console.warn("[ScanHistory] página seguinte falhou", e);
      setErroMais(HISTORICO_FALHA_NOTE);
    } finally {
      setACarregarMais(false);
    }
  }

  async function guardarPdf(e: ScanHistoryEntry) {
    const api = window.electronAPI?.exportReportPdf;
    if (typeof api !== "function") {
      setPdf((p) => ({ ...p, [e.id]: { tipo: "erro", mensagem: "Esta janela não tem o guardador de PDF do CyberSafe." } }));
      return;
    }
    setPdf((p) => ({ ...p, [e.id]: { tipo: "a_guardar" } }));
    try {
      const result = await api(htmlDoRelatorio(e, usbDrives), nomeDoRegisto(e));
      if (result.canceled === true) {
        // Fechar o diálogo de gravação é uma resposta legítima: silêncio.
        setPdf((p) => ({ ...p, [e.id]: { tipo: "inerte" } }));
        return;
      }
      if (result.success && typeof result.path === "string" && result.path !== "") {
        setPdf((p) => ({ ...p, [e.id]: { tipo: "guardado", caminho: result.path as string } }));
        return;
      }
      setPdf((p) => ({
        ...p,
        [e.id]: {
          tipo: "erro",
          mensagem: result.error ?? "A gravação não devolveu caminho nem razão; não se pode afirmar que guardou.",
        },
      }));
    } catch (erroro) {
      setPdf((p) => ({
        ...p,
        [e.id]: { tipo: "erro", mensagem: erroro instanceof Error ? erroro.message : "A gravação do PDF falhou sem mensagem." },
      }));
    }
  }

  const total = entradas.length;
  /**
   * O registo da análise que acabou de terminar JÁ está na página lida?
   *
   * O serviço emite o evento terminal e grava o registo logo a seguir
   * (`scan-manager.ts`), por isso a primeira leitura do painel pode chegar
   * antes de a linha existir em disco. Quando isso acontece di-lo — em vez de
   * deixar a lista a parecer que a análise terminada não ficou registada.
   * Não é polling nem temporizador: a condição é derivada do que já foi lido.
   */
  const registoDoTerminalEmFalta =
    sessaoTerminada !== null && fase === "pronto" && !entradas.some((e) => e.id === sessaoTerminada);
  /**
   * A frase do registo que ainda não chegou — uma só cópia: serve a lista vazia
   * (onde substitui a mensagem de «não há análises», que neste instante seria
   * falsa) e a lista que já tem entradas mas não esta. Não afirma que a análise
   * não ficou registada: diz que esta leitura pode ter chegado primeiro e o que
   * fazer — voltar a ler.
   */
  const notaRegistoPendente =
    "A análise que acabou de terminar ainda não consta do registo lido ao serviço: " +
    "o motor grava-o ao fechar a análise e esta leitura pode ter chegado primeiro. " +
    "Usa «Recarregar» para voltar a ler — se continuar a não aparecer, não foi gravado.";

  return (
    <section aria-labelledby="historico-titulo" className="v2-history cyber-border rounded-xl p-5 space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <div>
          <h2 id="historico-titulo" className="font-mono font-semibold text-foreground">
            Análises anteriores
          </h2>
          <p className="row-note mt-1 max-w-[92ch]">
            O registo do que já terminou, lido ao serviço. Isto é arquivo, não é o estado atual da
            proteção: o que está a correr vê-se acima.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void consultar("inicial")}
          disabled={fase === "a_consultar"}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-semibold text-foreground transition-colors hover:bg-secondary/60 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {fase === "a_consultar"
            ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            : <ScanSearch className="h-3.5 w-3.5" aria-hidden />}
          Recarregar
        </button>
        <button
          type="button"
          onClick={() => setModalConsolidadoAberto(true)}
          disabled={entradas.length === 0}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-semibold text-foreground transition-colors hover:bg-secondary/60 disabled:cursor-not-allowed disabled:opacity-50"
          title="Gerar relatório consolidado com filtros e estatísticas"
        >
          <FileText className="h-3.5 w-3.5" aria-hidden />
          Relatório Consolidado
        </button>
      </div>

      {fase === "a_consultar" && (
        <div className="flex items-center gap-2" role="status" aria-live="polite">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden />
          <p className="row-note">A consultar o histórico ao serviço…</p>
        </div>
      )}

      {fase === "sem_ligacao" && (
        <div className="flex items-start gap-3" role="status">
          <span className="icon-tile icon-tile--warn" aria-hidden><AlertTriangle className="h-4 w-4" /></span>
          <p className="row-note">
            Esta janela não tem o bridge do histórico, por isso não se sabe se há análises
            registadas. Não se mostra lista vazia: ausência de leitura não é «sem análises».
          </p>
        </div>
      )}

      {fase === "sem_confirmacao" && (
        <div className="flex items-start gap-3" role="status">
          <span className="icon-tile icon-tile--warn" aria-hidden><AlertTriangle className="h-4 w-4" /></span>
          <p className="row-note">{HISTORICO_SEM_CONFIRMACAO_NOTE}</p>
        </div>
      )}

      {/* Sem página confirmada as linhas que ficam em ecrã não pertencem a esta
          consulta: dizemos isso em vez de as apresentar como atuais. */}
      {entradas.length > 0 && (fase === "sem_confirmacao" || fase === "erro") && (
        <p role="status" className="row-meta">{HISTORICO_ULTIMA_LEITURA_NOTE}</p>
      )}

      {fase === "erro" && (
        <div className="flex items-start gap-3" role="alert">
          <span className="icon-tile icon-tile--crit" aria-hidden><AlertTriangle className="h-4 w-4" /></span>
          <div className="min-w-0">
            <p className="row-title">O histórico não pôde ser lido</p>
            <p className="row-note mt-1">{erro}</p>
          </div>
        </div>
      )}

      {fase === "pronto" && total === 0 && (
        <div className="empty" role="status">
          {registoDoTerminalEmFalta ? (
            <p>{notaRegistoPendente}</p>
          ) : (
            <>
              <h2>Ainda não há análises registadas</h2>
              <p>O serviço respondeu à consulta e não devolveu nenhuma análise terminada; lança uma acima e ela aparece aqui quando chegar ao fim.</p>
            </>
          )}
        </div>
      )}

      {registoDoTerminalEmFalta && total > 0 && (
        <div className="flex items-start gap-3" role="status" aria-live="polite">
          <span className="icon-tile" aria-hidden><History className="h-4 w-4" /></span>
          <p className="row-note">{notaRegistoPendente}</p>
        </div>
      )}

      {entradas.length > 0 && (
        <div className="stat-card overflow-hidden">
          {/* Toolbar do lab (`styles.css:1350-1356`): a contagem é dita por
              palavra e diz o que é — registos CARREGADOS, não o total do
              serviço. Com cursor, afirma-se que há mais. O `.segmented` de
              filtro do lab não entra: filtrar só o carregado mentia sobre a
              contagem (ver test/v2-history-table.test.ts). */}
          <div className="table-toolbar">
            <span className="caption">
              {entradas.length} {entradas.length === 1 ? "registo carregado" : "registos carregados"}
              {cursor !== null ? " · o serviço indicou mais registos" : ""}
            </span>
          </div>
          <div className="table-scroll">
            <table className="history-table">
              <caption className="sr-only">Análises registadas pelo serviço</caption>
              <thead>
                <tr>
                  <th scope="col">Análise</th>
                  <th scope="col">Data</th>
                  <th scope="col">Ficheiros</th>
                  <th scope="col">Duração</th>
                  <th scope="col">Resultado</th>
                  <th scope="col">
                    <span className="sr-only">Detalhe</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {entradas.map((e) => {
                  const expandido = aberto === e.id;
                  const estado = pdf[e.id] ?? { tipo: "inerte" as const };
                  const resultado = describeScanHistoryOutcome(e.status, e.filesInconclusive);
                  // Campo opcional: um histórico gravado por um serviço antigo
                  // não o tem. O cast só alarga a forma — nada é inventado.
                  const inconclusivosMotivos = inconclusiveReasonsLabel(
                    (e as ScanHistoryEntry & { inconclusiveByReason?: InconclusiveCauseCount[] }).inconclusiveByReason,
                  );
                  const inconclusivosMotores = inconclusiveEnginesLabel(
                    (e as ScanHistoryEntry & { inconclusiveByEngine?: InconclusiveEngineCount[] }).inconclusiveByEngine,
                  );
                  return (
                    <Fragment key={e.id}>
                      <tr className="history-row" data-estado={e.status} data-parcial={resultado.partial ? "true" : "false"}>
                        {/* A coluna 1 diz NATUREZA e o que está em voo; o que foi
                            medido vive no chip. O texto leva o estado, por isso o
                            mosaico é decorativo para o leitor de ecrã. */}
                        <th scope="row" className="history-col-analise">
                          <span className={resultado.partial ? "icon-tile icon-tile--warn" : MOSAICO_ESTADO[e.status]} aria-hidden>
                            <History className="h-4 w-4" />
                          </span>
                          <strong>{TIPO_LABEL[e.type]}</strong>
                          <small>{escopoDe(e, usbDrives)}</small>
                        </th>

                        <td className="mono">{dataHora(e.startedAt)}</td>

                        <td className="mono">
                          <span>considerados {numero(e.filesConsidered) ?? "sem leitura"}</span>
                          <span>{rotuloDeCobertura(e.status).label.toLowerCase()} {numero(e.filesAnalyzed) ?? "sem leitura"}</span>
                          <span>inconclusivos {numero(e.filesInconclusive) ?? "sem leitura"}</span>
                          <span>excluídos {numero(e.filesExcluded) ?? "sem leitura"}</span>
                          <span>falhados {numero(e.filesFailed) ?? "sem leitura"}</span>
                          <span className={cn((numero(e.threatsFound) ?? 0) > 0 && "text-cyber-red")}>
                            ameaças {numero(e.threatsFound) ?? "sem leitura"}
                          </span>
                        </td>

                        <td className="mono">{formatDuration(e.durationMs)}</td>

                        <td>
                          <span className={ESTADO_CHIP[e.status]}>{ESTADO_LABEL[e.status]}</span>
                          {resultado.label && <span className="state-chip state-chip--na">{resultado.label}</span>}
                          {rotuloDeCobertura(e.status).nota && (
                            <small className="history-col-nota">{rotuloDeCobertura(e.status).nota}</small>
                          )}
                        </td>

                        <td className="history-col-acoes">
                          <button
                            type="button"
                            onClick={() => setAberto(expandido ? null : e.id)}
                            aria-expanded={expandido}
                            aria-label={`${expandido ? "Ocultar" : "Ver"} detalhes da análise de ${dataHora(e.startedAt)}`}
                            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-sm font-semibold text-foreground transition-colors hover:bg-secondary/60"
                          >
                            {expandido
                              ? <ChevronDown className="h-3.5 w-3.5" aria-hidden />
                              : <ChevronRight className="h-3.5 w-3.5" aria-hidden />}
                            Ver detalhes
                          </button>
                          <button
                            type="button"
                            onClick={() => void guardarPdf(e)}
                            disabled={!expandido || estado.tipo === "a_guardar"}
                            aria-label={`Exportar PDF da análise de ${dataHora(e.startedAt)}`}
                            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-sm font-semibold text-foreground transition-colors hover:bg-secondary/60 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {estado.tipo === "a_guardar"
                              ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                              : <Printer className="h-3.5 w-3.5" aria-hidden />}
                            {estado.tipo === "a_guardar" ? "A guardar…" : "Exportar PDF"}
                          </button>
                        </td>
                      </tr>

                      {expandido && (
                        <tr className="history-detalhe">
                          <td colSpan={6}>
                            <div className="evidence-line space-y-1">
                              <p>terminou {dataHora(e.endedAt)} · duração {formatDuration(e.durationMs)}</p>
                              <p>registo {esc(e.id)}</p>
                              {typeof e.filesAnalyzed === "number" && (
                                <p>
                                  conclusivos {conclusiveHistoryCount(e) ?? "sem leitura"}
                                  {" · "}inconclusivos {e.filesInconclusive ?? "sem leitura"}
                                  {" · "}excluídos {e.filesExcluded}
                                  {" · "}falhados {e.filesFailed}
                                </p>
                              )}
                              {inconclusivosMotivos && (
                                <p><b className="font-semibold">Motivos dos inconclusivos:</b> {inconclusivosMotivos}</p>
                              )}
                              {inconclusivosMotores && (
                                <p><b className="font-semibold">Motores com lacunas:</b> {inconclusivosMotores}</p>
                              )}
                              {/* O registo é uma análise inteira, com contadores
                                  agregados. Não atribui motores a ficheiros
                                  individuais — essa frente vive no cartão por
                                  ficheiro do Scanner, e aqui não se inventa. */}
                              <p className="text-muted-foreground">
                                Contadores desta análise no conjunto: o histórico não diz que motores viram cada ficheiro.
                              </p>
                              {/* Só existe se o serviço mediu e devolveu. Ausente não é
                                  substituído por «sem limitações». */}
                              {Array.isArray(e.engineLimitations) && e.engineLimitations.length > 0 && (
                                <p><b className="font-semibold">Limitações medidas:</b> {e.engineLimitations.join(" · ")}</p>
                              )}
                              {estado.tipo === "guardado" && (
                                <p className="text-cyber-green">PDF guardado em: {estado.caminho}</p>
                              )}
                              {estado.tipo === "erro" && (
                                <p className="text-cyber-red">{estado.mensagem}</p>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          {cursor !== null && (
            <div className="p-3 border-t border-border">
              <button
                type="button"
                onClick={() => void carregarMais()}
                disabled={aCarregarMais}
                className="inline-flex h-9 items-center gap-2 rounded-lg border border-border px-3.5 text-sm font-semibold text-foreground transition-colors hover:bg-secondary/60 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {aCarregarMais
                  ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  : <History className="h-4 w-4" aria-hidden />}
                {aCarregarMais ? "A carregar…" : "Carregar mais"}
              </button>
              {erroMais && (
                <p className="row-note mt-2 text-cyber-red" role="alert">
                  Não foi possível carregar mais: {erroMais}
                </p>
              )}
            </div>
          )}
        </div>
      )}
      <ConsolidatedReportModal
        entries={entradas}
        isOpen={modalConsolidadoAberto}
        onClose={() => setModalConsolidadoAberto(false)}
      />
    </section>
  );
}
