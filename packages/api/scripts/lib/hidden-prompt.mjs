import { createInterface } from "node:readline";
import { createHash } from "node:crypto";

// ── Leitura de segredos sem eco ──
// Partilhado pelas ferramentas administrativas. Regras (decisão do utilizador
// de 09/10/2026, condição 5):
//   * um humano introduz a palavra-passe no terminal local, de forma
//     interativa e SEM ECO (nada é escrito no ecrã, nem máscaras);
//   * nunca é lida de variáveis de ambiente nem de argumentos da linha de
//     comandos (apareceriam no ambiente do processo / na história do shell);
//   * stdin encaminhado só é aceite com uma flag explícita, porque nesse caso
//     não existe terminal e portanto não existe eco possível;
//   * nada deste módulo escreve o segredo em stdout/stderr nem em ficheiros.

export class PromptError extends Error {}
const refuse = (message) => {
  throw new PromptError(message);
};

/**
 * Lê uma linha escondida. Exige TTY: sem terminal não há forma garantida de
 * não ecoar, e adivinhar seria pior do que falhar.
 */
export async function askHidden(promptText) {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    refuse(
      "Sem terminal interativo para ler a palavra-passe sem eco. Corre este comando num terminal (ou usa --password-stdin para automação).",
    );
  }

  process.stdout.write(promptText);
  const wasRaw = Boolean(stdin.isRaw);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  let value = "";
  try {
    value = await new Promise((resolve, reject) => {
      const done = () => stdin.off("data", onData);
      function onData(chunk) {
        for (const char of chunk) {
          if (char === "\r" || char === "\n") {
            done();
            process.stdout.write("\n");
            resolve(value);
            return;
          }
          if (char === "\u0003") {
            // Ctrl+C: cancelar sem deixar o terminal em raw mode.
            done();
            process.stdout.write("\n");
            reject(new PromptError("Introdução cancelada pelo utilizador."));
            return;
          }
          if (char === "\u007f" || char === "\b") {
            value = value.slice(0, -1);
            continue;
          }
          value += char;
        }
      }
      stdin.on("data", onData);
    });
  } finally {
    stdin.setRawMode(wasRaw);
    stdin.pause();
  }
  return value;
}

/**
 * Lê uma linha de stdin encaminhado (automação). Só deve ser usado com uma
 * flag explícita: aqui não há terminal, logo não há eco.
 */
export async function readPipedLine() {
  const reader = createInterface({ input: process.stdin, terminal: false });
  try {
    return await new Promise((resolve) => {
      reader.once("line", (line) => resolve(line));
      reader.once("close", () => resolve(""));
    });
  } finally {
    reader.close();
    process.stdin.pause();
  }
}

/** sha256 truncado: identificador estável sem revelar o segredo. */
export function fingerprint(secret) {
  return `sha256:${createHash("sha256").update(secret).digest("hex").slice(0, 12)}`;
}
