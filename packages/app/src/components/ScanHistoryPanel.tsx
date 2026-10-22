import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle, ChevronDown, ChevronRight, Download, History, Loader2, Printer, ScanSearch,
} from "lucide-react";
import type { ScanHistoryEntry, ScanHistoryPage, ScanType, UsbDeviceState } from "@cybersafe/shared-types";
import { cn } from "@/lib/utils";
import { describeScanHistoryOutcome, describeScanTarget, formatDuration } from "@/lib/scanHistoryReport";

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
function htmlDoRelatorio(e: ScanHistoryEntry, usb: readonly UsbDeviceState[] | null): string {
  const resultado = describeScanHistoryOutcome(e.status, e.filesInconclusive);
  const limitacoes = Array.isArray(e.engineLimitations) && e.engineLimitations.length > 0
    ? `<p><b>Limitações medidas pelos motores:</b> ${e.engineLimitations.map((l) => esc(l)).join(" · ")}</p>`
    : "";
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
    ${contagem("Inconclusivos", e.filesInconclusive)}
    ${contagem("Excluídos", e.filesExcluded)}
    ${contagem("Falhados", e.filesFailed)}
    ${contagem("Ameaças encontradas", e.threatsFound)}
  </ul>
  ${limitacoes}
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

type Fase = "a_consultar" | "pronto" | "sem_ligacao" | "erro";

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
      const pagina: ScanHistoryPage = await api();
      setEntradas(pagina.entries ?? []);
      setCursor(pagina.nextCursor ?? null);
      setFase("pronto");
    } catch (e) {
      setErro(e instanceof Error ? e.message : "O serviço não devolveu o histórico.");
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
      const mais: ScanHistoryPage = await api({ cursor });
      setEntradas((atual) => [...atual, ...(mais.entries ?? [])]);
      setCursor(mais.nextCursor ?? null);
    } catch (e) {
      setErroMais(e instanceof Error ? e.message : "O serviço não devolveu mais análises.");
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
    <section aria-labelledby="historico-titulo" className="cyber-border rounded-xl p-5 space-y-4">
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
        <div className="flex items-start gap-3" role="status">
          <span className="icon-tile" aria-hidden><History className="h-4 w-4" /></span>
          <p className="row-note">
            {registoDoTerminalEmFalta
              ? notaRegistoPendente
              : "Ainda não há análises registadas. O serviço respondeu à consulta e não devolveu nenhuma análise terminada; lança uma acima e ela aparece aqui quando chegar ao fim."}
          </p>
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
          <div className="row-list">
            {entradas.map((e) => {
              const expandido = aberto === e.id;
              const estado = pdf[e.id] ?? { tipo: "inerte" as const };
              const resultado = describeScanHistoryOutcome(e.status, e.filesInconclusive);
              return (
                <article key={e.id} className="row-item">
                  <span className={resultado.partial ? "icon-tile icon-tile--warn" : MOSAICO_ESTADO[e.status]} aria-hidden>
                    <History className="h-4 w-4" />
                  </span>

                  <div className="min-w-0 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <h3 className="row-title">{dataHora(e.startedAt)}</h3>
                      <span className={ESTADO_CHIP[e.status]}>{ESTADO_LABEL[e.status]}</span>
                      {resultado.label && <span className="state-chip state-chip--na">{resultado.label}</span>}
                      <span className="row-meta">
                        {TIPO_LABEL[e.type]} · {escopoDe(e, usbDrives)} · {formatDuration(e.durationMs)}
                      </span>
                    </div>

                    <div className="flex flex-wrap gap-x-4 gap-y-1">
                      <span className="row-meta tabular-nums">considerados {numero(e.filesConsidered) ?? "sem leitura"}</span>
                      <span className="row-meta tabular-nums">{rotuloDeCobertura(e.status).label.toLowerCase()} {numero(e.filesAnalyzed) ?? "sem leitura"}</span>
                      {rotuloDeCobertura(e.status).nota && (
                        <span className="row-meta">{rotuloDeCobertura(e.status).nota}</span>
                      )}
                      <span className="row-meta tabular-nums">inconclusivos {numero(e.filesInconclusive) ?? "sem leitura"}</span>
                      <span className="row-meta tabular-nums">excluídos {numero(e.filesExcluded) ?? "sem leitura"}</span>
                      <span className="row-meta tabular-nums">falhados {numero(e.filesFailed) ?? "sem leitura"}</span>
                      <span
                        className={cn(
                          "row-meta tabular-nums",
                          (numero(e.threatsFound) ?? 0) > 0 ? "text-cyber-red" : "text-muted-foreground",
                        )}
                      >
                        ameaças {numero(e.threatsFound) ?? "sem leitura"}
                      </span>
                    </div>

                    {expandido && (
                      <div className="evidence-line space-y-1">
                        <p>terminou {dataHora(e.endedAt)} · duração {formatDuration(e.durationMs)}</p>
                        <p>registo {esc(e.id)}</p>
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
                    )}
                  </div>

                  <div className="row-act flex shrink-0 flex-col items-end gap-1.5">
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
                    {estado.tipo === "guardado" && (
                      <span className="row-meta text-cyber-green break-all max-w-[24ch] text-right">
                        <Download className="inline h-3 w-3 mr-1" aria-hidden />
                        {estado.caminho}
                      </span>
                    )}
                  </div>
                </article>
              );
            })}
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
    </section>
  );
}
