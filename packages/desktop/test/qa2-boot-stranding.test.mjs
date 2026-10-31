import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * TP-QA2-READINESS-20261025 — o arranque não pode desaparecer em silêncio.
 *
 * `main.ts` não é carregável num teste (precisa do runtime Electron), por isso
 * este é um guarda ESTRUTURAL, na mesma convenção de `boot-flow.test.mjs`: as
 * invariantes têm de se ler no fonte.
 *
 * O mecanismo, linha a linha (reproduzido em host/lane; o estado reportado na VM
 * QA1 é compatível com ele, mas não há logs da VM para o provar):
 *  - `pipeSessionToken` era `randomBytes(32)` POR PROCESSO → um serviço filho que
 *    sobrevivesse a um boot anterior ficava inautenticável para sempre;
 *  - a decisão de "reutilizar o serviço existente" era tomada por `probePipe`,
 *    que só prova que há um listener, não que a credencial é a nossa;
 *  - nesse ramo, `await client.connect()` corria SEM try/catch dentro do `.then`
 *    de `startServiceProcess()`; a rejeição escapava para `await startServiceProcess()`
 *    depois de `createWindow()` já ter aberto a janela, e a cadeia
 *    `app.whenReady().then(...)` não tinha `.catch` → nenhum diálogo, nenhum
 *    encerramento, nenhuma leitura confirmada: modo limitado com o gestor de
 *    tarefas vazio.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIN = fs.readFileSync(path.join(HERE, "..", "src", "main.ts"), "utf8");

function startServiceProcessBody(source) {
  const start = source.indexOf("function startServiceProcess");
  assert.ok(start >= 0, "startServiceProcess tem de existir em main.ts");
  const end = source.indexOf("\nfunction ", start + 10);
  return source.slice(start, end < 0 ? source.length : end);
}

describe("arranque empacotado — prontidão autenticada e falha legível", () => {
  it("a credencial do pipe é por instalação, não aleatória por processo", () => {
    assert.match(MAIN, /readOrCreatePipeCredential/,
      "main.ts tem de ler a credência persistida da instalação");
    const geracao = MAIN.match(/pipeSessionToken\s*=\s*[^\n]*/g) ?? [];
    for (const linha of geracao) {
      assert.doesNotMatch(linha, /randomBytes\(/,
        `credencial aleatória por processo volta a criar o lockout: "${linha.trim()}"`);
    }
  });

  it("reutilizar o serviço existente passa por handshake autenticado", () => {
    const corpo = startServiceProcessBody(MAIN);
    assert.match(corpo, /resolveExistingService/,
      "a decisão de reutilizar tem de viver em service-readiness (testável), não inline");
    assert.doesNotMatch(corpo, /await client\.connect\(\)/,
      "um `await client.connect()` solto no ramo de reutilização escapava para o boot");
  });

  it("startServiceProcess devolve um estado discriminado, nunca um booleano mudo", () => {
    const corpo = startServiceProcessBody(MAIN);
    assert.match(corpo, /status:\s*"connected"/, "sucesso tem de ser um estado nomeado");
    assert.match(corpo, /status:\s*"failed"/, "falha tem de trazer razão legível");
    assert.match(corpo, /foreign-service/, "o pipe de outra instalação é um caso próprio");
  });

  it("o boot trata o estado e não deixa a janela sozinha sem estado", () => {
    const boot = MAIN.slice(MAIN.indexOf("const serviceOk") >= 0
      ? MAIN.indexOf("const serviceStart") >= 0 ? MAIN.indexOf("const serviceStart") : MAIN.indexOf("const serviceOk")
      : MAIN.indexOf("app.whenReady()"));
    assert.match(boot, /serviceStart|serviceOk/, "o arranque consulta o resultado do serviço");
    assert.match(MAIN, /whenReady\(\)\.then\([\s\S]{0,12000}?\}\s*\)\.catch\(/,
      "a cadeia whenReady tem de ter .catch — sem isto uma rejeição morre silenciosa");
  });

  it("o probe cru deixa de ser suficiente para declarar o serviço como nosso", () => {
    const corpo = startServiceProcessBody(MAIN);
    assert.doesNotMatch(corpo, /if\s*\(\s*alreadyActive\s*\)/,
      "`alreadyActive` vinha só do probe cru; a posse tem de vir do handshake");
  });
});
