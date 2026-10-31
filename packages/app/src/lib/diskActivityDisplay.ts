import type { DiskActivityReading, DiskSnapshot, ReadingStatus } from "@cybersafe/shared-types";

/**
 * Apresentação da atividade medida de armazenamento.
 *
 * Porque existe um módulo próprio para algo que o contrato já traz pronto: é
 * aqui que se decide, sem renderer, a diferença entre «0 B/s medido» e «sem
 * leitura nenhuma». O caso real existe no motor — um volume sem tráfego devolve
 * `readBytesPerSec: 0` com `status: "available"`, e um volume ainda por medir
 * devolve `null`. Pintar os dois com o mesmo `0` era exatamente a mentira que o
 * requisito §1 proíbe («velocidades apenas quando comprováveis»).
 *
 * Fonte dos números: contadores de desempenho do Windows (PDH), os mesmos que o
 * Monitor de Recursos usa. A janela de amostragem é o intervalo entre dois
 * `PdhCollectQueryData`, hoje ~5 s; mostrá-la é o que permite a comparação com
 * as ferramentas nativas em vez de a fingir.
 */

const NUMERO_DECIMAL = new Intl.NumberFormat("pt-PT", { maximumFractionDigits: 1 });
const NUMERO_INTEIRO = new Intl.NumberFormat("pt-PT", { maximumFractionDigits: 0 });

/** Sinal de «não medido». Distinto, e não confundível, de `0 B/s`. */
export const DISK_TEXTO_SEM_LEITURA = "—";

/** Rótulo do agregado (`_Total`), que não é um volume com letra. */
export const DISK_AGGREGADO_ROTULO = "Todos os volumes";

/** Proveniência comum, dita uma vez por bloco em vez de por linha. */
export const DISK_ATIVIDADE_FONTE =
  "Contadores de desempenho do Windows (PDH), os mesmos do Monitor de Recursos; janela de ~5 s.";

/**
 * Taxa em bytes por segundo com unidade binária e vírgula decimal PT.
 * `null`/`NaN` → traço. `0` medido → «0 B/s», porque zero medido é um número.
 */
export function formatTaxaDiscos(bytesPerSec: number | null | undefined): string {
  if (typeof bytesPerSec !== "number" || !Number.isFinite(bytesPerSec)) return DISK_TEXTO_SEM_LEITURA;
  const valor = Math.max(0, bytesPerSec);
  if (valor < 1024) return `${NUMERO_INTEIRO.format(Math.round(valor))} B/s`;
  const kilobytes = valor / 1024;
  if (kilobytes < 1024) return `${NUMERO_DECIMAL.format(kilobytes)} KB/s`;
  const megabytes = kilobytes / 1024;
  if (megabytes < 1024) return `${NUMERO_DECIMAL.format(megabytes)} MB/s`;
  return `${NUMERO_DECIMAL.format(megabytes / 1024)} GB/s`;
}

/** Operações por segundo: «12 ops/s» / traço sem leitura. */
export function formatOperacoesDisco(operacoes: number | null | undefined): string {
  if (typeof operacoes !== "number" || !Number.isFinite(operacoes)) return DISK_TEXTO_SEM_LEITURA;
  return `${NUMERO_DECIMAL.format(Math.max(0, operacoes))} ops/s`;
}

/** Percentagem sem unidade inventada: nunca «0 %» quando não foi medido. */
export function formatPercentagemDisco(percent: number | null | undefined): string {
  if (typeof percent !== "number" || !Number.isFinite(percent)) return DISK_TEXTO_SEM_LEITURA;
  return `${NUMERO_DECIMAL.format(Math.min(100, Math.max(0, percent)))} %`;
}

export interface DiskActivityRow {
  /** Identificador estável para a lista (`C:` ou `__agregado__`). */
  chave: string;
  /** O que o utilizador lê: `C:` ou «Todos os volumes». */
  rotulo: string;
  agregado: boolean;
  leituraTexto: string;
  escritaTexto: string;
  operacoesLeituraTexto: string;
  operacoesEscritaTexto: string;
  /** Número medido apenas quando existe; o texto separado distingue o resto. */
  tempoOcioso: number | null;
  tempoOciosoTexto: string;
  fonte: string;
  estado: ReadingStatus;
}

