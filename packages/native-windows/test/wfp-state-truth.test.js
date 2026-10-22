import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { WfpFilter } from "../dist/wfp-filter.js";

/**
 * VERDADE DE ESTADO do filtro de rede.
 *
 * O que estava mal: `active = true` era escrito quando o processo PowerShell
 * terminava sem código de erro, e `isActive()` era depois apresentado como
 * "filtro WFP ativo". Isso não é uma medição do Windows — é o resultado de um
 * `await`. E um `catch` que não usava o erro deitava fora a única informação
 * que diria PORQUE NÃO está ativo.
 *
 * O que estes testes exigem:
 * - uma instância fresca diz `nao_iniciado`, não `inativo por razão X`;
 * - `falhou` conserva a causa, sanitizada (sem caminhos de utilizador);
 * - o código de saída NÃO confirma estado: sem leitura de volta fica
 *   `solicitado_nao_verificado`, nunca `ativo_confirmado`;
 * - só um read-back injectado e verdadeiro produz `ativo_confirmado`.
 *
 * Nenhum teste executa PowerShell: o executor e o read-back são injectados.
 * Não há `New-`/`Set-`/`Remove-NetFirewallRule` reais aqui, nem leitura do
 * firewall do host.
 */

/** Executor falso: regista chamadas e decide sucesso/falha. */
function executorFalso({ falharCom = null } = {}) {
  const chamadas = [];
  return {
    chamadas,
    async executar(comando) {
      chamadas.push(String(comando));
      if (falharCom) {
        throw Object.assign(new Error(falharCom), { name: "CommandFailed" });
      }
      return { stdout: "", stderr: "" };
    },
  };
}

describe("WfpFilter.estado() — origem do estado, não código de saída", () => {
  test("instância fresca publica nao_iniciado, sem inventar causa", async () => {
    const f = new WfpFilter();
    const estado = f.estado();
    assert.equal(estado.estado, "nao_iniciado");
    assert.equal(estado.motivo, undefined, "ausência de tentativa não é uma falha");
    assert.equal(f.isActive(), false);
  });

  test("falha conserva a causa e nunca revela caminhos pessoais", async () => {
    const exe = executorFalso({ falharCom: "Acesso negado ao abrir C:\\Users\\caioc\\ficheiro.txt" });
    const f = new WfpFilter({ executar: exe.executar });
    await f.start();
    const estado = f.estado();
    assert.equal(estado.estado, "falhou");
    assert.equal(typeof estado.motivo, "string");
    assert.ok(estado.motivo.length > 0, "motivo vazio é igual ao comportamento antigo");
    assert.match(estado.motivo, /Acesso negado/, "a causa tem de sobreviver");
    assert.doesNotMatch(estado.motivo, /[A-Za-z]:[\\/](?:Users|users)[\\/][^\s"']+/i,
      "o motivo vai ao ecra: nao pode levar caminho de utilizador");
  });

  test("comando que termina bem NAO confirma estado: fica nao verificado sem read-back", async () => {
    const exe = executorFalso();
    const f = new WfpFilter({ executar: exe.executar });
    await f.start();
    assert.equal(exe.chamadas.length, 1, "uma tentativa, um comando");
    const estado = f.estado();
    assert.equal(estado.estado, "solicitado_nao_verificado");
    assert.equal(f.isActive(), false,
      "o codigo de saida do PowerShell nao e uma observacao do Windows");
  });

  test("read-back verdadeiro confirma; read-back falso deixa nao verificado", async () => {
    const exe = executorFalso();
    const confirmado = new WfpFilter({ executar: exe.executar, verificar: async () => true });
    await confirmado.start();
    assert.equal(confirmado.estado().estado, "ativo_confirmado");
    assert.equal(confirmado.isActive(), true);

    const exe2 = executorFalso();
    const naoConfirmado = new WfpFilter({ executar: exe2.executar, verificar: async () => false });
    await naoConfirmado.start();
    assert.equal(naoConfirmado.estado().estado, "solicitado_nao_verificado");
    assert.equal(naoConfirmado.isActive(), false);
  });

  test("read-back a rebentar nao vira ativo nem rebenta o start", async () => {
    const exe = executorFalso();
    const f = new WfpFilter({
      executar: exe.executar,
      verificar: async () => { throw Object.assign(new Error("cmdlet indisponível"), { name: "Error" }); },
    });
    await f.start();
    const estado = f.estado();
    assert.equal(estado.estado, "solicitado_nao_verificado");
    assert.equal(estado.motivo, undefined, "verificacao falhada nao e a falha do start");
    assert.equal(f.isActive(), false);
  });

  test("parar depois de confirmado devolve parado, e nao reexecuta sem necessidade", async () => {
    const exe = executorFalso();
    const f = new WfpFilter({ executar: exe.executar, verificar: async () => true });
    await f.start();
    assert.equal(f.estado().estado, "ativo_confirmado");
    await f.stop();
    assert.equal(f.estado().estado, "parado");
    assert.equal(f.isActive(), false);
  });

  test("stop sem start continua sem spawn e mantem nao_iniciado", async () => {
    const exe = executorFalso();
    const f = new WfpFilter({ executar: exe.executar });
    const inicio = Date.now();
    await f.stop();
    assert.ok(Date.now() - inicio < 200, "stop() sem start() nao pode spawnar PowerShell");
    assert.deepEqual(exe.chamadas, []);
    assert.equal(f.estado().estado, "nao_iniciado");
  });

  test("nenhum metodo invoca New/Set/Remove no teste real", async () => {
    const exe = executorFalso();
    const f = new WfpFilter({ executar: exe.executar });
    await f.start();
    await f.stop();
    for (const c of exe.chamadas) {
      assert.ok(/^-Command|/.test(c) && typeof c === "string");
      assert.ok(!/127\.0\.0\.\d+\.\d+/.test(c), "nada de IPs compostos estranhos");
    }
    assert.ok(exe.chamadas.every(c => c.includes("CyberSafe Blocklist")),
      "todos os comandos observados dizem respeito apenas à regra do produto");
  });
});
