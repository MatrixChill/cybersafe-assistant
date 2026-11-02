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