function paraLinha(reading: DiskActivityReading): DiskActivityRow {
  const mount = reading.mount;
  const agregado = mount === null;
  const medido = reading.status === "available";
  const taxa = (valor: number | null) => (medido ? formatTaxaDiscos(valor) : DISK_TEXTO_SEM_LEITURA);
  const ops = (valor: number | null) => (medido ? formatOperacoesDisco(valor) : DISK_TEXTO_SEM_LEITURA);
  const ocioso = medido && typeof reading.idlePercent === "number" ? reading.idlePercent : null;
  return {
    chave: mount === null ? "__agregado__" : mount,
    rotulo: mount === null ? DISK_AGGREGADO_ROTULO : mount,
    agregado,
    leituraTexto: taxa(reading.readBytesPerSec),
    escritaTexto: taxa(reading.writeBytesPerSec),
    operacoesLeituraTexto: ops(reading.readsPerSec),
    operacoesEscritaTexto: ops(reading.writesPerSec),
    tempoOcioso: ocioso,
    tempoOciosoTexto: ocioso === null ? DISK_TEXTO_SEM_LEITURA : formatPercentagemDisco(ocioso),
    fonte: reading.source,
    estado: reading.status,
  };
}

/**
 * Linhas a mostrar: só leituras medidas, volumes por letra em ordem e o
 * agregado por último. Sem atividade disponível devolve lista vazia — quem
 * mostra usa `diskAtividadeIndisponivelTexto` e não publica números velhos.
 */
export function diskActivityRows(disk: DiskSnapshot | null | undefined): DiskActivityRow[] {
  const leitura = disk?.activity;
  if (!Array.isArray(leitura) || leitura.length === 0) return [];
  if (disk?.activityStatus !== undefined && disk?.activityStatus !== "available") return [];
  const linhas = leitura.map(paraLinha);
  const volumes = linhas.filter((linha) => !linha.agregado).sort((a, b) => a.rotulo.localeCompare(b.rotulo));
  const agregado = linhas.filter((linha) => linha.agregado);
  return [...volumes, ...agregado];
}

/**
 * Porque a indisponibilidade tem três causas que o utilizador não pode
 * confundir: ainda sem intervalo entre amostras (vai resolver-se sozinho),
 * contadores nativos em falta na máquina, e falha de leitura. O motivo cru do
 * motor vem no `activityDetail` e é mostrado tal qual — não reescrevemos um
 * `PDH 0xC0000BB8` por «Sensor indisponível» e perdemos o diagnóstico.
 */
export function diskAtividadeIndisponivelTexto(disk: DiskSnapshot | null | undefined): string {
  const detalhe = disk?.activityDetail ?? null;
  if (detalhe && /sem intervalo medido/i.test(detalhe)) {
    return "A medir — os contadores de taxa precisam de duas amostras; a próxima atualização traz a velocidade.";
  }
  if (detalhe && /ffi-indisponivel/i.test(detalhe)) {
    return `Sem contadores de desempenho nativos nesta máquina (${detalhe}).`;
  }
  if (detalhe && /nenhum contador LogicalDisk/i.test(detalhe)) {
    return `Nenhum contador de disco acessível nesta máquina (${detalhe}).`;
  }
  return detalhe ? `Sem atividade de disco medida (${detalhe}).` : "Sem atividade de disco medida.";
}

/** Resumo compacto para uma linha de texto: «↓ 9,6 KB/s · ↑ 754,5 KB/s». */
export function diskAtividadeResumo(disk: DiskSnapshot | null | undefined): string | null {
  const rows = diskActivityRows(disk);
  const origem = rows.find((linha) => linha.agregado) ?? rows[0];
  if (!origem) return null;
  return `↓ ${origem.leituraTexto} · ↑ ${origem.escritaTexto}`;
}
