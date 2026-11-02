/**
 * ── MONTAGENS Linux: descobrir volumes reais sem inventar letras de unidade ───
 *
 * O Windows enumera unidades por letra (`C:`, `D:`) e o USB por CIM. Em Linux
 * nenhuma dessas duas coisas existe: o que existe é uma tabela de montagens,
 * `/proc/self/mountinfo`, onde cada linha declara um ponto de montagem, o
 * sistema de ficheiros, o dispositivo de origem e se a montagem é só-leitura.
 * É essa tabela que este módulo lê — é a mesma fonte que `findmnt` usa, e é a
 * fonte onde o scanner vai voltar a procurar antes de aceitar um alvo.
 *
 * O que NÃO é inventado:
 *  - **nada de letras.** Em WSL2 um volume Windows aparece como `/mnt/c` com
 *    origem `C:\134`; a letra fica no campo `source` (o que o kernel reporta),
 *    nunca no `mount` nem como identidade do volume;
 *  - **pseudo-sistemas de ficheiros não são volumes.** `proc`, `sysfs`,
 *    `devtmpfs`, `tmpfs`, `cgroup2`, `debugfs`, `overlay`, `rootfs` … são
 *    interfaces do kernel. Podem ter contagem de blocos; não são armazenamento
 *    do utilizador para analisar. São excluídos e o total excluído é devolvido
 *    — «zero volumes» sem esta contagem não se distinguiria de «não consegui
 *    ler»;
 *  - **capacidade vem de `statfs`, não do texto da tabela.** `blocks*bsize` é
 *    o total, `bavail*bsize` é o que o utilizador ainda pode escrever (diferente
 *    de `bfree`, que inclui blocos reservados ao root — num disco cheio a
 *    reserva é exatamente a razão pela qual o utilizador já não escreve);
 *  - um `statfs` que falha deixa esse volume de fora mas não apaga os outros, e
 *    a falha é devolvida com o motivo;
 *  - **o mesmo sistema de ficheiros montado em vários sítios conta uma vez.**
 *    Medido em WSL2: `/`, `/home` e `/mnt/wslg/distro` partilham `8:48`; sem
 *    dedupe pelo par `major:minor` teríamos três volumes com a mesma ocupação.
 *
 * Este módulo é a fonte dos volumes; a classificação em `working` /
 * `system-reserved` e a política de leitura boa/falha/`stale` continuam a viver
 * uma só vez em `disk.ts` — aqui produzo o mesmo formato de entrada que
 * `describeDiskRead` já aceita, para não haver duas regras de arredondamento.
 */
import * as fsReal from "node:fs";

import type { RawFsEntry } from "./disk.js";

/** `Statfs` do Node (`fs.statfsSync`) na parte que usamos. */
export interface StatfsBasico {
  bsize: number | bigint;
  blocks: number | bigint;
  bfree: number | bigint;
  bavail: number | bigint;
}

/** A tabela do kernel que diz o que está montado. Não é uma lista de letras. */
export const CAMINHO_MOUNTINFO_PADRAO = "/proc/self/mountinfo";

/** Fonte injectável: testes não tocam no disco, e um chroot troca a raiz. */
export interface MontesFsLike {
  /** Conteúdo de `/proc/self/mountinfo`. Deve lançar em falha — ausência não é lista vazia. */
  readFileSync(caminho: string, codificacao: "utf-8"): string;
  /** `null` = sem leitura deste ponto de montagem (permissão, desmontado a meio). */
  statfsSync(caminho: string): StatfsBasico | null;
}

/** Uma linha de `mountinfo`, já decomposta. Campos vazios são `null`, nunca `""`. */
export interface EntradaMontagem {
  id: number;
  pai: number;
  /** `major:minor` do nó de dispositivo, tal como o kernel o escreve. */
  dispositivo: string;
  /** Caminho dentro do sistema de ficheiros montado (útil em bind mounts). */
  raiz: string;
  mount: string;
  opcoes: string[];
  /** Tipo reportado no campo `- <fstype>`. */
  fileSystem: string;
  /** Fonte reportada pelo kernel: `/dev/sdd`, `C:\134`, `none` … */
  source: string;
  /** Oções do superbloco (o terceiro grupo, depois do `fstype source`). */
  opcoesSuperbloco: string[];
}

