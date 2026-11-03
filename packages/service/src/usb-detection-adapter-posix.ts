/**
 * §10 Linux Lite — a porta `PortaDeteccaoUsb` servida por sysfs + `mountinfo`.
 *
 * A porta é a mesma que `usb-protection.ts` já consome; o que muda é a fonte. O
 * monitor continua a decidir a segurança (recusa `disk-index-fallback`, exige
 * contrato read-only, confirma presença no fim), e o `UsbReadOnlyScanAdapter`
 * continua a forçar `readOnly: true`. Este ficheiro não acrescenta decisões de
 * política: traduz factos do kernel para a forma do contrato.
 *
 * `listarPendentes` não é implementado, de propósito. O estado de espera do
 * Windows existe porque um disco pode ter letra publicada mais tarde, e o motivo
 * que o monitor mostra nomeia essa letra («a aguardar volume (letra) do
 * Windows»). Em Linux um disco sem volume montado não tem nada a aguardar por nós
 * — montar seria ação privilegiada, que este projeto não faz. Aparece em
 * `semVolume` no resultado da deteção, não como dispositivo analisável.
 */
import { detetarUsbReais, type ResultadoDeteccaoUsbPosix } from "@cybersafe/core";
import type { PortaDeteccaoUsb, UsbDispositivoDetetado } from "./usb-protection.js";

export interface OpcoesDeteccaoUsbPosix {
  /** Fonte injetável — os testes não leem `/sys`. */
  detetar?: () => ResultadoDeteccaoUsbPosix;
}

/**
 * Enumeração fresca a cada chamada: é isso que a confirmação de presença no fim
 * de uma análise exige, e sysfs não custa um processo por leitura (o adapter
 * Windows partilha a leitura em curso porque cada leitura é um PowerShell).
 *
 * `ok: false` LANÇA em vez de devolver lista vazia — «não consegui ler a tabela»
 * não é «não há dispositivos», e o monitor trata o erro como desconhecido.
 */
export function criarDeteccaoUsbPosix(opcoes: OpcoesDeteccaoUsbPosix = {}): PortaDeteccaoUsb {
  const detetar = opcoes.detetar ?? (() => detetarUsbReais());
  return {
    async listar(): Promise<UsbDispositivoDetetado[]> {
      const resultado = detetar();
      if (!resultado.ok) {
        throw new Error(resultado.motivo ?? "a deteção de blocos do sistema falhou");
      }
      return resultado.dispositivos.map((dispositivo) => ({
        id: dispositivo.id,
        rootPath: dispositivo.rootPath,
        rootPaths: [...dispositivo.rootPaths],
        identityProvenance: dispositivo.identityProvenance,
      }));
    },
  };
}
