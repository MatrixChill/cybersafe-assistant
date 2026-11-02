/**
 * ── USB Linux: um disco é USB porque o transporte o diz, não porque tem letra ─
 *
 * O Windows confirma USB por CIM (transporte + armazenamento, no join de
 * `identifyUsbStorageDevices`). Em Linux não há CIM nem letras: o kernel publica
 * a topologia em `/sys/block/<dev>/` e o `readlink` desse diretório devolve o
 * caminho do dispositivo até à raiz do sysfs — um segmento `usb<N>` nesse caminho
 * É o controlador USB. A existência de volume vem da mesma tabela de montagens
 * que `mounts-posix.ts` lê, junta pelo `major:minor`, nunca pelo nome `sdb`.
 *
 * O que este módulo deliberadamente não faz:
 *  - **não monta nada.** Um disco em USB sem volume montado fica em `semVolume`,
 *    declarado; não vira alvo de análise e não se disfarça de «a aguardar letra».
 *  - **não inventa identidade estável.** A identidade é o serial do disco
 *    (`device/serial`); sem serial, o nome de índice do kernel, marcado com
 *    `disk-index-fallback` — a proveniência que o monitor já recusa para
 *    auto-scan. A decisão de segurança continua no serviço, não aqui.
 *  - **não atribui USB ao que não passa por USB.** `dm-*`, `loop*`, `mmcblk*` e
 *    discos virtuais ficam em `naoAtribuidos`, visíveis, em vez de silêncio.
 *  - **não lê conteúdo de ficheiros nem nomes de volume.** Não há `blkid`: os
 *    campos que saem daqui vêm de sysfs e de `mountinfo`.
 */
import * as fsReal from "node:fs";

import { CAMINHO_MOUNTINFO_PADRAO, FSTYPES_NAO_VOLUME, parseMountinfo } from "./mounts-posix.js";

/** Leitura de sysfs + `mountinfo`, injectável: os testes não tocam no disco. */
export interface SysfsUsbFsLike {
  /** `readdir` de um diretório. Deve lançar em falha — ausência não é lista vazia. */
  readdirSync(diretorio: string): string[];
  /** Alvo do symlink, como sysfs o escreve; lança se o nó não for um link. */
  readlinkSync(caminho: string): string;
  /** Conteúdo de um ficheiro de sysfs; lança se não existir ou não for legível. */
  readFileSync(caminho: string, codificacao: "utf-8"): string;
}

export const CAMINHO_SYS_BLOCK_PADRAO = "/sys/block";

/** Só `PROVENIENCIA_INDICE_RECICLAVEL` tem significado no monitor: é a recusa. */
export const PROVENIENCIA_SERIAL_SYSFS = "sysfs-serial";
export const PROVENIENCIA_INDICE_RECICLAVEL = "disk-index-fallback";

/** Um volume de um disco USB, na forma que `PortaDeteccaoUsb` espera. */
export interface DiscoUsbPosix {
  /** Identidade da inserção — serial, ou índice marcado como reciclável. */
  id: string;
  rootPath: string;
  rootPaths: string[];
  identityProvenance: string;
  /** Nome de bloco do kernel (`sdb`): diagnóstico, nunca identidade. */
  nomeBloco: string;
  /** `major:minor` do disco inteiro. */
  dispositivo: string;
  /** `/sys/block/<dev>/removable`; `null` quando o kernel não o revelou. */
  amovivel: boolean | null;
  /** Serial, tal como `device/serial` o escreve; ausente quando não existe. */
  serial?: string;
}

export interface ResultadoDeteccaoUsbPosix {
  ok: boolean;
  dispositivos: DiscoUsbPosix[];
  /** Fato por disco visto — para que «zero dispositivos» seja auditável. */
  observados: Array<{ nomeBloco: string; usb: boolean; amovivel: boolean | null; montagens: number }>;
  semVolume: string[];
  naoAtribuidos: string[];
  /** Discos cuja topologia não se conseguiu ler; não contam como ausência. */
  ilegiveis: number;
  motivo: string | null;
}

/** Segmento `usb1`/`usb2` — o controlador; distingue-se da interface `usb1:1.0`. */
export function temTransporteUsb(caminhoSysfs: string): boolean {
  return caminhoSysfs.split("/").some((segmento) => /^usb\d+$/.test(segmento));
}

function leTexto(fs: SysfsUsbFsLike, caminho: string): string | null {
  try {
    return fs.readFileSync(caminho, "utf-8").trim();
  } catch {
    return null;
  }
}

/** `major:minor` de um nó de dispositivo; `null` quando o sysfs não responde. */
function leDispositivo(fs: SysfsUsbFsLike, caminho: string): string | null {
  const texto = leTexto(fs, caminho);
  if (!texto) return null;
  const [major, minor] = texto.split(":");
  if (!/^\d+$/.test(major ?? "") || !/^\d+$/.test(minor ?? "")) return null;
  return `${major}:${minor}`;
}

/**
 * Partições de um disco: entradas de `/sys/block/<dev>` cujo nome começa pelo
 * nome do disco e que expõem `dev`. `queue`, `holders`, `slaves` e `device` também
 * são diretórios — não têm `dev`, por isso não contam como partição.
 */
function listaParticoes(fs: SysfsUsbFsLike, diretorioDisco: string, nomeBloco: string): string[] {
  let entradas: string[];
  try {
    entradas = fs.readdirSync(diretorioDisco);
  } catch {
    return [];
  }
  return entradas
    .filter((entrada) => entrada !== nomeBloco && entrada.startsWith(nomeBloco))
    .filter((entrada) => leDispositivo(fs, `${diretorioDisco}/${entrada}/dev`) !== null)
    .sort();
}

