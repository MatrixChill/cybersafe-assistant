/**
 * Decisões puras do instalador do serviço Windows (node-windows).
 *
 * DEFEITO MEDIDO NO PROCEDIMENTO: `src/windows-service.ts` registava o serviço
 * com `script = src/index.ts` e `--import=tsx`. Uma instalação a partir de uma
 * árvore de código cria um serviço que aponta para um ficheiro de TypeScript e
 * para uma árvore que pode ser movida/apagada — o SCM fica a tentar arrancar um
 * caminho inexistente (Event ID 7000) para sempre.
 *
 * Estas funções não tocam no SCM: recebem o estado observado e devolvem uma
 * decisão. O CLI só instala/desinstala quando a decisão permite, e a
 * desinstalação só remove um serviço cujo ImagePath pertence à raiz instalada.
 */
import path from "node:path";

export const WINDOWS_SERVICE_NAME = "CyberSafe Engine";

export interface ExistingService {
  name: string;
  imagePath: string | null;
}

export type ServicePlan =
  | { ok: true; scriptPath: string }
  | { ok: false; reason: string };

export type ServiceDecision = { ok: true } | { ok: false; reason: string };

function normalize(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** `target` está dentro de `root` (ou é o próprio root)? */
export function isInsideRoot(root: string, target: string): boolean {
  const rel = path.relative(normalize(root), normalize(target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Raiz de desenvolvimento: nunca serve para registar um serviço. */
export function looksLikeSourceRoot(root: string): boolean {
  return /(^|[\\/])packages[\\/]service[\\/]src($|[\\/])/i.test(root) || /(^|[\\/])Downloads([\\/]|$)/i.test(root);
}

/**
 * Resolve o entry point empacotado. Só `dist/index.js` (ou `.exe`) dentro da
 * raiz instalada, existente, e nunca um ficheiro `.ts`/árvore de código.
 */
export function resolvePackagedServiceScript(
  installRoot: string | null | undefined,
  exists: (file: string) => boolean,
): ServicePlan {
  const root = (installRoot ?? "").trim();
  if (!root) return { ok: false, reason: "CYBERSAFE_SERVICE_INSTALL_ROOT não está definido" };
  if (!path.isAbsolute(root)) return { ok: false, reason: "CYBERSAFE_SERVICE_INSTALL_ROOT tem de ser absoluto" };
  if (looksLikeSourceRoot(root)) return { ok: false, reason: "raiz de desenvolvimento não pode registar um serviço" };
  const scriptPath = path.join(root, "dist", "index.js");
  const extension = path.extname(scriptPath).toLowerCase();
  if (extension === ".ts") return { ok: false, reason: "entry point TypeScript não é um serviço válido" };
  if (extension !== ".js" && extension !== ".exe") return { ok: false, reason: "entry point tem de ser .js ou .exe" };
  if (!isInsideRoot(root, scriptPath)) return { ok: false, reason: "entry point fora da raiz instalada" };
  if (!exists(scriptPath)) return { ok: false, reason: `entry point inexistente: ${scriptPath}` };
  return { ok: true, scriptPath };
}

/**
 * Instalação: exige plataforma Windows, identidade canónica e ausência de
 * conflito (um serviço com o mesmo nome a apontar para fora da raiz).
 */
export function decideInstall(input: {
  platform: NodeJS.Platform;
  installRoot: string | null | undefined;
  scriptPath: string;
  exists: (file: string) => boolean;
  existing: ExistingService | null;
}): ServiceDecision {
  if (input.platform !== "win32") return { ok: false, reason: "serviço Windows só existe em win32" };
  if (path.extname(input.scriptPath).toLowerCase() === ".ts") {
    return { ok: false, reason: "entry point TypeScript não é um serviço válido" };
  }
  const plan = resolvePackagedServiceScript(input.installRoot, input.exists);
  if (!plan.ok) return plan;
  if (normalize(plan.scriptPath) !== normalize(input.scriptPath)) {
    return { ok: false, reason: "script não corresponde ao entry point empacotado validado" };
  }
  const existing = input.existing;
  if (existing) {
    if (existing.name !== WINDOWS_SERVICE_NAME) return { ok: false, reason: "identidade do serviço divergente" };
    if (!existing.imagePath) return { ok: false, reason: "registo existente sem ImagePath legível" };
    if (!isInsideRoot(String(input.installRoot), existing.imagePath)) {
      return { ok: false, reason: "já existe um serviço com este nome a apontar para outro caminho" };
    }
  }
  return { ok: true };
}

/**
 * Desinstalação: só remove o serviço quando o ImagePath pertence à raiz
 * instalada. Sem ImagePath legível, não se assume posse.
 */
export function decideUninstall(input: {
  platform: NodeJS.Platform;
  installRoot: string | null | undefined;
  existing: ExistingService | null;
}): ServiceDecision & { alreadyAbsent?: boolean } {
  if (input.platform !== "win32") return { ok: false, reason: "serviço Windows só existe em win32" };
  const root = (input.installRoot ?? "").trim();
  if (!root || !path.isAbsolute(root)) return { ok: false, reason: "raiz instalada não validada" };
  if (!input.existing) return { ok: true, alreadyAbsent: true };
  if (input.existing.name !== WINDOWS_SERVICE_NAME) return { ok: false, reason: "identidade do serviço divergente" };
  if (!input.existing.imagePath) return { ok: false, reason: "ImagePath ausente: posse não provada" };
  if (!isInsideRoot(root, input.existing.imagePath)) {
    return { ok: false, reason: "serviço não pertence a esta instalação" };
  }
  return { ok: true };
}
