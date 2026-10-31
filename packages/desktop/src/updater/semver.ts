/**
 * Comparador semver mínimo (subset de SemVer 2.0.0), puro e sem dependências.
 *
 * Porque não usar o `semver` do `node_modules`: ele só existe como dependência
 * TRANSITIVA (via electron-builder), não é dep declarada do `desktop`; confiar
 * numa hoisted transitive é frágil e seria uma dependência não assumida. Uma
 * comparação de versões de update é pequena e auditável — implementa-se cá e
 * testa-se. Isto não adiciona dependências novas (regra da tarefa).
 *
 * Regras cobertas: MAJOR.MINOR.PATCH, pré-lançamento (`-alpha.1`) precede o
 * lançamento, identificadores numéricos ordenam por valor e < alfanuméricos,
 * metadados de build (`+...`) IGNORADOS na precedência. Devolve -1/0/1.
 */

export interface ParsedSemVer {
  major: number;
  minor: number;
  patch: number;
  /** Identificadores de pré-lançamento; `[]` quando é lançamento estável. */
  prerelease: string[];
  build: string[];
}

const CORE = /^\d+\.\d+\.\d+$/;
const FULL =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export function isValidSemVer(value: string): boolean {
  return typeof value === "string" && FULL.test(value);
}

/** Devolve `null` para entrada fora do formato — nunca tenta "adivinhar". */
export function parseSemVer(value: string): ParsedSemVer | null {
  if (typeof value !== "string") return null;
  const match = FULL.exec(value);
  if (!match) return null;
  const [, major, minor, patch, pre, build] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: pre ? pre.split(".") : [],
    build: build ? build.split(".") : [],
  };
}

/** Aceita só o núcleo `X.Y.Z` (sem pré/metadados) — usado como validação estrita. */
export function isCoreVersion(value: string): boolean {
  return typeof value === "string" && CORE.test(value);
}

function comparePrereleaseIdentifier(a: string, b: string): number {
  const aNum = /^\d+$/.test(a);
  const bNum = /^\d+$/.test(b);
  if (aNum && bNum) {
    const an = Number(a);
    const bn = Number(b);
    return an < bn ? -1 : an > bn ? 1 : 0;
  }
  // numérico < alfanumérico (por definição do SemVer)
  if (aNum) return -1;
  if (bNum) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparePrerelease(a: string[], b: string[]): number {
  // Sem pré-lançamento tem PRIORIDADE maior do que com pré-lançamento.
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (i >= a.length) return -1; // [a] é prefixo de [b] → menor
    if (i >= b.length) return 1;
    const cmp = comparePrereleaseIdentifier(a[i], b[i]);
    if (cmp !== 0) return cmp;
  }
  return 0;
}

/** Comparação de precedência SemVer; lança se qualquer lado for inválido. */
export function compareSemVer(left: string, right: string): number {
  const a = parseSemVer(left);
  const b = parseSemVer(right);
  if (!a || !b) {
    throw new Error(`versão semver inválida: ${!a ? left : right}`);
  }
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

/** `candidate` é estritamente mais recente que `current`. */
export function isUpgrade(candidate: string, current: string): boolean {
  return compareSemVer(candidate, current) > 0;
}

/** `candidate` é estritamente mais antigo que `current` (downgrade). */
export function isDowngrade(candidate: string, current: string): boolean {
  return compareSemVer(candidate, current) < 0;
}
