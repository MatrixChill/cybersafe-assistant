/**
 * P1-1 — SHUTDOWN COM UM ESCRITOR VIVO. Ficheiro à parte, por uma razão concreta.
 *
 * O `ClamDatabaseGate` mantém um registo de PROCESSO dos escritores sem prova de
 * morte (`escritoresSemProvaDeMorte`). É esse registo que fecha o achado 2 da
 * quarta revisão do Codex: um gate NOVO nascia sem saber de um freshclam que o
 * serviço anterior deixou vivo, e admitia um scan por cima dele.
 *
 * Os dois casos deste ficheiro são precisamente os que REPORTAM um escritor
 * vivo e depois o largam sem prova de morte — e esse registo é de processo, com
 * purposely não é limpo pelo `reset`. Se corressem no mesmo ficheiro de testes
 * dos restantes, envenenavam a suite inteira: todos os testes seguintes receberiam
 * `update-active` sem haver nenhum escritor, e falhariam por uma razão que não
 * tem nada a ver com aquilo que estão a medir.
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

describe("P1-1 — shutdown com um escritor sem prova de morte", () => {

  // O ambito do gate e de PROCESSO — e e isso que fecha a coordenacao entre
  // gates — mas tambem significa que um teste que deixe um scan ou um escritor
  // vivo contaminaria todos os seguintes. Cada teste recebe um ambito limpo, e
  // e explicito: fingir que um `reset` resolve seria mentira.
  beforeEach(() => {
    reiniciarAmbitoDeTeste();
  });
  // ── 19. SHUTDOWN: o gate nao pode ficar preso ─────────────────────────────
  it("19 — dispose sem `close`: o gate fecha na mesma (o motor nao fica morto)", async () => {
    const gate = new ClamDatabaseGate({ drainBudgetMs: 5_000 });
    const defsDir = mkdtempSync(path.join(os.tmpdir(), "cs-p11-dispose-"));
    // O updater regista o gate vivo, para o `dispose` estatico o poder fechar.
    const updater = new DefinitionUpdater(defsDir, { gate });

    // Simula um update a meio: a posse foi concedida, o freshclam nasceu, e o
    // shutdown mata o filho SEM o `close` chegar (SIGKILL por fora).
    const posse = await updater.gate.beginUpdate();
    assert.ok(posse);
    posse.markWriting(); // o freshclam nasceu
    assert.equal(gate.state.updateActive, true);

    DefinitionUpdater.dispose();

    assert.equal(
      gate.state.updateActive,
      false,
      "um gate preso deixaria o ClamAV indisponivel ate ao reinicio, sem razao declarada",
    );
    // O `reset` passou a ser TERMINAL: um gate descartado não volta a admitir
    // scans. A versão anterior deste teste afirmava que sim, e era verdade
    // apenas porque o `disposed` ainda não era consultado — o `dispose`
    // desligava o `updateActive` mas deixava o gate a aceitar trabalho.
    assert.equal(
      motivoRecusa(gate),
      "gate-disposed",
      "e um scan NÃO volta a entrar: o serviço foi descartado, e um gate descartado não é uma base livre",
    );
  });

  // ── 31. `error` COM FILHO VIVO ────────────────────────────────────────────
});
