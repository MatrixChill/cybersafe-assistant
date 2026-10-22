import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2, ScanSearch, ShieldCheck, Usb, XCircle } from "lucide-react";
import type { UsbDeviceState } from "@cybersafe/shared-types";
import {
  chipsDoTom,
  criarOrquestradorUsb,
  horaDe,
  linhaDaMemoria,
  linhaDoResultado,
  linhaDeEsperaVolume,
  limitacaoDoDispositivo,
  notaDeConfirmacao,
  progressoDoDispositivo,
  resumoDeHistorico,
  rotuloDoEstado,
  tomDoEstado,
  unidadeDe,
  TEXTO_ANALISE_INDIVIDUAL_INDISPONIVEL,
  TEXTO_ESPERA_PROLONGADA,
  TEXTO_PRE_ANALISE_INDIVIDUAL,
  type ModeloUsb,
  type OrquestradorUsb,
  type PonteAnaliseUsbRenderer,
} from "../lib/usbProtection";

/**
 * R8-USB — painel do observador USB, DENTRO de "Análise de Segurança".
 *
 * O que este painel é, sem rodeios: confirma armazenamento USB e, COM opt-in do
 * utilizador, pede a análise da unidade quando a ligas. Não bloqueia, não ejeta,
 * não impede nada, e não é proteção em tempo real. A palavra «protegido» não
 * aparece aqui porque nada neste ecrã protege.
 *
 * A decisão não vive aqui: vive em `lib/usbProtection.ts`, que é testável sem
 * DOM. Este ficheiro só liga o orquestrador ao React:
 *  · `iniciar()`/`parar()` no ciclo de vida — o tick de `INTERVALO_CONSULTA_MS`
 *    só existe enquanto o painel está montado, e nada escreve no estado depois
 *    de desmontado;
 *  · `receberProgresso` liga o `onScanProgress` que já existe (progresso, nunca
 *    snapshot global) e é o orquestrador que decide se isso vale um re-pedido;
 *  · o `enabled` que se mostra é o do snapshot devolvido, nunca o do pedido.
 *
 * LIMITE HONESTO, o mais importante deste ficheiro: `read-only` e containment da
 * análise USB **ainda não foram provados pelo backend**. Por isso o painel não
 * promete que nada é escrito na unidade — mostra a `limitation` que o serviço
 * declarar e o `monitorStatus` real (`starting`/`unavailable` incluídos). Se o
 * serviço bloquear o auto-scan por essa razão, é isso que se lê aqui.
 */

const MODELO_INICIAL: ModeloUsb = {
  vista: { tipo: "a_consultar" },
  aoVivo: null,
  aConfigurar: false,
  feedback: { tipo: "inerte" },
  monitorStatus: null,
  enabled: false,
  memoria: {},
  /** Antes da primeira resposta não há contrato confirmado: nada a pedir. */
  analise: {
    podePedir: false,
    motivoIndisponivel: TEXTO_ANALISE_INDIVIDUAL_INDISPONIVEL,
    pedido: null,
    emCurso: null,
  },
  esperaProlongada: false,
};

