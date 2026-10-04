import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ProtectionEngineService } from "../dist/engine.js";
import { YaraEngine } from "@cybersafe/core";

/**
 * O `coverage` novo só vale se **atravessar o pipe**. `EngineHealth.yara` é
 * `this.yara.health` (engine.ts:887) — o objecto inteiro, serializado como
 * JSON pelo named-pipe. Se alguém algum dia passar a construir esse health
 * campo a campo, o `coverage` desaparece em silêncio e a UI volta a dizer
 * "não comunicada" sem ninguém notar.
 *
 * ── Porque este teste NÃO chama `engine.init()` ───────────────────────────
 * A primeira versão fazia, e é a forma mais óbvia de testar. Mas `init()`
 * arranca o watcher nativo de ficheiros, o monitor de processos e o
 * consumidor ETW: vários segundos de CPU e handles de sistema. O
 * `shutdown.test.js` conta sockets e tem um timeout de 2 s; sob a pressão de
 * um `init()` a correr em paralelo, ele falha — deterministicamente, 2 runs de
 * 2. Não é o init() que está errado: é um teste de integração pesado a
 * competir com um teste que tem deadline.
 *
 * O que este ficheiro precisa provar é uma coisa só — que o `coverage` chega
 * ao consumidor. Para isso basta o motor YARA a medir, e o `getProtectionState()`
 * que o pipe chama. Sem `init()` o teste é Sync, sem handles, sem watcher.
 */

const tmpDirs = [];
async function rulesFile(content) {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), "cybersafe-cov-pipe-"));
  tmpDirs.push(d);
  const file = path.join(d, "default.yar");
  await fsp.writeFile(file, content, "utf-8");
  return file;
}

test.after(async () => {
  for (const d of tmpDirs) await fsp.rm(d, { recursive: true, force: true }).catch(() => {});
});

/** O corpus de canário é o que o serviço semeia; é o caso real de hoje. */
const CANARY = "// cybersafe-fallback-canary\nrule CyberSafe_Canary_EICAR\n{\n strings:\n $e = \"EICAR-STANDARD-ANTIVIRUS-TEST-FILE\"\n condition:\n $e\n}\n";

/**
 * Duas regras, e não uma.
 *
 * O contrato classifica um corpus de uma só regra como `limited`/`degraded`:
 * uma regra não é uma base de deteção, e afirmar cobertura normal com uma
 * regra é a mesma mentira que a UI mostrava ao utilizador. Este teste quer
 * provar que o `coverage` atravessa o named-pipe e que é semanticamente
 * distinto do `status` — para isso precisa de um corpus que legitimamente dê
 * `normal`, não um que o motor tem o direito de rebaixar.
 */
const REAL =
  'rule CyberSafe_Real_Detection\n{\n strings:\n $a = "EvilStringParaDeteccao"\n condition:\n $a\n}\n' +
  'rule MALW_Generic_Second\n{\n strings:\n $b = "OutraAssinaturaDeDeteccao"\n condition:\n $b\n}\n';

/** O health que o pipe envia: serialização, não o objecto em memória. */
function overThePipe(health) {
  return JSON.parse(JSON.stringify(health));
}

describe("W1 — o coverage atravessa o named-pipe", () => {
  test("corpus de canário: status degraded, coverage limited, ambos pela pipe", async () => {
    const file = await rulesFile(CANARY);
    const yara = new YaraEngine(file);
    await yara.load(file);

    const sent = overThePipe({ status: yara.health.status, detail: yara.health.detail, coverage: yara.health.coverage });

    assert.equal(sent.status, "degraded", "o canário dá motor degradado, não activo");
    assert.equal(
      sent.coverage,
      "limited",
      "coverage tem de chegar intacto pela pipe — se sumir, a UI mente por omissão",
    );
  });

  test("corpus real: status active E coverage normal, semanticamente distintos", async () => {
    const file = await rulesFile(REAL);
    const yara = new YaraEngine(file);
    await yara.load(file);

    const sent = overThePipe({ status: yara.health.status, detail: yara.health.detail, coverage: yara.health.coverage });

    assert.equal(sent.status, "active", "corpus real dá motor activo");
    assert.equal(
      sent.coverage,
      "normal",
      "corpus real que compilou é a única evidência que autoriza 'normal'",
    );
  });

  test("o engine publica o objecto INTEIRO: um campo a menos e o coverage cai", async () => {
    // Este teste documenta a fragilidade de propósito. `getProtectionState()`
    // faz `yara: this.yara.health` — o objecto completo. O dia em que alguém
    // escrever `{ status, detail }` à mão, o `coverage` deixa de viajar e este
    // teste falha, que é o ponto: tornar a perda visível em vez de silenciosa.
    const baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cybersafe-cov-shape-"));
    tmpDirs.push(baseDir);

    const engine = new ProtectionEngineService(baseDir);
    const yaraField = engine.getProtectionState().engine.yara;

    assert.ok(yaraField, "getProtectionState().engine.yara tem de existir");
    assert.equal(
      yaraField.status,
      "unavailable",
      "sem init(), o motor ainda não carregou nada",
    );
    assert.equal(
      yaraField.coverage,
      "unknown",
      "sem corpus carregado, a cobertura é desconhecida — nunca 'normal'",
    );

    // Nenhum ramo pode produzir 'normal' a partir de 'unavailable'.
    assert.notEqual(yaraField.coverage, "normal");
  });
});