/** Sistemas de ficheiros que são interface do kernel, não armazenamento do utilizador. */
export const FSTYPES_NAO_VOLUME = new Set([
  "autofs",
  "binfmt_misc",
  "bpf",
  "cgroup",
  "cgroup2",
  "configfs",
  "debugfs",
  "devpts",
  "devtmpfs",
  "efivarfs",
  "fusectl",
  "hugetlbfs",
  "mqueue",
  "nsfs",
  "overlay",
  "proc",
  "procfs",
  "pstore",
  "ramfs",
  "rootfs",
  "rpc_pipefs",
  "securityfs",
  "selinuxfs",
  "squashfs",
  "sysfs",
  "tmpfs",
  "tracefs",
]);

const num = (value: number | bigint): number => (typeof value === "bigint" ? Number(value) : value);

/**
 * `\x20`, `\x09`, `\x0a`, `\x5c` são as escapes que o kernel usa nos caminhos de
 * `mountinfo` (um nome com espaço não parte a linha). Sem desescapar, uma
 * montagem `"/mnt/a\x20b"` ficava com um caminho inexistente para `statfs`.
 */
function desescapa(campo: string): string {
  if (!campo.includes("\\")) return campo;
  return campo
    .replace(/\\x20/g, " ")
    .replace(/\\x09/g, "\t")
    .replace(/\\x0a/g, "\n")
    .replace(/\\x0d/g, "\r")
    .replace(/\\x5c/g, "\\");
}

/**
 * Parser puro de `mountinfo`. Formato (kernel ≥ 2.6.26):
 * `id pai major:minor raiz montagem opções [campo-opcional ...] - fstype origem opções-superbloco`
 *
 * Linhas sem o separador `-`, sem campos suficientes ou cujo `id` não é número
 * são IGNORADAS em silêncio relativo ao volume mas contadas: um parse que
 * devolvesse menos linhas do que as existentes faria «menos volumes» parecer
 * «menos discos».
 */
export function parseMountinfo(texto: string): { entradas: EntradaMontagem[]; ilegiveis: number } {
  const entradas: EntradaMontagem[] = [];
  let ilegiveis = 0;

  for (const linha of texto.split("\n")) {
    if (!linha.trim()) continue;
    const campos = linha.split(" ");
    const separador = campos.indexOf("-");
    if (separador < 6 || campos.length < separador + 3) {
      ilegiveis += 1;
      continue;
    }
    const id = Number(campos[0]);
    const pai = Number(campos[1]);
    if (!Number.isInteger(id) || !Number.isInteger(pai) || !/^\d+:\d+$/.test(campos[2])) {
      ilegiveis += 1;
      continue;
    }
    const antes = campos.slice(0, separador);
    const depois = campos.slice(separador + 1);
    const mount = desescapa(antes[4]);
    if (!mount.startsWith("/")) {
      ilegiveis += 1;
      continue;
    }
    entradas.push({
      id,
      pai,
      dispositivo: campos[2],
      raiz: desescapa(antes[3]),
      mount,
      // Campos opcionais (shared:N, master:N, propagate_*) vivem entre as
      // opções e o `-`; não são opções de montagem, por isso ficam fora daqui.
      opcoes: antes[5].split(",").filter(Boolean),
      fileSystem: depois[0],
      source: desescapa(depois[1]),
      opcoesSuperbloco: (depois[2] ?? "").split(",").filter(Boolean),
    });
  }

  return { entradas, ilegiveis };
}

/**
 * Um volume com menos que isto NÃO é um disco de trabalho nem uma partição
 * reservada: em Linux não existe a categoria «reservado pelo sistema» com o
 * sentido que tem no Windows (a partição de arranque de 52 MB). Medido em WSL2,
 * `/mnt/d` — um `9p` sem suporte montado — reporta capacidade e livres
 * praticamente nulos com 64% de «uso»: publicar isto como volume de trabalho
 * daria um disco falso ao ecrã, e publicá-lo como «reservado pelo sistema»
 * seria uma categoria que não existe aqui. Fica de fora e é nomeado.
 */
