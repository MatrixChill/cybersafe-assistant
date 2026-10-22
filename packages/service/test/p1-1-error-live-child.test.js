/**
 * P1-1 — SHUTDOWN COM UM ESCRITOR VIVO. Ficheiro à parte, por uma razão concreta.
 *
 * O `ClamDatabaseGate` mantém um registo de PROCESSO dos escritores sem prova de
 * morte (`escritoresSemProvaDeMorte`). É esse registo que fecha o achado 2 da
 * quarta revisão do Codex: um gate NOVO nascia sem saber de um freshclam que o
 * serviço anterior deixou vivo, e admitia um scan por cima dele.
 *
 * Este caso REPORTA um escritor vivo e larga-o sem prova de morte. Esse registo
 * é de PROCESSO e o `reset` não o limpa — que é a posição honesta. Por isso este
 * caso mora sozinho: partilhado com outro que faça o mesmo, o segundo correria
 * com o escritor do primeiro ainda registado, e falharia por uma razão que não
 * tem nada a ver com aquilo que está a medir.
 *
 * `node --test` corre cada ficheiro no seu processo. É isso que isola o veneno,
 * tal como acontece com o veneno do semáforo do ClamAV no core.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ClamDatabaseGate, reiniciarAmbitoDeTeste } from "../dist/clam-database-gate.js";
import { DefinitionUpdater } from "../dist/updater.js";

/** Motivo pelo qual um scan foi (ou não).recusado. Espelha o helper do outro ficheiro. */
function motivoRecusa(gate) {
  const tentativa = gate.tryAcquireScanLease();
  if (tentativa.ok) {
    tentativa.lease.release();
    return "CONCEDIDA";
  }
  return tentativa.reason;
}

describe("P1-1 — `error` com filho vivo", () => {

  // O ambito do gate e de PROCESSO — e e isso que fecha a coordenacao entre
  // gates — mas tambem significa que um teste que deixe um scan ou um escritor
  // vivo contaminaria todos os seguintes. Cada teste recebe um ambito limpo, e
  // e explicito: fingir que um `reset` resolve seria mentira.
  beforeEach(() => {
    reiniciarAmbitoDeTeste();
  });
  // ── 19. SHUTDOWN: o gate nao pode ficar preso ─────────────────────────────
  it("31 — um `error` com filho VIVO não devolve a posse", async () => {
    // O Codex (achado 1): o Node emite `error` também quando não consegue
    // MATAR o filho. Devolver a posse aí admitia um scan e um segundo update por
    // cima de um freshclam que continuava vivo a escrever.
    //
    // O seam é o `spawnFreshclam`, NÃO o `runFreshclam`. O `runFreshclam` REAL
    // corre, com o `beginUpdate`, o `markWriting` e a decisão do `error` — que
    // é exactamente o que está em jogo. A primeira versão deste teste
    // substituía o `runFreshclam` inteiro e provava o dublê.
    const gate = new ClamDatabaseGate({ drainBudgetMs: 60 });
    const defsDir = mkdtempSync(path.join(os.tmpdir(), "cs-p11-error-"));

    let filho = null;
    const updater = new DefinitionUpdater(defsDir, {
      gate,
      spawnFreshclam: () => {
        // Um filho com PID — que é o que distingue "processo vivo" de "spawn
        // falhou" — e que nunca emite `close`.
        filho = new EventEmitter();
        filho.pid = 5150;
        filho.stderr = new EventEmitter();
        filho.stdout = new EventEmitter();
        filho.kill = () => true;
        // O `error` é emitido depois de o updater ter ligado os ouvintes.
        setImmediate(() => filho.emit("error", new Error("não foi possível matar")));
        return filho;
      },
    });
    updater.updateYaraRules = async () => {};
    updater.updateHashFeed = async () => {};

    await updater.checkAndUpdate(true).catch(() => {});
    await new Promise((r) => setTimeout(r, 20));

    assert.ok(filho, "o freshclam tem de ter nascido — senão o teste não prova nada");
    assert.equal(
      gate.state.updateActive,
      true,
      "com o filho vivo e sem `close`, a posse NÃO pode ter sido devolvida: o freshclam pode estar a escrever",
    );
    assert.notEqual(motivoRecusa(gate), "CONCEDIDA", "e nenhum scan entra na base por cima dele");

    // ── O achado 2, no mesmo ficheiro porque é o mesmo escritor vivo ──────
    // Um gate NOVO herdaria a admissão se o registo de processo não existisse.
    // É o que o Codex reproduziu: `newGateScanAdmitted: true`.
    const gateNovo = new ClamDatabaseGate();
    assert.notEqual(
      motivoRecusa(gateNovo),
      "CONCEDIDA",
      "um gate novo NÃO pode admitir um scan por cima de um escritor que o serviço anterior deixou vivo",
    );
  });
});
