import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { withDeadline } from "../src/lib/deadline";
import { WINDOWS_HEALTH_TIMEOUT_MS } from "../src/components/PCHealthSection";

/**
 * Regressão do FAIL humano de 2026-10-10: a secção "Saúde do Windows" ficou
 * eternamente em "A recolher dados de saúde do Windows...".
 *
 * `ipcRenderer.invoke` não tem deadline. Se o pedido do serviço nunca responde
 * (serviço ocupado, pipe meio-aberto, `openSocket` a repetir ligações), a
 * promessa fica pendurada e o `finally` que faria `setLoading(false)` nunca
 * corre. `withDeadline` é a rede de segurança: termina SEMPRE, e num dos três
 * estados explícitos.
 */

describe("withDeadline — nenhuma leitura IPC fica pendurada", () => {
  test("promessa que resolve a tempo devolve o valor", async () => {
    const result = await withDeadline(Promise.resolve(42), 1_000);
    assert.deepEqual(result, { kind: "value", value: 42 });
  });

  test("promessa que NUNCA resolve termina em timeout (o bug do loading eterno)", async () => {
    const result = await withDeadline(new Promise<number>(() => {}), 30);
    assert.deepEqual(result, { kind: "timeout" });
  });

  test("promessa rejeitada devolve error — withDeadline nunca rejeita", async () => {
    const result = await withDeadline(Promise.reject(new Error("boom")), 1_000);
    assert.equal(result.kind, "error");
    if (result.kind === "error") assert.match(String(result.error), /boom/);
  });

  test("o prazo da Saúde do Windows é finito e generoso (motor responde em ~3s)", () => {
    assert.ok(Number.isFinite(WINDOWS_HEALTH_TIMEOUT_MS));
    assert.ok(WINDOWS_HEALTH_TIMEOUT_MS > 3_000, "não cortar leituras que já funcionam");
    assert.ok(WINDOWS_HEALTH_TIMEOUT_MS <= 60_000, "não deixar o utilizador à espera de um minuto");
  });
});
