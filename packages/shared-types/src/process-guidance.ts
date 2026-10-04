/**
 * WS-4 — orientacao honesta sobre um processo, no Gestao de Tarefas.
 *
 * O utilizador tem de conseguir responder, para cada processo, a tres
 * perguntas sem abrir outra aplicacao:
 *   O QUE E ESTE PROCESSO?
 *   E SEGURO FECHAR?
 *   PORQUE MERECE ATENCAO?
 *
 * Funcao PURA e deterministica: sem fetch, sem IPC, sem estado, sem data de
 * hoje, sem Math.random. A mesma entrada da sempre a mesma saida.
 *
 * As regras de honestidade nao sao sugestoes, sao o contrato:
 *   R1 CPU alta SOZINHA nunca produz urgent. No maximo worth-noting.
 *   R2 signer ausente nunca e ameaca nem sobe a prioridade.
 *   R3 nome desconhecido nunca e suspeito.
 *   R4 trusted untrusted e o unico sinal que justifica urgent, e medido.
 *   R5 pid <= 100 ou nome protegido => safeToClose "protected".
 *   R6 nunca inventar numero: falta de dado escreve-se, nao estima-se.
 *
 * Fica em shared-types porque @cybersafe/app so pode importar de la.
 */
import type { ProcessSnapshot } from "./index.js";

export type ProcessPriority = "none" | "worth-noting" | "urgent";
export type SafeToClose = "safe" | "risky" | "protected";

export interface ProcessGuidance {
  /** PT-PT: o que e. */
  what: string;
  /** Categoria curta. */
  role: string;
  safeToClose: SafeToClose;
  safeToCloseReason: string;
  priority: ProcessPriority;
  /** DADO — o que foi medido, com numero. */
  evidence: string[];
  /** SIGNIFICADO — o que esse numero significa em portugues simples. */
  meaning: string;
  /** ORIENTACAO — o que fazer, em uma frase. */
  guidance: string;
}

/**
 * Processos de que o Windows precisa para funcionar. Espelha a lista de
 * protegidos que a pagina ja usava e a lista de seguras do service
 * (engine.ts SAFE_PROCESSES). Nao e uma lista de "programas bons": e uma
 * lista de "isto e do sistema, mexer aqui parte coisas".
 */
export const PROTECTED_PROCESS_NAMES: readonly string[] = [
  "svchost.exe",
  "explorer.exe",
  "csrss.exe",
  "lsass.exe",
  "wininit.exe",
  "services.exe",
  "smss.exe",
  "winlogon.exe",
  "dwm.exe",
  "sihost.exe",
  "fontdrvhost.exe",
  "runtimebroker.exe",
  "searchhost.exe",
  "startmenuexperiencehost.exe",
  "textinputhost.exe",
  "ctfmon.exe",
  "dllhost.exe",
  "audiodg.exe",
  "spoolsv.exe",
];

/** Ferramentas e aplicacoes com nome reconhecido, para R3. */
const KNOWN_NAMES: readonly string[] = [
  "powershell.exe",
  "pwsh.exe",
  "cmd.exe",
  "conhost.exe",
  "msiexec.exe",
  "searchindexer.exe",
  "securityhealthservice.exe",
  "msedge.exe",
  "chrome.exe",
  "firefox.exe",
  "code.exe",
  "node.exe",
  "tsx.exe",
  "electron.exe",
  "vite.exe",
  "npm.cmd",
  "npx.cmd",
  "git.exe",
  "wt.exe",
  "windowsterminal.exe",
  "systemsettings.exe",
  "taskmgr.exe",
  "devenv.exe",
  "msbuild.exe",
  "notepad.exe",
  "calc.exe",
  "mspaint.exe",
  "explorer.exe",
];

/** Numero medido, ou undefined. R6: nunca inventar valor. */
function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Percentagem com uma casa, ou n/d. R6: falta de dado escreve-se. */
function pct(value: unknown): string {
  const n = num(value);
  return n === undefined ? "n/d" : n.toFixed(1).replace(/\.0$/, "") + "%";
}

/** Memoria em MB arredondada, ou n/d. */
function mb(value: unknown): string {
  const n = num(value);
  return n === undefined ? "n/d" : String(Math.round(n));
}

function lower(name: unknown): string {
  return typeof name === "string" ? name.toLowerCase() : "";
}

export function isProtectedProcess(p: Pick<ProcessSnapshot, "pid" | "name">): boolean {
  return p.pid <= 100 || PROTECTED_PROCESS_NAMES.includes(lower(p.name));
}

