import { useEffect, useMemo, useRef, useState } from "react";
import type { QuarantineEntry } from "@cybersafe/shared-types";
import { AlertCircle, Archive, RotateCcw, Trash2, ChevronDown, ChevronRight, CheckCircle2, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { quarantinePolicyLabel, type QuarantinePolicyTone } from "@/lib/quarantineDisplay";
import { decidirResumoLote, decidirTipoResumoLote, textoResumoLote } from "@/lib/quarantineBatch";

/**
 * O que a LEITURA da lista confirmou, dito por quem a foi buscar ao serviço.
 * `confirmado` = o serviço respondeu a esta consulta; `a_ler` = consulta em
 * curso; `falhou` = a consulta não respondeu e o que está em ecrã vem da
 * última leitura confirmada (ou de nenhuma).
 */
export type EstadoLeituraQuarentena = "confirmado" | "a_ler" | "falhou";

interface QuarantinePageProps {
  entries: QuarantineEntry[];
  /** Recarrega a lista a partir do serviço depois de uma ação confirmada. */
  onChanged: () => void | Promise<void>;
  /**
   * Politica EFETIVA de quarentena reportada pelo servico
   * (ProtectionStats.quarantinePolicy, P0-3). Sem valor = "desconhecido".
   */
  quarantinePolicy?: unknown;
  /**
   * Dentro da aba Quarentena de Ameaças: o cabeçalho de página e o padding
   * pertencem ao contentor-pai, aqui só interessa a lista e os seus estados.
   */
  embedded?: boolean;
  /**
   * Estado da leitura da lista. Omitido = comportamento histórico (a lista que
   * chega é tratada como confirmada). Com `falhou` ou `a_ler` a página nunca
   * pode dizer «a quarentena está vazia»: ausência de leitura não é uma
   * asserção sobre o contentor.
   */
  estadoLeitura?: EstadoLeituraQuarentena;
}

/**
 * DECISÃO (UI-D3): «vazio» só se afirma com leitura confirmada. Sem leitura, o
 * que se mostra é a ausência de leitura; com entradas em ecrã a lista continua
 * a ser factos lidos, mas rotulada como última leitura confirmada.
 */
export function decideEstadoLista(
  estadoLeitura: EstadoLeituraQuarentena | undefined,
  total: number,
): { afirmaVazia: boolean; banner: "a_ler" | "falhou" | null; rotuloLista: string | null } {
  const leitura = estadoLeitura ?? "confirmado";
  if (leitura === "a_ler") {
    return {
      afirmaVazia: false,
      banner: "a_ler",
      rotuloLista: total > 0 ? "Última leitura confirmada — a consulta atual ainda não respondeu." : null,
    };
  }
  if (leitura === "falhou") {
    return {
      afirmaVazia: false,
      banner: "falhou",
      rotuloLista: total > 0 ? "Última leitura confirmada — esta consulta não respondeu." : null,
    };
  }
  return { afirmaVazia: total === 0, banner: null, rotuloLista: null };
}

export const QUARENTENA_LER_NOTE = "A consultar a quarentena ao serviço…";
export const QUARENTENA_FALHA_NOTE =
  "Não foi possível ler a quarentena ao serviço. Não afirmamos que esteja vazia: o que aqui aparece vem da última leitura confirmada.";
export const QUARENTENA_TENTAR_NOVAMENTE = "Tentar novamente";
/**
 * Exceção do pedido (sem resposta do serviço): não afirmamos o que aconteceu ao
 * ficheiro, afirmamos que a operação não está confirmada.
 */
export const QUARENTENA_SEM_CONFIRMACAO_NOTE =
  "Falha de comunicação com o serviço: esta operação não foi confirmada. Confirme a lista antes de repetir.";

/**
 * P1-RETOQUE (28/10) — `success: true` pode vir ACOMPANHADO de `error`.
 *
 * Não é contradição: em `packages/core/src/response.ts` o restauro que publicou
 * o destino mas falhou na limpeza devolve
 * `{ success: true, error: "Ficheiro restaurado; limpeza, permissoes ou
 *     metadados pendentes. Entrada preservada para recuperacao. <motivo>" }`
 * e o serviço preserva essa string. Ignorar `error` no ramo de sucesso era
 * esconder que ficou trabalho pendurado (entrada preservada, permissões por
 * repor). Tratar o mesmo como falha era negar que o ficheiro foi restaurado.
 */
export type ResultadoAcaoQuarentena =
  | { tipo: "confirmado" }
  | { tipo: "confirmado_com_aviso"; aviso: string }
  | { tipo: "recusado"; motivo: string }
  | { tipo: "sem_confirmacao" };

export function decideResultadoAcao(
  result: { success?: boolean; error?: string } | null | undefined,
): ResultadoAcaoQuarentena {
  if (result === null || result === undefined) return { tipo: "sem_confirmacao" };
  const aviso = typeof result.error === "string" ? result.error.trim() : "";
  if (result.success === true) {
    return aviso ? { tipo: "confirmado_com_aviso", aviso } : { tipo: "confirmado" };
  }
  return { tipo: "recusado", motivo: aviso || "O serviço não confirmou a operação." };
}

/** Rótulo do aviso persistente; o texto do serviço vem a seguir, como foi dito. */
export const QUARENTENA_AVISO_PREFIXO = "Ação confirmada, com aviso do serviço:";

/**
 * V4 — os quatro resultados de uma ação vivem num só portador, FORA da linha da
 * entrada.
 *
 * A razão é medida, não estética: restaurar e eliminar tiram a entrada da lista
 * no recarregamento seguinte. Com `okId`/`error` presos à linha, o utilizador
 * perdia exatamente a frase que o serviço lhe deu — inclusive "esta operação não
 * foi confirmada", que é a única coisa que impede repetir o gesto às cegas.
 *
 * Os quatro estados mantêm-se distintos (rótulo, tinta e `role` diferentes); o
 * que deixa de existir é a duplicação entre linha e página.
 */
export type TipoBandeira = ResultadoAcaoQuarentena["tipo"];

export type BandeiraResultado = {
  id: string;
  fileName: string;
  tipo: TipoBandeira;
  mensagem: string;
};

export const ROTULO_BANDEIRA: Record<TipoBandeira, string> = {
  confirmado: "Operação confirmada pelo serviço:",
  confirmado_com_aviso: QUARENTENA_AVISO_PREFIXO,
  recusado: "O serviço recusou a operação:",
  sem_confirmacao: "Sem confirmação do serviço:",
};

/** `alert` só para o que corre mal; `status` para o que se concluiu. */
export const PAPEL_BANDEIRA: Record<TipoBandeira, "status" | "alert"> = {
  confirmado: "status",
  confirmado_com_aviso: "alert",
  recusado: "alert",
  sem_confirmacao: "alert",
};

export function decideBandeira(
  entry: { id: string; fileName: string },
  decisao: ResultadoAcaoQuarentena,
): BandeiraResultado {
  switch (decisao.tipo) {
    case "confirmado":
      return { id: entry.id, fileName: entry.fileName, tipo: "confirmado", mensagem: "" };
    case "confirmado_com_aviso":
      return { id: entry.id, fileName: entry.fileName, tipo: "confirmado_com_aviso", mensagem: decisao.aviso };
    case "recusado":
      return { id: entry.id, fileName: entry.fileName, tipo: "recusado", mensagem: decisao.motivo };
    case "sem_confirmacao":
      return { id: entry.id, fileName: entry.fileName, tipo: "sem_confirmacao", mensagem: QUARENTENA_SEM_CONFIRMACAO_NOTE };
  }
}

export const QUARENTENA_ATUALIZAR = "Atualizar";
export const QUARENTENA_ATUALIZAR_ARIA = "Atualizar a lista de quarentena a partir do serviço";
/**
 * Recuperação tem de ser DITA. Se a lista simplesmente voltar a aparecer sem
 * aviso, o utilizador não tem forma de saber que a falha anterior se resolveu —
 * e "desapareceu o erro" não é a mesma coisa que "a leitura voltou".
 */
export const QUARENTENA_RECUPERADA_NOTE =
  "Ligação recuperada: esta lista vem da leitura atual, não da anterior.";

/**
 * V4 — só há recuperação na transição `falhou → confirmado`. Uma lista que nunca
 * falhou não "recuperou" nada; e `a_ler → confirmado` também não é recuperação,
 * é a primeira leitura normal.
 */
export function decideRecuperacao(
  anterior: EstadoLeituraQuarentena | undefined,
  atual: EstadoLeituraQuarentena | undefined,
): boolean {
  return anterior === "falhou" && atual === "confirmado";
}

type Pending = { id: string; action: "restore" | "delete" } | null;

const VERDICT_LABEL: Record<string, string> = {
  malicious: "Malicioso",
  suspicious: "Suspeito",
  safe: "Seguro",
  unknown: "Desconhecido",
};

/* O veredicto entra no vocabulario medido do design system (chip = FORMA +
   texto + cor) em vez de tres classes inventadas aqui. `unknown` usa a variante
   `--na` (argola vazia) porque um veredicto que o servico nao deu nao e uma
   medicao; `suspicious` e AVISO, nao criterio — pintar de vermelho o que ainda
   e suspeita era escalar sem prova. */
const VERDICT_CHIP: Record<string, string> = {
  malicious: "state-chip state-chip--crit",
  suspicious: "state-chip state-chip--warn",
  safe: "state-chip state-chip--ok",
  unknown: "state-chip state-chip--na",
};

const VERDICT_TILE: Record<string, string> = {
  malicious: "icon-tile icon-tile--crit",
  suspicious: "icon-tile icon-tile--warn",
  safe: "icon-tile icon-tile--ok",
  unknown: "icon-tile",
};

/* Tinta da linha de politica. O texto ja diz o estado, por isso a cor e
   reforco e nao o sinal: `unknown` fica discreto (ausencia de leitura nao e
   avaria), `off` usa o amarelo de atencao (protecao reduzida, facto reportado),
   `auto` usa o verde do que esta ligado. O codigo anterior pintava de amarelo o
   estado BOM e deixava OFF/DESCONHECIDO a cinzento — ao contrario. */
const POLITICA_TINTA: Record<QuarantinePolicyTone, string> = {
  auto: "text-cyber-green",
  ask: "text-foreground",
  off: "text-cyber-yellow",
  unknown: "text-muted-foreground",
};

const BOTAO_BASE =
  "inline-flex h-8 min-w-0 shrink-0 items-center justify-center gap-1.5 rounded-lg border px-3 text-sm font-semibold whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50";
const BOTAO_NEUTRO = cn(BOTAO_BASE, "border-border text-foreground hover:bg-secondary/60");
const BOTAO_LIGADO = cn(BOTAO_BASE, "border-primary text-primary hover:text-primary");
/* Fundo destrutivo com o PAR de primeiro plano pensado para ele
   (`--destructive` + `--destructive-foreground`, o mesmo de ExitConfirmDialog).
   O texto antigo usava `bg-cyber-red` com `text-primary-foreground`; como
   `--color-cyber-red` esta mapeado para a variante de TEXTO (`--cyber-red-text`,
   aclarada para ler sobre fundo escuro), aquilo era tinta clara sobre vermelho
   claro. */
const BOTAO_DESTRUTIVO = cn(BOTAO_BASE, "border-destructive/60 bg-destructive text-destructive-foreground hover:bg-destructive/90");

/**
 * Tinta por estado de ação. Quatro estados, quatro leituras visuais diferentes:
 * confirmado é verde; confirmado-com-aviso é amarelo (fez-se, falta algo);
 * recusa e sem-confirmação são destrutivos mas distinguem-se pelo rótulo e pelo
 * texto — um disse «não», o outro não disse nada.
 */
const BANDEIRA_TINTA: Record<TipoBandeira, string> = {
  confirmado: "border-cyber-green/40 bg-cyber-green/10 text-cyber-green",
  confirmado_com_aviso: "border-cyber-yellow/40 bg-cyber-yellow/10 text-foreground",
  recusado: "border-destructive/40 bg-destructive/10 text-destructive",
  sem_confirmacao: "border-destructive/40 bg-destructive/10 text-destructive",
};

/** `id` e `aria-controls` precisam de um nome de elemento, nao do
 *  identificador opaco do manifesto (que pode conter `:`, espacos ou barras). */
function nomeDom(id: string): string {
  return `quar-${id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function formatDate(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("pt-PT");
}

/**
 * RECOVERY-SECURITY-20261014: `isolationStatus` vem do QuarantineManager e
 * so vale `confirmed` depois de destino/digest/manifest verificados. A UI
 * nao pode escrever "em quarentena desde" ao que nao esta confirmado —
 * `recovery-required` e o legado sem estado dizem-no explicitamente.
 */
function isolationLine(entry: QuarantineEntry): { text: string; warn: boolean } {
  if (entry.isolationStatus === "recovery-required") {
    return { text: "Isolamento não confirmado; recuperação necessária", warn: true };
  }
  if (entry.isolationStatus === undefined) {
    return { text: "Registo anterior; isolamento não verificado nesta versão", warn: false };
  }
  return { text: `em quarentena desde ${formatDate(entry.quarantinedAt)}`, warn: false };
}

/**
 * Gestão real da Quarentena.
 *
 * Uma decisão, uma confirmação: restaurar e eliminar são irreversíveis o
 * suficiente para nunca acontecerem num clique só. A linha só desaparece da
 * lista depois de o BACKEND confirmar (`success: true`); se o backend recusar
 * (destino ocupado, ficheiro ausente, sem permissão) a razão real é mostrada e
 * a entrada fica onde está.
 *
 * Vocabulário visual: `row-list`/`row-item` (uma aresta por linha em vez de N
 * cartões idênticos), `icon-tile` (natureza), `state-chip` (o que foi medido),
 * `evidence-line` (degrau rebaixado para caminhos e digest), `page-shell`
 * (ritmo de página). Sem material, spotlight ou WebGL: a proposta do Design
 * Lab V2 exclui explicitamente efeitos de tabelas, relatórios e texto crítico.
 */
export default function QuarantinePage({ entries, onChanged, embedded = false, quarantinePolicy, estadoLeitura }: QuarantinePageProps) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  /**
   * V4: resultado da última ação (confirmada, confirmada com aviso, recusada,
   * sem confirmação). Persistentemente fora da linha — ver `decideBandeira`.
   */
  const [bandeira, setBandeira] = useState<BandeiraResultado | null>(null);
  /** Recarga pedida pela própria página (botão «Atualizar»), em curso ou não. */
  const [aRecarregar, setARecarregar] = useState(false);
  const [selecionados, setSelecionados] = useState<Set<string>>(() => new Set());
  const [lote, setLote] = useState<{ acao: "restore" | "delete" } | null>(null);
  const [aLote, setALote] = useState(false);
  const [resumoLote, setResumoLote] = useState<{ tipo: TipoBandeira; texto: string } | null>(null);
  const [recuperada, setRecuperada] = useState(false);
  const leituraAnteriorRef = useRef<EstadoLeituraQuarentena | undefined>(undefined);

  // Só se considera recuperação a transição Falhou → Confirmado. Uma lista que
  // nunca falhou não "recuperou" nada, e dizê-lo seria inventar um evento.
  useEffect(() => {
    const anterior = leituraAnteriorRef.current;
    leituraAnteriorRef.current = estadoLeitura;
    if (decideRecuperacao(anterior, estadoLeitura)) setRecuperada(true);
    else if (estadoLeitura === "falhou") setRecuperada(false);
  }, [estadoLeitura]);

  const recarregar = async () => {
    if (aRecarregar) return;
    setARecarregar(true);
    try {
      // `onChanged` é o `fetchSnapshot` do contentor: quem decide o estado da
      // leitura é o contentor. Aqui só se espera por ele para libertar o botão.
      await onChanged();
    } finally {
      setARecarregar(false);
    }
  };

  const sorted = useMemo(
    () => [...entries].sort((a, b) => (a.quarantinedAt < b.quarantinedAt ? 1 : -1)),
    [entries],
  );

  // Selecao podada: um id que saiu da lista nao pode ser contado como recusa.
  useEffect(() => {
    setSelecionados((antes) => {
      if (antes.size === 0) return antes;
      const vivos = new Set(entries.map((x) => x.id));
      const agora = new Set([...antes].filter((id) => vivos.has(id)));
      return agora.size === antes.size ? antes : agora;
    });
  }, [entries]);

  const alternarSelecao = (id: string) => {
    setSelecionados((antes) => {
      const agora = new Set(antes);
      if (agora.has(id)) agora.delete(id);
      else agora.add(id);
      return agora;
    });
  };

  // Uma chamada por ficheiro: o resultado e o do servico, nao uma impressao do
  // lote. Uma quebra de comunicacao interrompe e conta os restantes como nao
  // tentados, em vez de repetir as cegas sobre um servico que nao responde.
  const runLote = async (acao: "restore" | "delete") => {
    const alvos = sorted.filter((x) => selecionados.has(x.id));
    setLote(null);
    setResumoLote(null);
    const api = window.electronAPI;
    if (!api) {
      setResumoLote({ tipo: "sem_confirmacao", texto: "Sem ligacao ao servico de quarentena nesta janela; nada foi tentado." });
      return;
    }
    if (alvos.length === 0) return;
    setALote(true);
    const resultados: { tipo: "confirmado" | "confirmado_com_aviso" | "recusado" | "sem_confirmacao" }[] = [];
    try {
      for (const x of alvos) {
        try {
          const r = acao === "restore" ? await api.restoreQuarantine(x.id) : await api.deleteQuarantine(x.id);
          resultados.push(decideResultadoAcao(r));
        } catch (err) {
          console.warn("[Quarantine] lote interrompido: o servico nao confirmou", err);
          resultados.push({ tipo: "sem_confirmacao" });
          break;
        }
      }
    } finally {
      const resumo = decidirResumoLote(resultados, alvos.length);
      setResumoLote({ tipo: decidirTipoResumoLote(resumo), texto: textoResumoLote(resumo, acao) });
      setSelecionados(new Set());
      setALote(false);
      await onChanged();
    }
  };
  const run = async (entry: QuarantineEntry, action: "restore" | "delete") => {
    const api = window.electronAPI;
    setPending(null);
    setBandeira(null);
    if (!api) {
      setBandeira({ id: entry.id, fileName: entry.fileName, tipo: "sem_confirmacao", mensagem: "Sem ligação ao serviço de quarentena nesta janela." });
      return;
    }
    setBusyId(entry.id);
    try {
      const result =
        action === "restore"
          ? await api.restoreQuarantine(entry.id)
          : await api.deleteQuarantine(entry.id);
      // Os quatro desfechos são distintos e todos ficam na bandeira persistente.
      setBandeira(decideBandeira(entry, decideResultadoAcao(result)));
      await onChanged();
    } catch (err) {
      // UI-D2 (mesma classe): o `Error` que o `service-client` lança é texto
      // técnico ("Service client disconnected"), não frase para o utilizador.
      // O motivo vai para o registo; o ecrã diz o que se pode concluir — que
      // esta operação não foi confirmada, não que o ficheiro está intacto.
      console.warn("[Quarantine] ação não chegou ao serviço", err);
      setBandeira(decideBandeira(entry, { tipo: "sem_confirmacao" }));
    } finally {
      setBusyId(null);
    }
  };

  const total = entries.length;
  const lista = decideEstadoLista(estadoLeitura, total);
  const politica = quarantinePolicyLabel(quarantinePolicy);
  // O resumo conta POR ESTADO: chamar "isolados" a tudo era a mentira do
  // cabeçalho (RECOVERY-SECURITY-20261014).
  const counts = useMemo(
    () => ({
      confirmed: entries.filter((e) => e.isolationStatus === "confirmed").length,
      recovery: entries.filter((e) => e.isolationStatus === "recovery-required").length,
      legacy: entries.filter((e) => e.isolationStatus === undefined).length,
    }),
    [entries],
  );

  // Cada entrada tem exatamente um destes estados, por isso com a lista cheia
  // aparece sempre pelo menos uma chapa. Os zeros não entram: duas chapas a
  // dizer «zero» são ruído à frente do número que interessa.
  const chapas =
    total === 0 ? null : (
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        {counts.confirmed > 0 && (
          <span className="state-chip state-chip--ok">
            {counts.confirmed} {counts.confirmed === 1 ? "confirmado" : "confirmados"}
          </span>
        )}
        {counts.recovery > 0 && <span className="state-chip state-chip--warn">{counts.recovery} a recuperar</span>}
        {counts.legacy > 0 && <span className="state-chip state-chip--na">{counts.legacy} por verificar</span>}
      </div>
    );

  // V4: «Atualizar» existe sempre, com lista vazia, cheia ou falhada. Antes, a
  // única forma de repetir a leitura era o botão do banner de falha — ou seja,
  // era preciso que a leitura já tivesse falhado para haver forma de a repetir.
  // Um só botão, com o rótulo do que se pode fazer agora: repetir uma leitura que
  // falhou diz-se «Tentar novamente»; manter uma lista ao dia diz-se «Atualizar».
  const falhouLeitura = estadoLeitura === "falhou";
  const ferramentas = (
    <div className="flex flex-wrap items-center justify-end gap-1.5">
      {chapas}
      {selecionados.size > 0 && (
        <>
          <span className="row-meta">{selecionados.size} selecionado{selecionados.size === 1 ? "" : "s"}</span>
          <button type="button" disabled={aLote || busyId !== null} onClick={() => { setBandeira(null); setResumoLote(null); setLote({ acao: "restore" }); }} className={BOTAO_NEUTRO}>Restaurar selecionados</button>
          <button type="button" disabled={aLote || busyId !== null} onClick={() => { setBandeira(null); setResumoLote(null); setLote({ acao: "delete" }); }} className={BOTAO_DESTRUTIVO}>Eliminar selecionados</button>
          <button type="button" disabled={aLote} onClick={() => setSelecionados(new Set())} className={BOTAO_NEUTRO}>Limpar selecao</button>
        </>
      )}
      <button
        type="button"
        onClick={() => void recarregar()}
        disabled={aRecarregar || estadoLeitura === "a_ler" || busyId !== null}
        className={falhouLeitura ? BOTAO_LIGADO : BOTAO_NEUTRO}
        aria-label={QUARENTENA_ATUALIZAR_ARIA}
      >
        {aRecarregar || estadoLeitura === "a_ler" ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        ) : (
          <RotateCcw className="h-3.5 w-3.5" aria-hidden />
        )}
        {falhouLeitura ? QUARENTENA_TENTAR_NOVAMENTE : QUARENTENA_ATUALIZAR}
      </button>
    </div>
  );

  return (
    <div className={cn(embedded ? "v2-quarantine flex flex-col gap-4" : "v2-quarantine page-shell mx-auto max-w-5xl")}>
      {/* P0-3 (15/10): o estado REAL da politica de quarentena, dito pelo
          servico — visivel antes de qualquer lista. */}
      <p role="status" className={cn("row-note", POLITICA_TINTA[politica.tone])}>
        {politica.text}
      </p>

      {/* V4: o resultado da ação é persistente e vive FORA da linha. Restaurar e
          eliminar tiram a entrada da lista no recarregamento; a frase do serviço
          tem de continuar a ser legível depois disso. */}
      {bandeira && (
        <div
          role={PAPEL_BANDEIRA[bandeira.tipo]}
          aria-live={PAPEL_BANDEIRA[bandeira.tipo] === "alert" ? "assertive" : "polite"}
          data-tipo={bandeira.tipo}
          className={cn(
            "flex flex-wrap items-start justify-between gap-3 rounded-lg border p-2.5",
            BANDEIRA_TINTA[bandeira.tipo],
          )}
        >
          <p className="row-note min-w-0 flex-1">
            {bandeira.tipo === "confirmado" ? (
              <CheckCircle2 className="mr-1.5 inline h-4 w-4" aria-hidden />
            ) : (
              <AlertCircle className="mr-1.5 inline h-4 w-4" aria-hidden />
            )}
            <span className="font-semibold">{ROTULO_BANDEIRA[bandeira.tipo]}</span> {bandeira.fileName}
            {bandeira.mensagem ? ` — ${bandeira.mensagem}` : ""}
          </p>
          <button
            type="button"
            onClick={() => setBandeira(null)}
            className={BOTAO_NEUTRO}
            aria-label={`Fechar o resultado da operação sobre ${bandeira.fileName}`}
          >
            Fechar
          </button>
        </div>
      )}

      {recuperada && (
        <div role="status" aria-live="polite" className="flex flex-wrap items-center justify-between gap-2">
          <p className="row-note min-w-0 flex-1 text-cyber-green">{QUARENTENA_RECUPERADA_NOTE}</p>
          <button
            type="button"
            onClick={() => setRecuperada(false)}
            className={BOTAO_NEUTRO}
            aria-label="Fechar a nota de ligação recuperada"
          >
            Entendido
          </button>
        </div>
      )}

      {embedded ? (
        ferramentas
      ) : (
        <header className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <span className="icon-tile" aria-hidden>
              <Archive className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <h1 className="row-title text-base">Quarentena</h1>
              <p className="row-note">
                Registos da quarentena. O isolamento só é afirmado quando confirmado; restaurar ou eliminar é permanente.
              </p>
            </div>
          </div>
          {ferramentas}
        </header>
      )}

      {/* UI-D3 + V4: a leitura manda antes da lista. Sem leitura confirmada não
          há asserção de vacuidade, e o que fica em ecrã é rotulado como vindo da
          última leitura confirmada. A repetição é um só botão (cabeçalho), com o
          rótulo «Tentar novamente» quando foi isto que falhou. */}
      {lista.banner && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p
            role={lista.banner === "falhou" ? "alert" : "status"}
            className={cn(
              "row-note min-w-0 flex-1",
              lista.banner === "falhou" ? "text-cyber-yellow" : "text-muted-foreground",
            )}
          >
            {lista.banner === "falhou" ? QUARENTENA_FALHA_NOTE : QUARENTENA_LER_NOTE}
          </p>
        </div>
      )}
      {lista.rotuloLista && (
        <p role="status" className="row-meta">{lista.rotuloLista}</p>
      )}

      {resumoLote && (
        <div role={PAPEL_BANDEIRA[resumoLote.tipo]} data-tipo={resumoLote.tipo} className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border p-2.5">
          <p className="row-note min-w-0 flex-1">{resumoLote.texto}</p>
          <button type="button" onClick={() => setResumoLote(null)} className={BOTAO_NEUTRO}>Fechar</button>
        </div>
      )}

      {lote && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-secondary/30 p-2.5">
          <p role="alert" className="row-note min-w-0 flex-1 text-foreground">
            {lote.acao === "delete"
              ? "Eliminar permanentemente " + selecionados.size + (selecionados.size === 1 ? " ficheiro" : " ficheiros") + "? Esta acao e irreversivel."
              : "Restaurar " + selecionados.size + (selecionados.size === 1 ? " ficheiro" : " ficheiros") + " para os locais originais?"}
          </p>
          <div className="flex shrink-0 items-center gap-1.5">
            <button type="button" onClick={() => setLote(null)} className={BOTAO_NEUTRO}>Cancelar</button>
            <button type="button" onClick={() => void runLote(lote.acao)} className={lote.acao === "delete" ? BOTAO_DESTRUTIVO : BOTAO_LIGADO}>{lote.acao === "delete" ? "Eliminar" : "Restaurar"}</button>
          </div>
        </div>
      )}

      {aLote && (
        <p role="status" className="row-meta flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> A comunicar o lote ao servico, um ficheiro de cada vez...</p>
      )}
      {lista.afirmaVazia ? (
        <div className="stat-card p-10 text-center">
          <span className="icon-tile mx-auto" aria-hidden>
            <Archive className="h-4 w-4" />
          </span>
          <p className="row-note mt-3">A quarentena está vazia.</p>
          <p className="row-meta mt-1">Os ficheiros removidos por uma deteção aparecem aqui.</p>
        </div>
      ) : total > 0 ? (
        <div className="stat-card overflow-hidden">
          <ul className="row-list">
            {sorted.map((entry) => {
              const verdictLabel = VERDICT_LABEL[entry.verdict] ?? entry.verdict;
              const isolation = isolationLine(entry);
              const emCurso = busyId === entry.id;
              const expandido = expanded === entry.id;
              const idDetalhes = `${nomeDom(entry.id)}-detalhes`;
              const idTitulo = `${nomeDom(entry.id)}-titulo`;
              const aConfirmar = pending?.id === entry.id ? pending.action : null;

              return (
                <li key={entry.id} className={cn("row-item quarantine-item", isolation.warn && "border-l-2 border-l-cyber-yellow")}>
                  {/* Q2 (decisão A): o `<li>` é invólucro; a LINHA é o flex do
                      lab, e os detalhes/confirmação/curso são IRMÃOS dessa
                      linha, não colunas de uma grelha de três. */}
                  <div className="quarantine-row">
                  {/* A coluna 1 diz NATUREZA e o que está em voo; o que foi
                      medido vive no chip. O texto leva o estado, por isso o
                      mosaico é decorativo para o leitor de ecrã. */}
                  <span
                    className={emCurso ? "icon-tile icon-tile--proc" : VERDICT_TILE[entry.verdict] ?? "icon-tile"}
                    aria-hidden
                  >
                    {emCurso ? <Loader2 className="h-4 w-4 animate-spin" /> : <Archive className="h-4 w-4" />}
                  </span>

                  <div className="quarantine-col min-w-0 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <h3 className="row-title truncate" id={idTitulo} title={entry.fileName}>
                        {entry.fileName}
                      </h3>
                      <span className={VERDICT_CHIP[entry.verdict] ?? "state-chip state-chip--na"}>
                        {verdictLabel}
                        {typeof entry.riskScore === "number" ? ` · risco ${entry.riskScore}` : ""}
                      </span>
                    </div>
                    <p className="row-meta truncate" title={entry.originalPath}>
                      {entry.originalPath}
                    </p>
                    <p className={cn("row-meta", isolation.warn && "text-cyber-yellow")}>{isolation.text}</p>
                  </div>

                  <div className="row-act flex shrink-0 flex-col items-end gap-1.5">
                    <button
                      type="button"
                      disabled={aLote || busyId !== null}
                      onClick={() => alternarSelecao(entry.id)}
                      aria-pressed={selecionados.has(entry.id)}
                      className={selecionados.has(entry.id) ? BOTAO_LIGADO : BOTAO_NEUTRO}
                      aria-label={(selecionados.has(entry.id) ? "Retirar da selecao: " : "Selecionar para lote: ") + entry.fileName}
                    >
                      {selecionados.has(entry.id) ? "Selecionado" : "Selecionar"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setExpanded(expandido ? null : entry.id)}
                      aria-expanded={expandido}
                      aria-controls={idDetalhes}
                      className={BOTAO_LIGADO}
                      aria-label={`${expandido ? "Ocultar" : "Ver"} detalhes de ${entry.fileName}`}
                    >
                      {expandido ? <ChevronDown className="h-3.5 w-3.5" aria-hidden /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden />}
                      Detalhes
                    </button>
                    <button
                      type="button"
                      disabled={busyId !== null}
                      onClick={() => { setBandeira(null); setPending({ id: entry.id, action: "restore" }); }}
                      className={BOTAO_NEUTRO}
                      aria-label={`Restaurar ${entry.fileName} para o local original`}
                    >
                      <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Restaurar
                    </button>
                    <button
                      type="button"
                      disabled={busyId !== null}
                      onClick={() => { setBandeira(null); setPending({ id: entry.id, action: "delete" }); }}
                      className={BOTAO_DESTRUTIVO}
                      aria-label={`Eliminar ${entry.fileName} permanentemente`}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden /> Eliminar
                    </button>
                  </div>
                  </div>

                  {expandido && (
                    <div id={idDetalhes} role="region" aria-labelledby={idTitulo} className="quarantine-details border-t border-border/40 pt-3">
                      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
                        <div className="min-w-0 sm:col-span-2">
                          <dt className="eyebrow-label">Caminho original</dt>
                          <dd className="evidence-line mt-1">{entry.originalPath}</dd>
                        </div>
                        <div className="min-w-0 sm:col-span-2">
                          <dt className="eyebrow-label">Ficheiro em quarentena</dt>
                          <dd className="evidence-line mt-1">{entry.quarantinePath}</dd>
                        </div>
                        {entry.detectionReason && (
                          <div className="min-w-0 sm:col-span-2">
                            <dt className="eyebrow-label">Motivo da deteção</dt>
                            <dd className="row-note mt-1">{entry.detectionReason}</dd>
                          </div>
                        )}
                        {entry.engine && (
                          <div className="min-w-0">
                            <dt className="eyebrow-label">Motor</dt>
                            <dd className="row-note mt-1">{entry.engine}</dd>
                          </div>
                        )}
                        <div className="min-w-0 sm:col-span-2">
                          <dt className="eyebrow-label">SHA-256</dt>
                          <dd className="evidence-line mt-1">{entry.sha256 || "não disponível"}</dd>
                        </div>
                        {entry.restoredAt && (
                          <div className="min-w-0">
                            <dt className="eyebrow-label">Restaurado</dt>
                            <dd className="row-note mt-1">
                              {formatDate(entry.restoredAt)}
                              {entry.restoredBy ? ` por ${entry.restoredBy}` : ""}
                            </dd>
                          </div>
                        )}
                      </dl>
                    </div>
                  )}

                  {aConfirmar && (
                    <div className="quarantine-confirm flex flex-wrap items-center justify-between gap-3">
                      {/* O portão de confirmação vive na linha que o pediu. O
                          texto é a razão, por isso é o que o leitor de ecrã
                          anuncia; os botões ficam ao lado, como antes. */}
                      <p
                        role="alert"
                        className={cn(
                          "row-note min-w-0 flex-1 rounded-lg border p-2.5 text-foreground",
                          aConfirmar === "delete" ? "border-destructive/40 bg-destructive/10" : "border-border bg-secondary/30",
                        )}
                      >
                        {aConfirmar === "delete"
                          ? "Eliminar permanentemente? Esta ação é irreversível."
                          : "Restaurar este ficheiro para o local original?"}
                      </p>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => setPending(null)}
                          className={BOTAO_NEUTRO}
                          aria-label={`Cancelar a confirmação para ${entry.fileName}`}
                        >
                          Cancelar
                        </button>
                        <button
                          type="button"
                          onClick={() => void run(entry, aConfirmar)}
                          className={aConfirmar === "delete" ? BOTAO_DESTRUTIVO : BOTAO_LIGADO}
                          aria-label={
                            aConfirmar === "delete"
                              ? `Confirmar eliminação de ${entry.fileName}`
                              : `Confirmar restauro de ${entry.fileName}`
                          }
                        >
                          {aConfirmar === "delete" ? "Eliminar" : "Restaurar"}
                        </button>
                      </div>
                    </div>
                  )}

                  {emCurso && (
                    <p role="status" className="row-meta quarantine-incurso flex items-center gap-2 border-t border-border/30 pt-2">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> A comunicar com o serviço…
                    </p>
                  )}

                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
