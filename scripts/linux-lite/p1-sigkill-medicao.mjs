/**
 * Medição em Linux real (WSL2) do SIGTERM/SIGKILL separados pelo bilhete.
 *
 * Alvo: um processo benigno criado aqui, que IGNORA SIGTERM — é o único cenário
 * que distingue as duas operações. Nada é apagado nem formatado; o único sinal
 * enviado é para o PID que este script criou.
 *
 * Corre a partir da raiz da cópia do repo no Linux, usando o `dist` compilado.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { SafeProcessTermination, abrirLeasePosixTerminacao, modosTerminacao } from "@cybersafe/core";
import { PosixProcessProvider } from "@cybersafe/core";

const vivo = (pid) => {
  try { readFileSync(`/proc/${pid}/stat`, "utf8"); return true; } catch { return false; }
};
const resultado = [];
const provider = new PosixProcessProvider();

async function alvoBenigno() {
  const filho = spawn("/bin/bash", ["-c", 'trap "" TERM INT HUP; i=0; while [ $i -lt 600 ]; do i=$((i+1)); sleep 0.2; done'], { stdio: "ignore" });
  const pid = filho.pid;
  for (let espera = 0; espera < 100 && !vivo(pid); espera += 1) await new Promise(r => setTimeout(r, 20));
  return { pid, filho };
}

function controlador(modes) {
  const eventos = [];
  const constantes = provider.constantes();
  if (!constantes?.hz || constantes.bootMs === null) throw new Error("constantes do kernel indisponíveis; nada foi medido");
  const controller = new SafeProcessTermination({
    modes,
    open: (pid, mode) => abrirLeasePosixTerminacao(pid, {
      hz: constantes.hz,
      bootMs: constantes.bootMs,
      signal: mode === "sigkill" ? "SIGKILL" : "SIGTERM",
      protegido: () => false,
    }),
    blocked: () => null,
    audit: (e) => eventos.push(e),
  });
  return { controller, eventos };
}

async function caso(nome, { modes, pedido, esperado }) {
  const { pid, filho } = await alvoBenigno();
  const identidade = provider.list().find(p => p.pid === pid);
  const { controller, eventos } = controlador(modes);
  const preparado = controller.prepare({ pid, startedAt: identidade?.startedAt, ...(pedido ? { mode: pedido } : {}) });
  let linha = { caso: nome, pid, modos: modes, pedido: pedido ?? "(ausente)", preparado: preparado.ok ? `ok/${preparado.mode}` : `recusa: ${preparado.error}` };
  if (preparado.ok) {
    const confirmado = await controller.confirm(preparado.ticket);
    linha.confirmado = `${confirmado.status}${confirmado.success ? "" : " (insucesso declarado)"} · sinal=${confirmado.signal ?? "?"} · prova=${confirmado.confirmation ?? "?"}`;
    linha.auditoria = eventos.map(e => `${e.status}/${e.signal}`).join(",");
  }
  await new Promise(r => setTimeout(r, 120));
  linha.processoVivoDepois = vivo(pid);
  linha.veredicto = linha.processoVivoDepois === esperado.vivo && (linha.confirmado ?? linha.preparado).includes(esperado.texto) ? "CONFORME" : "DIVERGENTE";
  resultado.push(linha);
  if (vivo(pid)) filho.kill("SIGKILL");
  await new Promise(r => r());
}

// O ambiente anuncia os modos da plataforma; `null` = sem declaração (default).
await caso("SIGTERM num processo que o ignora", { modes: modosTerminacao("linux"), pedido: undefined, esperado: { texto: "timeout", vivo: true } });
await caso("escalada SIGKILL confirmada separadamente", { modes: modosTerminacao("linux"), pedido: "sigkill", esperado: { texto: "killed", vivo: false } });
await caso("plataforma só com SIGTERM recusa o pedido", { modes: ["sigterm"], pedido: "sigkill", esperado: { texto: "recusa", vivo: true } });
await caso("modo mal formado é recusado", { modes: modosTerminacao("linux"), pedido: "SIGKILL", esperado: { texto: "recusa", vivo: true } });

console.log(JSON.stringify({ ambiente: `${process.platform} ${process.release?.name}`, uid: process.getuid?.(), hz: provider.constantes()?.hz, casos: resultado }, null, 1));
process.exit(0);