export function buildProcessGuidance(p: ProcessSnapshot): ProcessGuidance {
  const name = typeof p.name === "string" && p.name.length > 0 ? p.name : "processo sem nome";
  const nomeBaixo = lower(name);
  const protegido = isProtectedProcess(p);
  const nomeConhecido = KNOWN_NAMES.includes(nomeBaixo);

  // ── DADO ────────────────────────────────────────────────────────────────
  const evidence: string[] = [
    `Nome: ${name}`,
    `PID: ${num(p.pid) ?? "n/d"}`,
    `CPU: ${pct(p.cpu)}`,
    `Memoria: ${mb(p.memoryMb)} MB`,
  ];

  // R6: signer ausente é dito como ausente. Nunca preenchido com um valor.
  evidence.push(p.signer ? `Assinatura: ${p.signer}` : "Assinatura: sem assinatura disponível");
  evidence.push(`Confiança do motor: ${p.trusted}`);

  if (typeof p.path === "string" && p.path.length > 0) {
    evidence.push(`Caminho: ${p.path}`);
  }

  // ── PRIORIDADE ─────────────────────────────────────────────────────────
  // R1: CPU alta sozinha nunca chega a urgent. Entra so como "vale a pena ver".
  // R2/R3: signer ausente e nome desconhecido NUNCA sobem a prioridade.
  // R4: trusted untrusted e o unico caminho para urgent.
  const cpuAlta = (num(p.cpu) ?? 0) > 80;
  const prioridade: ProcessPriority =
    p.trusted === "untrusted" ? "urgent" : cpuAlta ? "worth-noting" : "none";

  // ── SIGNIFICADO ────────────────────────────────────────────────────────
  const cpuNum = num(p.cpu);
  let meaning: string;

  if (cpuAlta) {
    // R1: a leitura honesta. Carga alta é, quase sempre, trabalho a acontecer.
    meaning =
      `Usa ${pct(p.cpu)} do processador neste momento. Carga alta costuma ser trabalho normal ` +
      `a acontecer — um jogo, uma compilação, uma conversão de vídeo — e por si só não diz nada ` +
      `sobre o que o programa está a fazer.`;
  } else if (cpuNum !== undefined && cpuNum > 20) {
    meaning = `Usa ${pct(p.cpu)} do processador. Carga moderada, sem nada de anormal por aqui.`;
  } else {
    meaning = `Usa ${pct(p.cpu)} do processador. Carga baixa, o que é normal para a maioria dos programas.`;
  }

  // R2: a nota é neutra e diz o que não prova. Nunca uma acusação.
  meaning +=
    p.signer === undefined || p.signer === null || p.signer === ""
      ? " Não há assinatura disponível, e isso não prova nada sobre o comportamento: muitos programas legítimos não vêm assinados."
      : "";

  // R3: nome desconhecido não é suspeito. Dizemos o que não sabemos e o que
  // realmente permite concluir alguma coisa.
  if (!nomeConhecido && !protegido) {
    meaning +=
      " O nome não é reconhecido, o que também não prova nada por si só: o que permite avaliar é o caminho do ficheiro e a assinatura.";
  }

  // ── O QUE E ────────────────────────────────────────────────────────────
  const role = protegido
    ? "processo do sistema"
    : p.trusted === "untrusted"
      ? "programa sem confiança confirmada"
      : p.trusted === "trusted"
        ? "programa reconhecido"
        : nomeConhecido
          ? "programa comum"
          : "programa não identificado";

  const what = protegido
    ? `${name} é um processo do Windows de que o sistema precisa.`
    : nomeConhecido
      ? `${name} é um programa com nome reconhecido.`
      : `Não reconheci o nome ${name}. Isso não prova nada: o que permite avaliar é o caminho do ficheiro e a assinatura.`;

  // ── É SEGURO FECHAR ────────────────────────────────────────────────────
  let safeToClose: SafeToClose;
  let safeToCloseReason: string;
  let guidance: string;

  if (protegido) {
    // R5
    safeToClose = "protected";
    safeToCloseReason =
      "É um processo de que o Windows precisa. Encerrar pode provocar instabilidade no sistema.";
    guidance = "Não encerrar. Se o sistema estiver lento, o responsável costuma ser outro.";
  } else if (p.trusted === "untrusted") {
    // R4: linguagem medida. Não escrevemos "malware garantido".
    safeToClose = "risky";
    safeToCloseReason =
      "O motor não conseguiu confirmar a origem deste programa. Isso é um sinal a rever, não uma prova de que é malware.";
    guidance =
      "Vale a pena investigar antes de encerrar: confirma de onde veio o programa e o que está a fazer. Não há urgência em fechar.";
  } else {
    safeToClose = "safe";
    safeToCloseReason =
      "Não há nada no que foi medido que impeça o encerramento. Encerrar um programa só fecha esse programa.";
    guidance = "Pode encerrar se não estiver a fazer nada de que precisa.";
  }

  // O que o utilizador deve fazer, com uma frase. A prioridade manda no tom.
  if (prioridade === "urgent") {
    guidance = "Investigue este programa: confirme a origem e o que está a fazer antes de decidir.";
  } else if (prioridade === "worth-noting") {
    guidance = "Nada de urgente aqui. Se quiser, veja se a carga alta corresponde a algum trabalho a correr.";
  } else {
    guidance = "Não precisa de fazer nada com este processo.";
  }
  if (safeToClose === "protected") {
    guidance = "Não encerrar. Se o sistema estiver lento, o responsável costuma ser outro.";
  }

  return { what, role, safeToClose, safeToCloseReason, priority: prioridade, evidence, meaning, guidance };
}
