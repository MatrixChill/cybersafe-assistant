import type { HardwareSnapshot, ReadingStatus } from "@cybersafe/shared-types";
import { cn } from "@/lib/utils";
import {
  DISK_ATIVIDADE_FONTE,
  diskActivityRows,
  diskAtividadeIndisponivelTexto,
} from "@/lib/diskActivityDisplay";

/**
 * O que a aquisição já mede e os cartões do PC Center não mostram.
 *
 * A separação existe por um motivo: os cartões decidem o que é interessante ao
 * nível do glance (uso, temperatura, espaço livre). Tudo o que está aqui em
 * baixo é medido com esforço real (PDH, kernel32, CIM) e simplesmente não
 * tinha superfície — um dado comprado e não mostrado é metade do desperdício de
 * um dado mostrado sem ser comprado.
 *
 * Regras que este ficheiro não pode violar:
 *  · `null`/`unavailable` nunca se escreve como `0`, `— GB` ou vazio: diz-se o
 *    estado em palavras;
 *  · `stale` é mostrado como última leitura, não como leitura atual;
 *  · valor derivado (RAM reservada, total do pagefile) diz que é derivado;
 *  · nenhuma linha daqui afirma saúde. Utilização, compromisso e módulos são
 *    medidas; saúde da RAM só viria de um diagnóstico real, que não existe.
 */

const NUMERO = new Intl.NumberFormat("pt-PT", { maximumFractionDigits: 1 });
/** Frequência em GHz: duas casas, porque 5,45 e 5,5 não são a mesma leitura. */
const NUMERO_FREQUENCIA = new Intl.NumberFormat("pt-PT", { maximumFractionDigits: 2 });

/** Estado de leitura em palavras. Ausência de leitura não é zero. */
const ESTADO_TEXTO: Record<ReadingStatus, string> = {
  available: "medido",
  stale: "última leitura",
  unavailable: "sem leitura",
  error: "erro de leitura",
  unsupported: "não suportado",
  "not-applicable": "não aplicável",
};

const estadoTexto = (status: ReadingStatus | undefined): string | undefined =>
  status === undefined ? undefined : ESTADO_TEXTO[status];

function textoGigabytes(bytes: number | null | undefined): string | null {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return null;
  return `${NUMERO.format(bytes / 1024 ** 3)} GB`;
}

/**
 * O contrato traz alguns tamanhos já em GB (`availableGb`, `reservedGb`) e
 * outros em bytes (`commit`, `pagefile`, capacidade dos módulos). Passar um GB
 * pelo conversor de bytes arrendonda-o para 0 — a unidade tem de vir da
 * definição do campo, não da conveniência do apresentador.
 */
function textoGigabytesDeGb(gb: number | null | undefined): string | null {
  if (typeof gb !== "number" || !Number.isFinite(gb) || gb < 0) return null;
  return `${NUMERO.format(gb)} GB`;
}

function textoMegabitesPorSegundo(valor: number | null | undefined): string | null {
  if (typeof valor !== "number" || !Number.isFinite(valor) || valor < 0) return null;
  if (valor >= 1000) return `${NUMERO.format(valor / 1000)} Gb/s`;
  return `${NUMERO.format(Math.round(valor))} Mb/s`;
}

/** Taxa de tráfego por adaptador: bytes/s → Mb/s com duas casas quando pequena. */
function textoTaxaAdaptador(bytesPorSegundo: number | null | undefined): string | null {
  if (typeof bytesPorSegundo !== "number" || !Number.isFinite(bytesPorSegundo) || bytesPorSegundo < 0) return null;
  return textoMegabitesPorSegundo((bytesPorSegundo * 8) / 1_000_000);
}

function textoGigahertz(mhz: number | null | undefined): string | null {
  if (typeof mhz !== "number" || !Number.isFinite(mhz) || mhz <= 0) return null;
  return `${NUMERO_FREQUENCIA.format(mhz / 1000)} GHz`;
}

