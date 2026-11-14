// Atualizações da aplicação LINUX (pacote Arch), separadas do updater Windows.
//
// O processo principal executa o comando instalado `cybersafe-linux-update`
// (scripts/linux-lite/arch/updater.mjs) sem shell, com argumentos fixos.
// Toda a validação de assinatura, versão, tamanho e SHA-256 vive nesse comando;
// aqui só se transporta o JSON e se aplicam timeouts. `install` exige
// consentimento explícito do renderer e é concluída pelo pacman via polkit.
import { execFile } from "node:child_process";

export const LINUX_UPDATE_BINARY = "/usr/bin/cybersafe-linux-update";
export type LinuxUpdateCommand = "check" | "download" | "install";

const TIMEOUTS: Record<LinuxUpdateCommand, number> = {
  check: 30_000,
  download: 30 * 60_000,
  install: 45 * 60_000, // inclui a espera pela autorização do utilizador
};

export interface LinuxUpdateWire {
  ok: boolean;
  result: Record<string, unknown> | null;
  error?: "not-linux" | "consent-required" | "not-installed" | "timeout" | "invalid-response";
}

type ExecFile = typeof execFile;

export function runLinuxUpdate(
  command: LinuxUpdateCommand,
  consent: boolean,
  platform: NodeJS.Platform = process.platform,
  exec: ExecFile = execFile,
): Promise<LinuxUpdateWire> {
  if (platform !== "linux") return Promise.resolve({ ok: false, result: null, error: "not-linux" });
  if (!(command in TIMEOUTS)) return Promise.resolve({ ok: false, result: null, error: "invalid-response" });
  if (command === "install" && consent !== true) return Promise.resolve({ ok: false, result: null, error: "consent-required" });
  const args = command === "install" ? ["install", "--consent"] : [command];
  return new Promise((resolve) => {
    exec(LINUX_UPDATE_BINARY, args, { timeout: TIMEOUTS[command], maxBuffer: 1 << 20, env: { ...process.env, LC_ALL: "C.UTF-8" } },
      (error, stdout) => {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        if (code === "ENOENT") return resolve({ ok: false, result: null, error: "not-installed" });
        if ((error as { killed?: boolean } | null)?.killed) return resolve({ ok: false, result: null, error: "timeout" });
        // O comando escreve JSON também em falhas (estado error/invalid); a
        // última linha JSON é a resposta (o pkexec/pacman pode escrever antes).
        const line = String(stdout ?? "").trim().split("\n").reverse().find((l) => l.startsWith("{"));
        try {
          const parsed = line ? JSON.parse(line) : null;
          if (!parsed || typeof parsed !== "object" || parsed.schema !== 1) return resolve({ ok: false, result: null, error: "invalid-response" });
          resolve({ ok: !error, result: parsed });
        } catch {
          resolve({ ok: false, result: null, error: "invalid-response" });
        }
      });
  });
}
