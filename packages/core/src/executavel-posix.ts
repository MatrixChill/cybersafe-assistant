import fs from "node:fs";

/**
 * O que um resolutor de motores sabe ler do disco sobre um candidato a
 * binário. Injectável para que um teste possa afirmar «isto é um PE» ou «isto
 * não tem bit de execução» sem depender do que a máquina de CI tem instalado.
 */
export interface LeitorBinario {
  isFile(candidato: string): boolean;
  /** POSIX: o sistema tem permissão de execução sobre este ficheiro? */
  executavel(candidato: string): boolean;
  /** Primeiros dois bytes, ou `null` quando ilegível. */
  magic(candidato: string): string | null;
}

export const leitorBinarioReal: LeitorBinario = {
  isFile: (candidato) => {
    try {
      return fs.statSync(candidato).isFile();
    } catch {
      return false;
    }
  },
  executavel: (candidato) => {
    try {
      fs.accessSync(candidato, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  magic: (candidato) => {
    let fd: number | null = null;
    try {
      fd = fs.openSync(candidato, "r");
      const buffer = Buffer.alloc(2);
      const lidos = fs.readSync(fd, buffer, 0, 2, 0);
      return lidos === 2 ? buffer.toString("latin1") : null;
    } catch {
      return null;
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          /* fecho é melhor esforço: a leitura já aconteceu ou falhou */
        }
      }
    }
  },
};

/**
 * Razão pela qual um candidato é recusado em POSIX, ou `null` quando é
 * utilizável. Cada recusa é uma razão de proveniência, não um capricho:
 *   • `.exe`/`MZ` — é uma imagem Windows; usá-la faria do executável Windows o
 *     motor do Linux (e no WSL a interop ainda o deixaria correr).
 *   • sem bit de execução — o `spawn` rebentaria com EACCES, e o estado do
 *     motor sairia mentiroso.
 *   • ilegível — não podemos saber o que é, por isso não é «disponível».
 */
export function recusaExecutavelPosix(
  candidato: string,
  magic: string | null,
  executavel: boolean,
): string | null {
  if (/\.exe$/i.test(candidato)) return "é um executável Windows (.exe)";
  if (magic === "MZ") return "é uma imagem PE de Windows (magic MZ)";
  if (!executavel) return "não tem permissão de execução";
  if (magic === null) return "não é legível";
  return null;
}

/** A recusa aplicada a um caminho lido no disco; em Windows nada é recusado. */
export function recusarBinarioNaPlataforma(
  candidato: string,
  platform: NodeJS.Platform,
  leitor: LeitorBinario = leitorBinarioReal,
): string | null {
  if (platform === "win32") return null;
  return recusaExecutavelPosix(candidato, leitor.magic(candidato), leitor.executavel(candidato));
}