/**
 * Enumera os nós de `/sys/block`, confirma o transporte USB e junta cada disco
 * (e as suas partições) aos pontos de montagem pelo `major:minor`.
 *
 * `ok: false` só quando uma das duas tabelas não pôde ser lida de todo: um disco
 * ilegível no meio conta em `ilegiveis` e os outros continuam publicados.
 */
export function detetarUsbPosix(
  fs: SysfsUsbFsLike,
  caminhoMountinfo = CAMINHO_MOUNTINFO_PADRAO,
  raizSysBlock = CAMINHO_SYS_BLOCK_PADRAO,
): ResultadoDeteccaoUsbPosix {
  const vazio = {
    ok: false,
    dispositivos: [] as DiscoUsbPosix[],
    observados: [] as ResultadoDeteccaoUsbPosix["observados"],
    semVolume: [] as string[],
    naoAtribuidos: [] as string[],
    ilegiveis: 0,
  };

  let nomesDiscos: string[];
  try {
    nomesDiscos = fs.readdirSync(raizSysBlock);
  } catch (erro) {
    return {
      ...vazio,
      motivo: `A tabela de dispositivos de bloco (${raizSysBlock}) não pôde ser lida (${
        erro instanceof Error ? erro.message : String(erro)
      }).`,
    };
  }

  let montagens: ReturnType<typeof parseMountinfo>;
  try {
    montagens = parseMountinfo(fs.readFileSync(caminhoMountinfo, "utf-8"));
  } catch (erro) {
    return {
      ...vazio,
      motivo: `A tabela de montagens (${caminhoMountinfo}) não pôde ser lida (${
        erro instanceof Error ? erro.message : String(erro)
      }).`,
    };
  }

  // `major:minor` -> pontos de montagem que são armazenamento do utilizador.
  const montagensPorDispositivo = new Map<string, string[]>();
  for (const entrada of montagens.entradas) {
    if (FSTYPES_NAO_VOLUME.has(entrada.fileSystem)) continue;
    const lista = montagensPorDispositivo.get(entrada.dispositivo) ?? [];
    if (!lista.includes(entrada.mount)) lista.push(entrada.mount);
    montagensPorDispositivo.set(entrada.dispositivo, lista);
  }

  const dispositivos: DiscoUsbPosix[] = [];
  const observados: ResultadoDeteccaoUsbPosix["observados"] = [];
  const semVolume: string[] = [];
  const naoAtribuidos: string[] = [];
  let ilegiveis = 0;

  for (const nomeBloco of [...nomesDiscos].sort()) {
    const diretorioDisco = `${raizSysBlock}/${nomeBloco}`;
    let topologia: string;
    try {
      topologia = fs.readlinkSync(diretorioDisco);
    } catch {
      ilegiveis += 1;
      continue;
    }

    const textoRemovivel = leTexto(fs, `${diretorioDisco}/removable`);
    const amovivel = textoRemovivel === "1" ? true : textoRemovivel === "0" ? false : null;
    const usb = temTransporteUsb(topologia);

    // Raízes do disco: montagem do disco inteiro (um pen sem tabela de partições
    // monta-se como `sdb`) e das partições que o kernel publicar.
    const chaves = [leDispositivo(fs, `${diretorioDisco}/dev`)];
    for (const particao of listaParticoes(fs, diretorioDisco, nomeBloco)) {
      chaves.push(leDispositivo(fs, `${diretorioDisco}/${particao}/dev`));
    }
    const raizes: string[] = [];
    for (const chave of chaves) {
      if (chave === null) continue;
      for (const mount of montagensPorDispositivo.get(chave) ?? []) {
        if (!raizes.includes(mount)) raizes.push(mount);
      }
    }
    observados.push({ nomeBloco, usb, amovivel, montagens: raizes.length });

    if (!usb) {
      naoAtribuidos.push(nomeBloco);
      continue;
    }
    if (raizes.length === 0) {
      semVolume.push(nomeBloco);
      continue;
    }

    const devDisco = chaves[0] ?? nomeBloco;
    const serial = leTexto(fs, `${diretorioDisco}/device/serial`) ?? "";
    // Raiz principal = a montagem mais CURTA. Um bind de uma subpasta não
    // representa o volume; a raiz do volume representa.
    raizes.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));

    dispositivos.push({
      id: serial !== "" ? `usb-serial:${serial}` : `usb-index:${nomeBloco}`,
      identityProvenance: serial !== "" ? PROVENIENCIA_SERIAL_SYSFS : PROVENIENCIA_INDICE_RECICLAVEL,
      rootPath: raizes[0] as string,
      rootPaths: [...raizes],
      nomeBloco,
      dispositivo: devDisco,
      amovivel,
      ...(serial !== "" ? { serial } : {}),
    });
  }

  return { ok: true, dispositivos, observados, semVolume, naoAtribuidos, ilegiveis, motivo: null };
}

/** Versão real: sysfs e `mountinfo` lidos com `node:fs`, sem caminho montado. */
export function detetarUsbReais(
  caminhoMountinfo = CAMINHO_MOUNTINFO_PADRAO,
  raizSysBlock = CAMINHO_SYS_BLOCK_PADRAO,
): ResultadoDeteccaoUsbPosix {
  return detetarUsbPosix(
    {
      readdirSync: (diretorio) => fsReal.readdirSync(diretorio),
      readlinkSync: (caminho) => fsReal.readlinkSync(caminho, "utf-8"),
      readFileSync: (caminho, codificacao) => fsReal.readFileSync(caminho, codificacao),
    },
    caminhoMountinfo,
    raizSysBlock,
  );
}
