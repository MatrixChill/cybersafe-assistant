import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * P0-DEV-SOBREVIVER-SEM-SERVICO (opção ii do Freebuff).
 *
 * O arranque fazia `dialog.showErrorBox(...)` + `app.quit()` quando o
 * `client.connect()` esgotava as tentativas. Com o isolamento de dev, o serviço
 * de proteção NÃO é ligado (opção e), logo o dev fechava-se a si próprio e a
 * MATRIX nunca era testável pela interface.
 *
 * Este teste lê a FONTE do `main.ts` e prende três coisas:
 * 1. em dev isolado o `catch` NÃO pode encerrar nem mostrar diálogo de erro;
 * 2. o artefacto (empacotado) continua a encerrar — produção intacta;
 * 3. a frase publicada diz que o serviço está indisponível em dev e não afirma
 *    proteção ativa.
 */

const SRC = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "main.ts"),
  "utf8",
);

function catchDeConnect() {
  // O connect do ARRANQUE (ha outro dentro de startServiceProcess); usamos o ultimo.
  const inicio = SRC.lastIndexOf("await client.connect();");
  assert.ok(inicio > -1, "não encontrámos o `client.connect()` do arranque");
  const bloco = SRC.slice(inicio, SRC.indexOf("  });", inicio));
  assert.ok(bloco.includes("catch"), "o connect do arranque tem de estar protegido");
  return bloco;
}

describe("dev sem serviço de proteção — o desktop sobrevive", () => {
  test("o catch do connect tem o guard do perfil dev", () => {
    assert.match(catchDeConnect(), /if \(!perfil\.protectionService\)/, "falta o guard do modo dev sem serviço");
  });

  test("dev não encerra: o `app.quit()` fica DEPOIS do guard, não dentro do ramo dev", () => {
    const bloco = catchDeConnect();
    const guard = bloco.indexOf("if (!perfil.protectionService)");
    const fimRamoDev = bloco.indexOf("}", bloco.indexOf("return", guard));
    const quit = bloco.indexOf("app.quit()");
    assert.ok(guard > -1 && quit > -1, "guard ou quit ausentes");
    assert.ok(quit > fimRamoDev, "o encerramento ficou dentro do ramo dev");
    assert.ok(bloco.slice(guard, fimRamoDev).includes("return"), "o ramo dev tem de sair do catch sem encerrar");
  });

  test("dev não mostra o diálogo de falha de ligação", () => {
    const bloco = catchDeConnect();
    const guard = bloco.indexOf("if (!perfil.protectionService)");
    assert.ok(guard > -1, "sem guard do dev, este teste seria vazio");
    const ramoDev = bloco.slice(guard, bloco.indexOf("}", bloco.indexOf("return", guard)));
    assert.doesNotMatch(ramoDev, /showErrorBox/, "um dev sem serviço não pode abrir diálogo de erro");
  });

  test("a frase do dev declara o serviço indisponível e nunca proteção ativa", () => {
    const bloco = catchDeConnect();
    const frase = bloco.match(/console\.(warn|log)\("(\[Electron\][^"]*dev[^"]*)"/i);
    assert.ok(frase, "falta a mensagem de estado do dev");
    assert.match(frase[2], /indispon/i, "a mensagem tem de nomear o serviço indisponível em dev");
    assert.doesNotMatch(frase[2], /prote.{0,3}o ativa/i, "sem serviço não se pode dizer que a proteção está ativa");
  });

  test("empacotado mantém o encerramento com diagnóstico", () => {
    const bloco = catchDeConnect();
    assert.match(bloco, /showErrorBox/, "o artefacto continua a reportar a falha de ligação");
    assert.match(bloco, /isQuitting = true;\s*\n\s*app\.quit\(\);/, "o artefacto continua a encerrar");
  });
});
