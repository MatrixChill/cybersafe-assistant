// Mede o bilhete de terminação POSIX contra o /proc REAL e com sinais reais.
//
// O que isto cobre: a composição exacta que o motor faz — `abrirLeasePosixTerminacao`
// + `SafeProcessTermination` + o predicado de proteção do serviço — sobre
// processos verdadeiros. O que NÃO cobre: a camada de socket/auth do pipe, que é
// medida à parte (ver `p1-process-termination.md`). Dizer o contrário seria
// passar uma medição por outra.
import { openSync, readFileSync, existsSync } from "node:fs";
import {
  PosixProcessProvider,
  abrirLeasePosixTerminacao,
  SafeProcessTermination,
  classifyKillTarget,
  exactCreationStamp,
} from "@cybersafe/core";

const provider = new PosixProcessProvider();
const cadeia = provider.cadeiaIdentia();
console.log("CASE cadeia " + JSON.stringify(cadeia));
if (!cadeia.ok) process.exit(1);
const { hz, bootMs } = provider.constantes();

const alvo = Number(process.argv[2]);       // benigno a terminar
const intacto = Number(process.argv[3]);    // benigno que NÃO pode ser tocado
const auditados = [];
const abridor = (pid) => abrirLeasePosixTerminacao(pid, {
  hz, bootMs,
  protegido: (identidade, caminho) => {
    if (pidAlvoProtegido(identidade, caminho)) return true;
    return false;
  },
});
function pidAlvoProtegido(identidade, caminho) {
  const contexto = {
    selfPid: process.pid,
    ancestorPids: [],
    internalPaths: [],
    fallbackNames: [],
    systemPidThreshold: 4,
  };
  return classifyKillTarget(
    { pid: identidade.pid, ppid: identidade.ppid, name: identidade.comm, path: caminho },
    contexto,
  ) !== null;
}
const controlador = new SafeProcessTermination({
  open: abridor,
  blocked: () => null,
  audit: (evento) => auditados.push({ pid: evento.pid, status: evento.status, confirm: evento.source }),
});
const vivo = (pid) => existsSync("/proc/" + pid);
const linha = (pid) => provider.list().find((l) => l.pid === pid);

// 1) A linha real tem de ser aceite pelo contrato de criação partilhado.
const a = linha(alvo);
console.log("CASE linha_real " + JSON.stringify({
  pid: a?.pid, name: a?.name, startedAt: a?.startedAt, seteCasas: !!a && /\.\d{7}Z$/.test(a.startedAt),
  creation_parseavel: a ? exactCreationStamp(a.startedAt) !== null : null,
}));

// 2) prepare + confirm legítimos: o alvo morre, o irmão não é tocado.
const prep = controlador.prepare({ pid: alvo, startedAt: a.startedAt });
console.log("CASE prepare " + JSON.stringify(prep.ok
  ? { ok: true, alvo: prep.target }
  : prep));
if (!prep.ok) process.exit(1);
const conf = await controlador.confirm(prep.ticket);
console.log("CASE confirm " + JSON.stringify(conf));
await new Promise((r) => setTimeout(r, 300));
console.log("CASE efeito_alvo vivo=" + vivo(alvo) + " esperado=false");
console.log("CASE efeito_irmao vivo=" + vivo(intacto) + " esperado=true");
console.log("CASE audit " + JSON.stringify(auditados));

// 3) O mesmo bilhete não pode ser confirmado duas vezes.
const repete = await controlador.confirm(prep.ticket);
console.log("CASE confirm_repetido " + JSON.stringify({ ok: repete.success, status: repete.status }));

// 4) PID 1: tem de recusar sem efeito nenhum.
const linha1 = linha(1);
const prep1 = controlador.prepare({ pid: 1, startedAt: linha1?.startedAt ?? "" });
console.log("CASE prepare_pid1 " + JSON.stringify(prep1));
console.log("CASE efeito_pid1 vivo=" + vivo(1));

// 5) PID de outro utilizador (ou privilegiado): recusa, sem sinal.
const externo = provider.list().filter((l) => l.user && !l.user.startsWith("uid:") && l.user !== os_user());
function os_user() {
  const st = readFileSync("/proc/self/status", "utf-8");
  const uid = Number(/^Uid:\t(\d+)/m.exec(st)[1]);
  const passwd = readFileSync("/etc/passwd", "utf-8");
  const linha = passwd.split("\n").find((l) => Number(l.split(":")[2]) === uid);
  return linha ? linha.split(":")[0] : String(uid);
}
if (externo.length) {
  const alvoExterno = externo.find((l) => l.pid > 100) ?? externo[0];
  const prepExt = controlador.prepare({ pid: alvoExterno.pid, startedAt: alvoExterno.startedAt });
  console.log("CASE prepare_outro_utilizador " + JSON.stringify({
    pid: alvoExterno.pid, user: alvoExterno.user, ok: prepExt.ok, status: prepExt.status, error: prepExt.error ?? null,
  }));
} else {
  console.log("CASE prepare_outro_utilizador NENHUMA_LINHA_DE_OUTRO_UID");
}

// 6) Instante de criação adulterado: o bilhete não é emitido.
const b = linha(intacto);
const mau = b.startedAt.replace(/(\d)0000Z$/, (_s, d) => String((Number(d) + 1) % 10) + "0000Z");
const prepMau = controlador.prepare({ pid: intacto, startedAt: mau });
console.log("CASE prepare_starttime_adulterado " + JSON.stringify({ ok: prepMau.ok, status: prepMau.status, error: prepMau.error ?? null }));
console.log("CASE efeito_irmao_apres_adulterado vivo=" + vivo(intacto) + " esperado=true");

// 7) PID que não existe: «já saiu», nunca sucesso de terminação.
const prepFantasma = controlador.prepare({ pid: 4000099, startedAt: "2020-01-01T00:00:00.0000000Z" });
console.log("CASE prepare_fantasma " + JSON.stringify({ ok: prepFantasma.ok, status: prepFantasma.status, error: prepFantasma.error ?? null }));

process.exit(0);
