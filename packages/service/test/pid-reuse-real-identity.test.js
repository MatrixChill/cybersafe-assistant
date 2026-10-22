import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ProtectionEngineService } from "../dist/engine.js";

/**
 * P1-6 — A IDENTIDADE TEM DE VIR DO PROCESSO, NÃO DO POLL.
 *
 * Este teste existe porque a implementação anterior passava e não provava nada.
 * `ProcessSnapshot.startedAt` era preenchido com `new Date()` no momento da
 * enumeração: TODOS os processos de um snapshot partilhavam a mesma data. A
 * comparação de identidade passava nos testes (que injetam datas artificiais) e
 * era um placebo em produção — o registo era descartado a cada poll e a cascata
 * do P0 voltava.
 *
 * Aqui as datas são as que o Windows devolveria: duas execuções do mesmo número
 * têm criações muito diferentes, e o poll é feito uma vez só. O registo tem de
 * sobreviver.
 */

const TEST_BASE_DIR = mkdtempSync(path.join(os.tmpdir(), "cybersafe-createtime-"));

const CRIACAO_DO_MOTOR = "2026-10-02T22:31:30.1234567Z";
const CRIACAO_DE_OUTRO_PROCESSO = "2026-10-02T23:58:11.9876543Z";

function engine() {
  return new ProtectionEngineService(TEST_BASE_DIR);
}

describe("P1-6 — a identidade de criação é a do PROCESSO", () => {
  it("o mesmo PID com outra CreationDate NÃO é nosso", () => {
    const svc = engine();
    svc.registerOwnChild(4242, CRIACAO_DO_MOTOR);

    // O 4242 morreu e o Windows deu o mesmo número a outra coisa, criada muito
    // mais tarde — como acontece quando um poll apanha o PID já reciclado.
    const externo = {
      pid: 4242,
      name: "notepad.exe",
      path: "C:\\Windows\\System32\\notepad.exe",
      startedAt: CRIACAO_DE_OUTRO_PROCESSO,
    };
    assert.equal(
      svc.shouldScanStartedProcess(externo),
      true,
      "um PID reutilizado tem de ser analisado, com nome e caminho próprios",
    );
    assert.equal(svc.isOwnChildPid(4242, CRIACAO_DO_MOTOR), false, "o registo antigo morreu com o PID");
  });

  it("a MESMA CreationDate continua imune (o caminho bom não se estraga)", () => {
    const svc = engine();
    svc.registerOwnChild(5151, CRIACAO_DO_MOTOR);
    const nosso = {
      pid: 5151,
      name: "clamscan.exe",
      path: "C:\\Program Files\\ClamAV\\clamscan.exe",
      startedAt: CRIACAO_DO_MOTOR,
    };
    assert.equal(svc.shouldScanStartedProcess(nosso), false, "o nosso próprio motor continua imune");
  });

  it("um poll posterior NÃO destroi o registo de quem não mudou", () => {
    // Este é o teste que a versão antiga falhava. A data do poll é a MESMA para
    // todos os processos de cada snapshot; se `startedAt` fosse a hora do poll,
    // o registo do motor seria descartado no snapshot seguinte e a imunidade
    // desapareceria — devolvendo a cascata do P0.
    const svc = engine();
    svc.registerOwnChild(7001, CRIACAO_DO_MOTOR);

    // Snapshot seguinte: o motor continua vivo, com a MESMA CreationDate.
    for (let poll = 0; poll < 5; poll++) {
      svc.reconcileOwnChildren([{ pid: 7001, startedAt: CRIACAO_DO_MOTOR }]);
    }
    assert.equal(
      svc.isOwnChildPid(7001, CRIACAO_DO_MOTOR),
      true,
      "cinco polls depois o motor tem de continuar registado como nosso",
    );
    assert.equal(svc.ownChildCount(), 1, "e o registo não pode ter sido descartado");
  });

  it("um snapshot sem CreationDate NÃO destrói o registo (ausência não é prova)", () => {
    const svc = engine();
    svc.registerOwnChild(7002, CRIACAO_DO_MOTOR);
    svc.reconcileOwnChildren([{ pid: 7002 }]);
    assert.equal(
      svc.isOwnChildPid(7002, CRIACAO_DO_MOTOR),
      true,
      "sem CreationDate não se prova reutilização, logo o registo fica",
    );
  });

  it("a reconciliação com o PID RECICLADO descarta mesmo", () => {
    const svc = engine();
    svc.registerOwnChild(7003, CRIACAO_DO_MOTOR);
    const descartados = svc.reconcileOwnChildren([
      { pid: 7003, startedAt: CRIACAO_DE_OUTRO_PROCESSO },
    ]);
    assert.equal(descartados, 1);
    assert.equal(svc.isOwnChildPid(7003, CRIACAO_DE_OUTRO_PROCESSO), false);
  });
});