import path from 'node:path';

/** Raios que nunca podem ser isolados automaticamente pelo produto. */
export interface QuarantinePathContext {
  baseDir: string;
  execPath?: string;
  env?: NodeJS.ProcessEnv;
}

const norm = (value: string): string => path.resolve(value).replace(/[\/]+$/, '').toLowerCase();
const under = (candidate: string, root: string): boolean =>
  candidate === root || candidate.startsWith(`${root}${path.sep}`);

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