export const CAPACIDADE_MINIMA_VOLUME_BYTES = 1024 ** 3;

/** Volume montado com capacidade medida. É a entrada de `describeDiskRead`. */
export interface VolumePosix extends RawFsEntry {
  /** `major:minor` reportado pelo kernel para este sistema de ficheiros. */
  dispositivo: string;
  fileSystem: string;
  mount: string;
  /** Só-leitura quando a MONTAGEM o declara; um `ro` do superbloco também conta. */
  readOnly: boolean;
  /** Origem do kernel (`/dev/sdd`, `C:\134`, `none`). Não é uma letra de unidade. */
  source: string;
}

export interface ResultadoMontagens {
  ok: boolean;
  volumes: VolumePosix[];
  /** Pseudo-fs excluídos — a distinção entre «não há volumes» e «não li nada». */
  excluidos: { fileSystem: string; montantes: number }[];
  /** Montagens reais cujo `statfs` falhou, com o ponto de montagem. */
  naoMedidos: string[];
  /**
   * Montagens medidas mas sem capacidade útil (ex.: um `9p` de um leitor de
   * cartões sem cartão). Não são volumes de trabalho nem «reservados pelo
   * sistema»; ficam nomeadas em vez de aparecerem como discos.
   */
  semCapacidadeUtil: string[];
  ilegiveis: number;
  reason: string | null;
}

const porMontagem = (a: VolumePosix, b: VolumePosix) => a.mount.localeCompare(b.mount);

/**
 * Lê a tabela de montagens e mede a capacidade de cada volume não-pseudo.
 *
 * A escolha da montagem representativa de um mesmo sistema de ficheiros é
 * determinística: a mais curta (por isso `/` ganha a `/home`), e os restantes
 * pontos de montagem ficam registados como montagens daquele volume — um
 * `bind` ou um `/mnt/wslg/distro` não é um disco novo.
 */