export function UsbProtectionPanel() {
  const [modelo, setModelo] = useState<ModeloUsb>(MODELO_INICIAL);
  const orquestradorRef = useRef<OrquestradorUsb | null>(null);

  if (orquestradorRef.current === null) {
    /** O corpo do componente corre também em `renderToStaticMarkup` (Node, sem
        DOM): ler `window.electronAPI` aqui rebentava o render do Scanner. Sem
        bridge o orquestrador cai no `fase = "sem_ligacao"` que já existe em
        `usbProtection.ts` — a janela diz que não sabe, que é o contrato honesto.
        A subscrição da ponte, no efeito de montagem, continua a ler a bridge
        normalmente: em browser nada muda. */
    const bridge = typeof window !== "undefined" ? window.electronAPI : undefined;
    const obterEstado =
      bridge && typeof bridge.getUsbProtection === "function" ? () => bridge.getUsbProtection() : null;
    const configurar =
      bridge && typeof bridge.configureUsbProtection === "function"
        ? (config: { enabled: boolean }) => bridge.configureUsbProtection(config)
        : null;
    /**
     * A análise individual a pedido, pelo contrato ratificado a 15/10. A seam
     * LÊ a ponte em vez de a assumir: sem `usbScan`+`usbCancel` nesta build, a
     * porta é `null` e o painel declara a ausência — não há botão morto. Quando
     * o OpenCode publicar os tipos, este cast desaparece sem mexer no resto.
     */
    const ponte =
      typeof window !== "undefined" ? (window.electronAPI as unknown as PonteAnaliseUsbRenderer) : undefined;
    const portaAnalise =
      ponte && typeof ponte.usbScan === "function" && typeof ponte.usbCancel === "function"
        ? {
            iniciar: (pedido: { deviceId: string; requestId: string; consent: true }) => ponte.usbScan!(pedido),
            cancelar: (pedido: { deviceId: string; scanId: string }) => ponte.usbCancel!(pedido),
          }
        : null;
    orquestradorRef.current = criarOrquestradorUsb({
      obterEstado,
      configurar,
      portaAnalise,
      aoModelo: setModelo,
    });
  }

  useEffect(() => {
    const orquestrador = orquestradorRef.current;
    if (!orquestrador) return;
    orquestrador.iniciar();
    const subscrever = window.electronAPI?.onScanProgress;
    const unsubscribe =
      typeof subscrever === "function" ? subscrever((estado) => orquestrador.receberProgresso(estado)) : null;
    return () => {
      unsubscribe?.();
      orquestrador.parar();
    };
  }, []);

  const vista = modelo.vista;
  const optIn = vista.tipo === "snapshot" ? (modelo.enabled ? "ligada" : "desligada") : "desconhecida";
  /** Histórico desta sessão: o que o serviço publicou e já não republica. */
  const resumoHistorico = resumoDeHistorico(modelo.memoria);
  /**
   * Com o observador a arrancar ou indisponível, o opt-in estar ligado não
   * produz análises. Dizer isto em voz alta é o que separa «configurado» de
   * «a acontecer» — a distinção que este produto não pode esgravatar.
   */
  const optInSemEfeito =
    vista.tipo === "snapshot" && modelo.enabled && modelo.monitorStatus !== "operational";

  return (
    <section aria-labelledby="usb-titulo" className="cyber-border rounded-xl p-5 space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <div>
          <p className="eyebrow-label">Unidades USB</p>
          <h2 id="usb-titulo" className="font-mono font-semibold text-foreground">
            Monitorização de unidades USB
          </h2>
          <p className="row-note mt-1 max-w-[92ch]">
            Com a monitorização ligada, o serviço pede a análise das unidades USB ligadas depois disto —
            uma de cada vez, pela fila do motor, e só com o modo só-leitura provado. Não bloqueia, não ejeta,
            não impede o uso da unidade e não é proteção em tempo real: a lista de unidades é lida a
            cada 5 s. O que já estava ligado quando se ativou não é analisado.
          </p>
        </div>
        <button
          type="button"
          onClick={() => orquestradorRef.current?.recarregar()}
          disabled={vista.tipo === "a_consultar" && !modelo.esperaProlongada}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-semibold text-foreground transition-colors hover:bg-secondary/60 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {vista.tipo === "a_consultar" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <ScanSearch className="h-3.5 w-3.5" aria-hidden />
          )}
          Recarregar
        </button>
      </div>

      <div className="evidence-line flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <span className="row-meta">
          Monitorização USB: <b className="font-semibold">{optIn}</b>
          {vista.tipo === "snapshot" ? ` · última leitura ${horaDe(vista.atualizado)}` : ""}
        </span>
        <button
          type="button"
          onClick={() => void orquestradorRef.current?.alternarOptIn(!modelo.enabled)}
          disabled={modelo.aConfigurar || vista.tipo !== "snapshot"}
          aria-pressed={modelo.enabled}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-semibold text-foreground transition-colors hover:bg-secondary/60 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {modelo.aConfigurar ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <Usb className="h-3.5 w-3.5" aria-hidden />
          )}
          {modelo.enabled ? "Desligar monitorização" : "Ligar monitorização"}
        </button>
      </div>

      {optInSemEfeito && (
        <p className="row-note" role="status">
          A monitorização está ligada, mas o leitor de unidades{" "}
          {modelo.monitorStatus === "starting" ? "ainda está a arrancar" : "está indisponível"}: nada será
          analisado automaticamente enquanto o serviço não confirmar a leitura de unidades.
        </p>
      )}

      {modelo.feedback.tipo === "ok" && <p className="row-note text-cyber-green">{modelo.feedback.mensagem}</p>}
      {modelo.feedback.tipo === "erro" && (
        <p className="row-note text-cyber-red" role="alert">
          {modelo.feedback.mensagem}
        </p>
      )}
      {modelo.feedback.tipo === "nao_confirmado" && (
        <p className="row-note text-cyber-yellow" role="status">
          {modelo.feedback.mensagem}
        </p>
      )}

      {vista.tipo === "a_consultar" && (
        <div className="flex items-start gap-3" role="status" aria-live="polite">
          <span className="icon-tile" aria-hidden>
            <Loader2 className="h-4 w-4 animate-spin" />
          </span>
          <p className="row-note">
            {modelo.esperaProlongada ? TEXTO_ESPERA_PROLONGADA : "A consultar a monitorização USB ao serviço…"}
          </p>
        </div>
      )}

      {vista.tipo === "sem_ligacao" && (
        <div className="flex items-start gap-3" role="status">
          <span className="icon-tile icon-tile--warn" aria-hidden>
            <AlertTriangle className="h-4 w-4" />
          </span>
          <p className="row-note">
            Esta janela não tem o bridge do estado USB, por isso não se sabe se há unidades ligadas. Não
            se mostra lista vazia: ausência de leitura não é «sem unidades».
          </p>
        </div>
      )}

      {vista.tipo === "erro" && (
        <div className="flex items-start gap-3" role="alert">
          <span className="icon-tile icon-tile--crit" aria-hidden>
            <AlertTriangle className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <p className="row-title">O estado USB não pôde ser lido</p>
            <p className="row-note mt-1">{vista.mensagem}</p>
            <p className="row-note mt-1">
              Para repetir a leitura use «Recarregar» acima — não é preciso sair desta página.
            </p>
          </div>
        </div>
      )}

      {vista.tipo === "snapshot" && (
        <>
          <div className="flex items-start gap-3">
            <span className={chipsDoTom(vista.monitor.tom).tile} aria-hidden>
              <Usb className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <p className="row-title">{vista.monitor.titulo}</p>
              <p className="row-note mt-1">{vista.monitor.detalhe}</p>
            </div>
          </div>

          {vista.dispositivos.length > 0 && <p className="row-meta">{vista.presenca}</p>}

          {resumoHistorico && <p className="row-meta">{resumoHistorico}</p>}

          {!modelo.analise.podePedir && <p className="row-note">{TEXTO_ANALISE_INDIVIDUAL_INDISPONIVEL}</p>}

          {vista.ignorados > 0 && (
            <p className="row-note" role="status">
              {vista.ignorados === 1
                ? "1 registo de dispositivo veio num formato que a app não reconhece e não é mostrado."
                : `${vista.ignorados} registos de dispositivo vieram num formato que a app não reconhece e não são mostrados.`}
            </p>
          )}

          {vista.dispositivos.length > 0 && (
            <div className="stat-card overflow-hidden">
              <div className="row-list">
                {vista.dispositivos.map((d: UsbDeviceState) => {
                  const chip = chipsDoTom(tomDoEstado(d.status));
                  const percentagem = progressoDoDispositivo(d, modelo.aoVivo);
                  const confirmacao = notaDeConfirmacao(d, modelo.aoVivo);
                  const contagem = linhaDoResultado(d);
                  const memoriaLinha = linhaDaMemoria(d, modelo.memoria);
                  const limitacao = limitacaoDoDispositivo(d);
                  const esperaVolume = linhaDeEsperaVolume(d);
                  return (
                    <article key={d.id} className="row-item">
                      <span className={chip.tile} aria-hidden>
                        <Usb className="h-4 w-4" />
                      </span>
                      <div className="min-w-0 space-y-1.5">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <h3 className="row-title">{unidadeDe(d)}</h3>
                          <span className={chip.chip}>{rotuloDoEstado(d.status)}</span>
                          {!d.present && <span className="row-meta">não está presente na última enumeração</span>}
                        </div>
                        <div className="flex flex-wrap gap-x-4 gap-y-1">
                          {percentagem !== null && (
                            <span className="row-meta tabular-nums">progresso {percentagem} de 100</span>
                          )}
                          {percentagem === null && d.status === "scanning" && (
                            <span className="row-meta">sem leitura de progresso desta sessão</span>
                          )}
                          {confirmacao && <span className="row-meta">{confirmacao}</span>}
                          {contagem && <span className="row-meta">{contagem}</span>}
                        </div>
                        {memoriaLinha && <p className="row-note">{memoriaLinha}</p>}
                        {modelo.analise.podePedir && d.present && d.rootPath !== "" && d.awaitingVolume !== true && (
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <button
                              type="button"
                              onClick={() => orquestradorRef.current?.pedirConsentimento(d.id)}
                              disabled={
                                modelo.analise.emCurso !== null ||
                                modelo.analise.pedido !== null ||
                                d.status === "scanning" ||
                                d.status === "queued"
                              }
                              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-semibold text-foreground transition-colors hover:bg-secondary/60 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              <ScanSearch className="h-3.5 w-3.5" aria-hidden />
                              Analisar esta unidade
                            </button>
                            {(d.status === "scanning" || d.status === "queued") && d.scanId && (
                              <button
                                type="button"
                                onClick={() => orquestradorRef.current?.cancelarAnalise(d.id)}
                                disabled={modelo.analise.emCurso !== null}
                                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-semibold text-foreground transition-colors hover:bg-secondary/60 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                <XCircle className="h-3.5 w-3.5" aria-hidden />
                                Cancelar análise
                              </button>
                            )}
                          </div>
                        )}
                        {modelo.analise.pedido?.deviceId === d.id && (
                          <div className="rounded-lg border border-border p-3">
                            <p className="row-note">{TEXTO_PRE_ANALISE_INDIVIDUAL}</p>
                            <div className="mt-2 flex flex-wrap items-center gap-2">
                              <button
                                type="button"
                                onClick={() => orquestradorRef.current?.confirmarPedido()}
                                disabled={modelo.analise.emCurso !== null}
                                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-semibold text-foreground transition-colors hover:bg-secondary/60 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
                                Confirmar análise só-leitura
                              </button>
                              <button
                                type="button"
                                onClick={() => orquestradorRef.current?.desistirDoPedido()}
                                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-semibold text-foreground transition-colors hover:bg-secondary/60"
                              >
                                Desistir
                              </button>
                            </div>
                          </div>
                        )}
                        {modelo.analise.emCurso?.deviceId === d.id && (
                          <p className="row-note" role="status">
                            {modelo.analise.emCurso.tipo === "cancelar"
                              ? "Cancelamento em curso — o serviço ainda não confirmou."
                              : "Pedido de análise em curso — o serviço ainda não confirmou."}
                          </p>
                        )}
                        {esperaVolume && (
                          <p className="row-note" role="status">
                            {esperaVolume}
                          </p>
                        )}
                        {limitacao && <p className="row-note text-cyber-yellow">Limitação: {limitacao}</p>}
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