function Linha({
  rotulo,
  valor,
  estado,
  nota,
  testid,
}: {
  rotulo: string;
  valor: string | null;
  estado?: string;
  nota?: string;
  testid?: string;
}) {
  return (
    <div data-testid={testid} className="flex items-baseline justify-between gap-3 py-1">
      <span className="shrink-0 text-[11px] uppercase tracking-wider text-muted-foreground">{rotulo}</span>
      <span className="min-w-0 text-right font-mono text-[12px] [overflow-wrap:anywhere]">
        {valor ?? <span className="text-muted-foreground">{estado ?? "sem leitura"}</span>}
        {valor !== null && estado !== undefined && estado !== "medido" && (
          <span className="ml-1 text-[10px] text-muted-foreground">· {estado}</span>
        )}
        {nota && <span className="ml-1 block text-[10px] text-muted-foreground/70">{nota}</span>}
      </span>
    </div>
  );
}

function Titulo({ children }: { children: string }) {
  return (
    <h3 className="mb-1 mt-4 text-[11px] font-semibold uppercase tracking-wider text-primary/80 first:mt-0">
      {children}
    </h3>
  );
}

/** Barras por processador lógico. Núcleo sem leitura não tem barra a zero. */
function Nucleos({ cpu }: { cpu: HardwareSnapshot["cpu"] }) {
  const nucleos = cpu.perCore ?? [];
  if (nucleos.length === 0) {
    return (
      <Linha
        testid="cpu-percore-empty"
        rotulo="Utilização por núcleo"
        valor={null}
        estado="sem leitura por núcleo"
        nota="A ausência não é 0 % em cada núcleo: não foi medido."
      />
    );
  }
  return (
    <div data-testid="cpu-percore" className="py-1">
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
          Utilização por processador lógico ({nucleos.length})
        </span>
        <span className="font-mono text-[10px] text-muted-foreground">{estadoTexto(cpu.perCoreUpdatedAt ? "available" : "stale")}</span>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3 lg:grid-cols-4">
        {nucleos.map((nucleo) => {
          const medido = nucleo.status === "available" && typeof nucleo.percent === "number";
          return (
            <div key={nucleo.index} className="flex items-center gap-2" title={`#${nucleo.index} · ${ESTADO_TEXTO[nucleo.status]}`}>
              <span className="w-5 shrink-0 font-mono text-[10px] text-muted-foreground">{nucleo.index}</span>
              <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-secondary" aria-hidden>
                {medido && (
                  <span
                    className="block h-full rounded-full bg-primary"
                    style={{ width: `${Math.min(100, Math.max(0, nucleo.percent ?? 0))}%` }}
                  />
                )}
              </span>
              <span className={cn("w-10 shrink-0 text-right font-mono text-[10px]", medido ? "text-foreground" : "text-muted-foreground")}>
                {medido ? `${NUMERO.format(Math.round(nucleo.percent ?? 0))}%` : ESTADO_TEXTO[nucleo.status]}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SecaoCpu({ hardware }: { hardware: HardwareSnapshot }) {
  const { cpu } = hardware;
  const frecuencia = cpu.frequency;
  const atual = textoGigahertz(frecuencia?.currentMHz);
  const referencia = textoGigahertz(frecuencia?.referenceMHz);
  const estado = estadoTexto(frecuencia?.status);
  const fontes = frecuencia?.source ? `Fonte: ${frecuencia.source}` : undefined;

  return (
    <section data-testid="detail-cpu">
      <Titulo>Processador</Titulo>
      <Linha
        testid="detail-cpu-threads"
        rotulo="Processadores lógicos"
        valor={typeof cpu.logicalCores === "number" ? String(cpu.logicalCores) : null}
      />
      <Linha
        rotulo="Núcleos físicos"
        valor={typeof cpu.physicalCores === "number" ? String(cpu.physicalCores) : null}
        nota={
          typeof cpu.physicalCores !== "number" && typeof cpu.cores === "number"
            ? `O cartão usa ${cpu.cores} como núcleos declarados pelo sistema.`
            : undefined
        }
      />
      <Linha
        testid="detail-cpu-freq-atual"
        rotulo="Frequência atual"
        valor={frecuencia && frecuencia.measuredAsCurrent ? atual : null}
        estado={frecuencia ? estado : "sem leitura de frequência"}
        nota={
          frecuencia && !frecuencia.measuredAsCurrent && atual
            ? `${atual} é o nominal declarado pelo OS, não uma contagem em tempo real.`
            : motivoNota(frecuencia?.reason)
        }
      />
      <Linha
        rotulo="Frequência de referência"
        valor={referencia}
        estado={estado ?? "sem leitura"}
        nota={fontes}
      />
      <Nucleos cpu={cpu} />
    </section>
  );
}

/** Motivo legível só quando existe; nunca uma justificação inventada. */
function motivoNota(reason: string | undefined): string | undefined {
  const limpo = reason?.trim();
  return limpo ? limpo : undefined;
}

function SecaoRam({ hardware }: { hardware: HardwareSnapshot }) {
  const ram = hardware.ram;
  const commit = ram.commit;
  const pagina = ram.pagefile;
  const layout = ram.layout;
  const modulos = layout?.modules ?? [];

  return (
    <section data-testid="detail-ram">
      <Titulo>Memória</Titulo>
      <Linha rotulo="Disponível" valor={textoGigabytesDeGb(ram.availableGb)} />
      <Linha
        rotulo="Reservada pelo sistema"
        valor={textoGigabytesDeGb(ram.reservedGb)}
        nota={ram.reservedIsDerived ? "Derivada de total − disponível − em uso." : undefined}
      />
      <Linha
        testid="detail-commit"
        rotulo="Compromisso (Em utilização / Limite)"
        valor={
          commit && (textoGigabytes(commit.usedBytes) || textoGigabytes(commit.limitBytes))
            ? `${textoGigabytes(commit.usedBytes) ?? "—"} / ${textoGigabytes(commit.limitBytes) ?? "—"}`
            : null
        }
        estado={estadoTexto(commit?.status)}
        nota={commit?.source ? `Fonte: ${commit.source}` : undefined}
      />
      <Linha
        testid="detail-pagefile"
        rotulo="Ficheiro de paginação"
        valor={(() => {
          const usados = textoGigabytes(pagina?.usedBytes);
          const total = textoGigabytes(pagina?.totalBytes);
          if (!usados && !total) return null;
          // Metade sem leitura diz-se em palavras: «— usados de 16 GB» deixava
          // parecer que a utilização foi medida e era ilegível.
          if (usados && total) return `${usados} usados de ${total}`;
          if (total) return `utilização sem leitura · total ${total}`;
          return `${usados} usados · total sem leitura`;
        })()}
        estado={estadoTexto(pagina?.status)}
        nota={pagina?.totalIsDerived ? "O total é derivado do limite de compromisso, não medido no ficheiro." : undefined}
      />
      <Linha
        testid="detail-slots"
        rotulo="Slots ocupados"
        valor={layout ? `${layout.slotsOccupied}${typeof layout.slotsTotal === "number" ? ` de ${layout.slotsTotal}` : ""}` : null}
        estado={estadoTexto(layout?.status)}
      />
      {modulos.length > 0 ? (
        <div data-testid="detail-modulos" className="mt-1 space-y-1">
          {modulos.map((modulo, idx) => (
            <div
              key={`${modulo.bank ?? "banco"}-${modulo.partNumber ?? idx}`}
              className="flex items-baseline justify-between gap-3 font-mono text-[11px]"
            >
              <span className="min-w-0 truncate text-muted-foreground" title={modulo.partNumber ?? undefined}>
                {modulo.bank || `Módulo ${idx + 1}`}
                {modulo.manufacturer ? ` · ${modulo.manufacturer}` : ""}
              </span>
              <span className="whitespace-nowrap">
                {textoGigabytes(modulo.capacityBytes) ?? "capacidade não reportada"}
                {modulo.speedMHz ? ` · ${NUMERO.format(modulo.speedMHz)} MT/s` : ""}
                {modulo.type ? ` · ${modulo.type}` : ""}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-1 text-[10px] leading-snug text-muted-foreground">
          {layout ? "O firmware não expôs os módulos individuais." : "Sem leitura dos módulos de memória."}
        </p>
      )}
      <p data-testid="detail-ram-not-saude" className="mt-2 text-[10px] leading-snug text-muted-foreground/80">
        Utilização não é saúde. Nada nesta secção diz que a memória está boa: um diagnóstico real
        (por exemplo o Diagnóstico de Memória do Windows) seria necessário para isso.
      </p>
    </section>
  );
}

function SecaoRede({ hardware }: { hardware: HardwareSnapshot }) {
  const adaptadores = hardware.network.adapters ?? [];
  return (
    <section data-testid="detail-rede">
      <Titulo>Adaptadores de rede</Titulo>
      {adaptadores.length === 0 ? (
        <Linha rotulo="Adaptadores" valor={null} estado="sem leitura dos adaptadores" />
      ) : (
        <div className="space-y-2">
          {adaptadores.map((adaptador) => (
            <div
              key={adaptador.iface}
              data-testid="detail-rede-adaptador"
              className="rounded-lg border border-border bg-black/20 p-2"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 truncate text-[12px] font-semibold" title={adaptador.label ?? adaptador.iface}>
                  {adaptador.label || adaptador.iface}
                </span>
                <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  {adaptador.kind}
                </span>
              </div>
              <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono text-[11px] text-muted-foreground">
                <span>estado: {adaptador.operstate ?? ESTADO_TEXTO[adaptador.status]}</span>
                <span>ligação: {adaptador.speedMbps ? textoMegabitesPorSegundo(adaptador.speedMbps) : "não reportada"}</span>
                <span>receção: {textoTaxaAdaptador(adaptador.rxBytesPerSec) ?? "sem duas amostras"}</span>
                <span>envio: {textoTaxaAdaptador(adaptador.txBytesPerSec) ?? "sem duas amostras"}</span>
                <span className="truncate" title={adaptador.ip4 ?? undefined}>IPv4: {adaptador.ip4 ?? "—"}</span>
                <span className="truncate" title={adaptador.mac ?? undefined}>MAC: {adaptador.mac ?? "—"}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function SecaoEnergia({
  hardware,
  mostrarBateria,
}: {
  hardware: HardwareSnapshot;
  /**
   * A bateria segue o cartão: `false` significa que a superfície de bateria foi
   * escondida por decisão do produto (legado sem `status` e `hasBattery: false`).
   * Repor aqui uma linha «Bateria» faria aparecer o indicador que o cartão
   * acabou de esconder — duas respostas para a mesma pergunta.
   */
  mostrarBateria: boolean;
}) {
  const energia = hardware.power;
  const bateria = hardware.battery;
  const linha =
    energia?.acLine === "on" ? "Ligado à corrente" : energia?.acLine === "off" ? "A correr da bateria" : null;
  const temBateria =
    energia?.hasBattery === true
      ? "Bateria presente"
      : energia?.hasBattery === false
        ? "Sem bateria — computador de secretária"
        : null;

  return (
    <section data-testid="detail-energia">
      <Titulo>Energia</Titulo>
      <Linha
        testid="detail-ac-line"
        rotulo="Adaptador de alimentação"
        valor={linha}
        estado={energia ? estadoTexto(energia.status) : "sem leitura de energia"}
        nota={energia?.source ? `Fonte: ${energia.source}` : undefined}
      />
      {mostrarBateria && (
        <Linha
          testid="detail-has-battery"
        rotulo="Bateria"
        valor={temBateria}
        estado={
            // `null` no kernel32 não é "não há bateria": é "ainda não foi medido".
            energia?.hasBattery === null || energia?.hasBattery === undefined
              ? "sem leitura do kernel"
              : undefined
          }
          nota={
            energia?.hasBattery === false
              ? "Ausência comprovada por leitura do sistema — não um sensor que falhou."
              : undefined
          }
        />
      )}
      {mostrarBateria && (
        <Linha
          testid="detail-capacidade"
        rotulo="Capacidade / desgaste / ciclos"
          valor={
            bateria?.healthStatus === "available"
            ? [
                bateria.maxCapacityWh != null ? `${NUMERO.format(bateria.maxCapacityWh)} Wh atuais` : null,
                bateria.designCapacityWh != null ? `${NUMERO.format(bateria.designCapacityWh)} Wh de fábrica` : null,
                bateria.wearPercent != null ? `desgaste ${NUMERO.format(bateria.wearPercent)}%` : null,
                bateria.cycleCount != null ? `${bateria.cycleCount} ciclos` : null,
              ]
                .filter(Boolean)
                .join(" · ") || null
              : null
          }
          estado={
            // Cada uma destas ausências é um facto diferente; nenhuma é 0%.
            bateria?.healthStatus === "unsupported"
              ? "o firmware não expõe capacidades"
              : bateria?.healthStatus === "invalid"
                ? "valores de capacidade implausíveis"
                : bateria?.healthStatus === "absent"
                  ? "não aplicável (sem bateria)"
                  : bateria?.healthStatus === undefined
                    ? "saúde não verificada"
                    : undefined
          }
          nota={motivoNota(bateria?.healthDetail)}
        />
      )}
    </section>
  );
}

/**
 * Atividade de disco medida pelo PDH, por volume.
 *
 * O cartão Armazenamento mostra as velocidades ao de leve; aqui está o resto do
 * que a mesma aquisição devolve — operações por segundo e tempo ocioso. O
 * `% Idle Time` merece a nota explicativa: num NVMe rápido pode ler-se 100 %
 * com tráfego no mesmo intervalo, porque as operações terminam dentro da janela.
 * Dizer isto é o que evita que o número pareça inventado — e não podemos
 * escondê-lo, porque foi medido.
 */
function SecaoArmazenamento({ hardware }: { hardware: HardwareSnapshot }) {
  const linhas = diskActivityRows(hardware.disk);
  return (
    <section data-testid="detail-armazenamento">
      <Titulo>Armazenamento — atividade medida</Titulo>
      {linhas.length === 0 ? (
        <Linha rotulo="Contadores de disco" valor={null} estado={diskAtividadeIndisponivelTexto(hardware.disk)} />
      ) : (
        linhas.map((linha) => (
          <div key={linha.chave} title={linha.fonte}>
            <Linha
              testid="detail-disco-linha"
              rotulo={linha.rotulo}
              valor={`${linha.leituraTexto} lidos · ${linha.escritaTexto} escritos`}
              nota={`operações ${linha.operacoesLeituraTexto} / ${linha.operacoesEscritaTexto} · tempo ocioso ${linha.tempoOciosoTexto}`}
            />
          </div>
        ))
      )}
      <p data-testid="detail-disco-fonte" className="mt-2 text-[10px] leading-snug text-muted-foreground/80">
        {DISK_ATIVIDADE_FONTE}
      </p>
      {linhas.length > 0 && (
        <p data-testid="detail-disco-ocioso" className="text-[10px] leading-snug text-muted-foreground/80">
          O tempo ocioso é o contador % Idle Time do volume: pode ler 100 % enquanto há escrita, quando as
          operações terminam dentro da janela de amostragem.
        </p>
      )}
    </section>
  );
}

export function HardwareDetailPanel({
  hardware,
  mostrarBateria,
}: {
  hardware: HardwareSnapshot;
  mostrarBateria: boolean;
}) {
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <SecaoCpu hardware={hardware} />
      <SecaoRam hardware={hardware} />
      <SecaoArmazenamento hardware={hardware} />
      <SecaoRede hardware={hardware} />
      <SecaoEnergia hardware={hardware} mostrarBateria={mostrarBateria} />
    </div>
  );
}