export function lerMontagensPosix(fs: MontesFsLike, caminho = CAMINHO_MOUNTINFO_PADRAO): ResultadoMontagens {
  let texto: string;
  try {
    texto = fs.readFileSync(caminho, "utf-8");
  } catch (error: unknown) {
    const detalhe = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      volumes: [],
      excluidos: [],
      naoMedidos: [],
      semCapacidadeUtil: [],
      ilegiveis: 0,
      reason: `A tabela de montagens do sistema não pôde ser lida (${detalhe}).`,
    };
  }

  const { entradas, ilegiveis } = parseMountinfo(texto);
  const contagemPseudo = new Map<string, number>();
  const porDispositivo = new Map<string, VolumePosix & { montagens: string[] }>();
  const naoMedidos: string[] = [];
  const semCapacidadeUtil: string[] = [];

  for (const entrada of entradas) {
    if (FSTYPES_NAO_VOLUME.has(entrada.fileSystem)) {
      contagemPseudo.set(entrada.fileSystem, (contagemPseudo.get(entrada.fileSystem) ?? 0) + 1);
      continue;
    }

    const anterior = porDispositivo.get(entrada.dispositivo);
    if (anterior) {
      // Mesmo `major:minor`: é o MESMO sistema de ficheiros noutro ponto.
      if (!anterior.montagens.includes(entrada.mount)) anterior.montagens.push(entrada.mount);
      if (entrada.mount.length < anterior.mount.length) {
        anterior.mount = entrada.mount;
        anterior.readOnly =
          entrada.opcoes.includes("ro") || entrada.opcoesSuperbloco.includes("ro");
      }
      continue;
    }

    let medicao: StatfsBasico | null = null;
    try {
      medicao = fs.statfsSync(entrada.mount);
    } catch {
      medicao = null;
    }
    if (!medicao) {
      naoMedidos.push(entrada.mount);
      continue;
    }

    const bsize = num(medicao.bsize);
    const blocks = num(medicao.blocks);
    const bfree = num(medicao.bfree);
    const bavail = num(medicao.bavail);
    if (!Number.isFinite(bsize) || bsize <= 0 || !Number.isFinite(blocks) || blocks <= 0) {
      naoMedidos.push(entrada.mount);
      continue;
    }
    const totalBytes = blocks * bsize;
    if (totalBytes < CAPACIDADE_MINIMA_VOLUME_BYTES) {
      // Medido, mas não é um volume utilizável: um `9p` de leitor de cartões
      // sem cartão reporta blocos quase nulos. Não é disco de trabalho e a
      // categoria Windows «reservado pelo sistema» não significa nada aqui.
      semCapacidadeUtil.push(entrada.mount);
      continue;
    }

    porDispositivo.set(entrada.dispositivo, {
      dispositivo: entrada.dispositivo,
      mount: entrada.mount,
      fileSystem: entrada.fileSystem,
      type: entrada.fileSystem,
      source: entrada.source,
      readOnly: entrada.opcoes.includes("ro") || entrada.opcoesSuperbloco.includes("ro"),
      rw: !(entrada.opcoes.includes("ro") || entrada.opcoesSuperbloco.includes("ro")),
      size: totalBytes,
      used: Math.max(0, (blocks - bfree) * bsize),
      available: Math.max(0, bavail * bsize),
      montagens: [entrada.mount],
    });
  }

  const volumes = [...porDispositivo.values()].sort(porMontagem);
  const excluidos = [...contagemPseudo.entries()]
    .map(([fileSystem, montantes]) => ({ fileSystem, montantes }))
    .sort((a, b) => b.montantes - a.montantes || a.fileSystem.localeCompare(b.fileSystem));

  if (volumes.length === 0) {
    const detalhes = [
      naoMedidos.length ? `${naoMedidos.length} sem leitura de capacidade` : null,
      semCapacidadeUtil.length ? `${semCapacidadeUtil.length} sem capacidade útil` : null,
    ]
      .filter((parte): parte is string => parte !== null)
      .join(", ");
    return {
      ok: false,
      volumes: [],
      excluidos,
      naoMedidos,
      semCapacidadeUtil,
      ilegiveis,
      reason: detalhes
        ? `Nenhum volume pôde ser medido (${detalhes}).`
        : "O sistema não reportou nenhuma montagem de armazenamento.",
    };
  }

  return { ok: true, volumes, excluidos, naoMedidos, semCapacidadeUtil, ilegiveis, reason: null };
}

/**
 * O volume que representa a máquina: em Linux é o que hospeda a raiz do sistema
 * de ficheiros, não «o mais cheio». A escolha de `disk.ts` procura uma letra
 * `C:` — em Linux não há letra nenhuma, e ficar com o volume mais cheio faria o
 * PC Center apontar para um pendrive ou para um `/mnt/c` do Windows só porque
 * estavam mais cheios que o disco do sistema. Medido em WSL2: sem esta função o
 * primário saía `/mnt/c`; com ela sai `/`.
 */
export function escolheMontagemPrincipal<T extends { mount: string }>(volumes: T[]): T | null {
  if (volumes.length === 0) return null;
  return volumes.find((volume) => volume.mount === "/") ?? volumes[0] ?? null;
}

/**
 * A fonte real, com o `/proc` de verdade. Vive AQUI e não no consumidor porque
 * é este módulo que sabe o que é uma montagem: um `statfs` lançado sobre um
 * caminho já desescapado, a ler a tabela do kernel. O motor de hardware chama
 * esta função; os testes injetam outra, e o sandbox que carrega `hardware.ts`
 * recebe um stub precisamente desta alça — nunca um acesso ao disco de quem
 * corre a suite.
 */
export function lerMontagensReais(caminho = CAMINHO_MOUNTINFO_PADRAO): ResultadoMontagens {
  return lerMontagensPosix(
    {
      readFileSync: (destino, codificacao) => fsReal.readFileSync(destino, codificacao),
      // Lançar é uma resposta legítima do `statfs` (montagem entretanto
      // desmontada, sem permissão): o módulo conta-a como «não medida».
      statfsSync: (destino) => fsReal.statfsSync(destino),
    },
    caminho,
  );
}
