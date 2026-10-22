/**
 * R8 — DETECAO USB REAL: enumerador nativo (`@cybersafe/native-windows`) para
 * a porta `PortaDeteccaoUsb` do monitor.
 *
 * Regras que este adapter tem de respeitar (contrato R8):
 *  - A deteccao confirma ARMAZENAMENTO e TRANSPORTE USB (o join e' do
 *    `identifyUsbStorageDevices`, puro e testado no native-windows). Nada de
 *    "DriveType = 2" sozinho.
 *  - A identidade e' a da INSERCAO (serial do disco > PNPDeviceID > indice).
 *    `disk-index-fallback` e' RECICLAVEL entre insercoes: o monitor recusa
 *    auto-scan com essa proveniencia (limitacao declarada), por isso a
 *    proveniencia tem de viajar ate' la'.
 *  - Falha de enumeracao = desconhecido: propaga o erro, nunca inventa
 *    dispositivos.
 *  - Sem PowerShell neste modulo: o executor e' injetado e, em producao, e'
 *    o executivo real do native-windows (inerte ate' ser invocado).
 */
import {
  UsbStorageEnumerator,
  createPowerShellCimBatchExecutor,
  createPowerShellCimExecutor,
  identifyAwaitingVolumeDisks,
  identifyUsbStorageDevices,
  type CimBatchExecutor,
  type CimQueryExecutor,
  type UsbEnumeration,
} from "@cybersafe/native-windows";
import type { UsbDispositivoDetetado, PortaDeteccaoUsb } from "./usb-protection.js";

export interface OpcoesDeteccaoUsb {
  /** Enumeracao completa (4 queries CIM) — injetavel nos testes. */
  enumerar?: () => Promise<UsbEnumeration>;
  /** Executor CIM real; por omissao o do native-windows (PowerShell/CIM). */
  executor?: CimQueryExecutor;
  /** Executor do LOTE (1 processo por ciclo); por omissao o do native-windows. */
  executorLote?: CimBatchExecutor;
}

/**
 * Devolve a porta de deteccao do monitor ligada ao enumerador nativo.
 * `disk-index-fallback` e' marcado na proveniencia e o monitor recusa o
 * auto-scan — a decisao de seguranca fica no servico, nao no adapter.
 */
export function criarDeteccaoUsbNativa(opcoes: OpcoesDeteccaoUsb = {}): PortaDeteccaoUsb {
  // PRODUCAO: um unico processo PowerShell por ciclo (lote das quatro secoes).
  //
  // MEDIDO no instalado (14/10): 4 processos a cada 5 s = 48/min em repouso, com
  // ~200-400 ms de CPU cada e uma alocacao transitoria de dezenas de MB. Com o
  // lote e' 1 processo por ciclo — a mesma enumeracao, a mesma deteccao.
  // Quando o teste injeta `executor` (ou `enumerar`), mantem-se o caminho de
  // quatro chamadas injetado: o seam dos testes nao muda de forma nenhuma.
  // ENUMERACAO PARTILHADA por ciclo: `listar()` e `listarPendentes()` do MESMO
  // ciclo leem a MESMA leitura CIM (uma, nao duas). Sem isto, o estado de
  // espera que esta correccao introduz duplicava o custo que a correccao de
  // performance da sessao anterior reduziu (1 processo/ciclo -> 2).
  //
  // NAO existe janela de cache: partilha-se apenas a enumeracao AINDA EM CURSO
  // (o monitor dispara as duas leituras em paralelo). REGRESSAO REAL medida em
  // teste e corrigida (14/10): uma janela por tempo (mesmo de 250 ms) servia
  // leitura VELHA a um ciclo novo — o ciclo seguinte ao arranque herdava a
  // enumeracao (vazia) do anterior e um USB ja' ligado so' aparecia no ciclo
  // posterior. Um pedido que chegue depois de a leitura terminar faz SEMPRE
  // leitura nova: e' isso que a confirmacao fresca de presenca exige.
  let emCurso: Promise<UsbEnumeration> | null = null;
  const enumerarPartilhado = (): Promise<UsbEnumeration> => {
    if (emCurso) return emCurso;
    const promessa = enumerar();
    emCurso = promessa;
    // Um desfecho (sucesso OU erro) larga a partilha: um erro nunca fica
    // retido e o pedido seguinte volta a enumerar de facto.
    const largar = (): void => {
      if (emCurso === promessa) emCurso = null;
    };
    promessa.then(largar, largar);
    return promessa;
  };

  const enumerarPadrao = (): Promise<UsbEnumeration> => {
    if (opcoes.executor) return new UsbStorageEnumerator(opcoes.executor).enumerate();
    return new UsbStorageEnumerator(
      createPowerShellCimExecutor(),
      opcoes.executorLote ?? createPowerShellCimBatchExecutor(),
    ).enumerate();
  };
  const enumerar = opcoes.enumerar ?? enumerarPadrao;

  return {
    async listar(): Promise<UsbDispositivoDetetado[]> {
      const dispositivos = identifyUsbStorageDevices(await enumerarPartilhado());
      return dispositivos.map((dispositivo) => ({
        id: dispositivo.id,
        rootPath: dispositivo.rootPath,
        rootPaths: [...dispositivo.rootPaths],
        ...(dispositivo.label !== undefined ? { label: dispositivo.label } : {}),
        identityProvenance: dispositivo.identityProvenance,
      }));
    },
    /**
     * BUG REAL (14/10): um disco USB detetado sem volume/letra publicados nao
     * aparecia em lado nenhum — a pagina dizia "sem dispositivo" enquanto o
     * Windows mostrava a pen. Aqui devolve-se o MESMO disco com o estado de
     * espera, para a UI o poder declarar. Nunca tem raiz: nao e' analisavel.
     */
    async listarPendentes(): Promise<Array<{ id: string; identityProvenance?: string }>> {
      const pendentes = identifyAwaitingVolumeDisks(await enumerarPartilhado());
      return pendentes.map((dispositivo) => ({
        id: dispositivo.id,
        identityProvenance: dispositivo.identityProvenance,
      }));
    },
  };
}
