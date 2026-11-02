import path from 'node:path';

/** Raios que nunca podem ser isolados automaticamente pelo produto. */
export interface QuarantinePathContext {
  baseDir: string;
  execPath?: string;
  env?: NodeJS.ProcessEnv;
}

// Linux: caminhos são sensíveis a maiúsculas; Windows mantém a normalização
// case-insensitive histórica. A função é a única diferença entre plataformas.
const isCaseInsensitivePlatform = (): boolean => process.platform !== 'linux';
const norm = (value: string): string => {
  const resolved = path.resolve(value).replace(/[\/]+$/, '');
  return isCaseInsensitivePlatform() ? resolved.toLowerCase() : resolved;
};
const under = (candidate: string, root: string): boolean =>
  candidate === root || candidate.startsWith(`${root}${path.sep}`);

/** Raízes de sistema fixas protegidas no Linux (nunca `/`, que anularia tudo). */
export const LINUX_PROTECTED_ROOTS = [
  '/usr', '/etc', '/boot', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32',
  '/run', '/sys', '/proc', '/dev',
] as const;

export function protectedQuarantineRoots(context: QuarantinePathContext): string[] {
  const env = context.env ?? process.env;
  const roots = [
    env.WINDIR,
    env.SystemRoot,
    env.ProgramFiles,
    env['ProgramFiles(x86)'],
    env.ProgramData,
    context.baseDir,
    context.execPath ? path.dirname(context.execPath) : undefined,
    ...(process.platform === 'linux' ? LINUX_PROTECTED_ROOTS : []),
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  return [...new Set(roots.map(norm))];
}

/**
 * Recusa caminhos essenciais do Windows, da instalação e do CyberSafe.
 * A comparação é lexical e normalizada; a verificação de reparse points é
 * feita no serviço com `realpath`, porque só o filesystem a pode provar.
 */
export function isProtectedQuarantinePath(filePath: string, context: QuarantinePathContext): boolean {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) return true;
  const candidate = norm(filePath);
  return protectedQuarantineRoots(context).some((root) => under(candidate, root));
}

/** O ficheiro e os seus antepassados não podem ser redirecionados por link/junction. */
export async function hasReparseFreePath(filePath: string): Promise<boolean> {
  try {
    const fs = await import('node:fs/promises');
    const resolved = path.resolve(filePath);
    const real = await fs.realpath(resolved);
    return norm(real) === norm(resolved);
  } catch {
    return false;
  }
}

/**
 * Normalização de um ponto de montagem. Não é a `norm` de cima: `norm` tira a
 * barra final sem reserva, e em Linux a raiz É `/` — `norm('/')` produz `''`,
 * que é exatamente o prefixo que faria «tudo está montado». Aqui a raiz
 * continua a ser `/`. Sem case folding: em Linux `A` e `a` são montagens
 * diferentes, e uma tabela de montagens lida com `/` não é um caminho Windows.
 */
const normMountPoint = (value: string): string => {
  const semBarraFinal = value.replace(/\/+$/, '');
  return semBarraFinal === '' ? '/' : semBarraFinal;
};

/**
 * O caminho é um ponto de montagem? A resposta usa só igualdade EXATA, nunca
 * prefixo, e isso é a razão de existir da função.
 *
 * Um ponto de montagem não é um ficheiro dentro do volume: é o volume. Mover
 * `/media/utilizador/pen` para a quarentena não retira um ficheiro do disco —
 * retira o disco do sistema, e um `rename` sobre ele ou arrasta a árvore toda
 * ou falha consoante o que estiver montado por cima. O §10 acabou de permitir
 * analisar um volume montado, por isso o produto passou a conhecer caminhos que
 * são montagens; a política de quarentena tem de os recusar.
 *
 * Igualdade e não prefixo porque `/` está na tabela de qualquer máquina: uma
 * comparação por prefixo diria que todo o ficheiro do mundo é uma montagem e
 * desligava o isolamento. A proteção dos diretórios por cima de uma montagem
 * vem de outra regra — o `isProtectedQuarantinePath` para as raízes de sistema,
 * e o `EXDEV`/`EPERM` do próprio sistema de ficheiros para o resto.
 *
 * É uma função pura sobre uma tabela fornecida: a tabela lê-se no serviço (só
 * em POSIX faz sentido), os testes entram com uma inventada.
 */
export function isMountPointPath(filePath: string, mountPoints: readonly string[]): boolean {
  if (typeof filePath !== 'string' || !filePath.startsWith('/')) return false;
  const candidato = normMountPoint(filePath);
  return mountPoints.some((mount) => normMountPoint(mount) === candidato);
}
