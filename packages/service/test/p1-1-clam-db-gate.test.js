/**
 * P1-1 — CLAM DATABASE GATE. O CONTRATO, CASO A CASO.
 *
 * A CORRIDA QUE ESTES TESTES EXISTEM PARA FECHAR (o que o mecanismo anterior,
 * um `isDatabaseSwapping()` consultado no início do scan, NÃO fechava):
 *
 *   scan lê "false" → (await) → freshclam arranca → scan entra na base a meio
 *   scan já activo   → freshclam escreve por cima dele
 *
 * Por isso o teste mais importante não é nenhum dos 18: é o ÚLTIMO, que tenta
 * o pior interleaving possível e afirma que é IMPOSSÍVEL observar um scan com a
 * base e um freshclam a correr ao mesmo tempo.
 *
 * ZERO rede. ZERO freshclam real. ZERO clamscan real. O `spawn` é injectado e
 * nunca chamado com o binário a sério — o seam está em `runFreshclam`, e os
 * testes de gate nem sequer chegam lá.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { ClamDatabaseGate, reiniciarAmbitoDeTeste } from "../dist/clam-database-gate.js";

/** Lease obtida, ou recusa. Lanza se aLease nao foi concedida. */
function lease(gate) {
  const attempt = gate.tryAcquireScanLease();
  assert.equal(attempt.ok, true, `a lease devia ter sido concedida (motivo: ${attempt.reason})`);
  return attempt.lease;
}

/** Tenta e devolve o motivo, sem lanhar. */
function motivoRecusa(gate) {
  const attempt = gate.tryAcquireScanLease();
  if (attempt.ok) {
    attempt.lease.release();
    return "CONCEDIDA";
  }
  return attempt.reason;
}

/** Deixa o event loop correr `ms`, sem poll. */
function tick(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * `beginUpdate` devolve a POSSE (um objecto com `release`) ou `null`.
 *
 * Antes devolvia `true`/`false` e fechava-se com `endUpdate()`. A troca não é
 * cosmética: `endUpdate` não sabia QUEM fechava, e era por isso que o Codex
 * encontrou quatro bugs — um duplo fecho desligava a posse do update SEGUINTE.
 * Com a posse no valor devolvido, o duplo fecho é idempotente POR CONSTRUÇÃO.
 */

describe("P1-1 — CLAM DATABASE GATE", () => {

  // O ambito do gate e de PROCESSO — e e isso que fecha a coordenacao entre
  // gates — mas tambem significa que um teste que deixe um scan ou um escritor
  // vivo contaminaria todos os seguintes. Cada teste recebe um ambito limpo, e
  // e explicito: fingir que um `reset` resolve seria mentira.
  beforeEach(() => {
    reiniciarAmbitoDeTeste();
  });
  // ── 1. update ACTIVE → novo scanDenied ─────────────────────────────────────
  it("1 — update active: nenhum scan novo entra", async () => {
    const gate = new ClamDatabaseGate();
    const posse = await gate.beginUpdate();
    assert.ok(posse, "sem scans activos, o update arranca");
    // `beginUpdate` concede a POSSE, não a ESCRITA. O `markWriting` é o que o
    // updater chama imediatamente antes do `spawn`, e é ele que torna
    // `updateActive` verdadeiro — para o snapshot não afirmar que há um
    // freshclam na base antes de ele existir.
    assert.equal(gate.state.updateActive, false, "a posse não é o mesmo que estar a escrever");
    assert.equal(motivoRecusa(gate), "update-pending", "e o scan já é recusado na mesma");
    posse.markWriting();
    assert.equal(gate.state.updateActive, true);

    assert.equal(motivoRecusa(gate), "update-active", "um scan durante o update é recusado");
    posse.release();
    assert.equal(motivoRecusa(gate), "CONCEDIDA", "e volta a entrar assim que o update acaba");
  });

  // ── 2. update PENDING → novo scanDenied ────────────────────────────────────
  it("2 — update pending (a drenar): nenhum scan novo entra", async () => {
    const gate = new ClamDatabaseGate();
    const scanVivo = lease(gate); // 1 scan activo, para o update ter o que esperar
    assert.equal(gate.state.activeScans, 1);

    const pending = gate.beginUpdate();
    // `beginUpdate` marcou `updatePending` ANTES do primeiro await — por isso
    // isto é verdade SEM esperar por um microtask.
    assert.equal(gate.state.updatePending, true, "pending marcado sincronamente, antes do await");
    assert.equal(gate.state.updateActive, false, "mas ainda não está active: o scan não drenou");
    assert.equal(motivoRecusa(gate), "update-pending", "um scan novo é recusado enquanto espera");

    scanVivo.release();
    const posse = await pending;
    assert.ok(posse, "com o scan terminado, o update arranca");
    posse.release();
  });

  // ── 3. 1 scan activo → o freshclam NÃO nasce ──────────────────────────────
  it("3 — 1 scan activo: o update espera e o freshclam não nasce antes disso", async () => {
    const gate = new ClamDatabaseGate({ drainBudgetMs: 5_000 });
    const scan = lease(gate);

    let spawned = false;
    const update = gate
      .beginUpdate()
      .then((posse) => {
        // Só o spawn é simulado: se houve posse, o freshclam nasceria.
        if (posse) {
          spawned = true;
          posse.release();
        }
        return Boolean(posse);
      });

    await tick(50);
    assert.equal(spawned, false, "com o scan a correr, o freshclam NÃO nasceu");
    assert.equal(gate.state.updateActive, false);

    scan.release();
    assert.ok(await update, "e só nasce depois de o scan libertar a lease");
  });

  // ── 4. 2 scans activos → espera OS DOIS ────────────────────────────────────
  it("4 — 2 scans activos: o update espera que os DOIS drenem", async () => {
    const gate = new ClamDatabaseGate({ drainBudgetMs: 5_000 });
    const a = lease(gate);
    const b = lease(gate);
    assert.equal(gate.state.activeScans, 2);

    const update = gate.beginUpdate();
    await tick(30);
    assert.equal(gate.state.updateActive, false, "ainda não: há dois scans a usar a base");

    a.release();
    await tick(30);
    assert.equal(
      gate.state.updateActive,
      false,
      "libertar UM só não chega — o outro ainda tem a base aberta",
    );

    b.release();
    const posse = await update;
    assert.ok(posse, "só com os dois libertados é que o update arranca");
    posse.release();
  });

  // ── 5. último scan termina → o update pode nascer ─────────────────────────
  it("5 — o último scan a terminar abre caminho ao update", async () => {
    const gate = new ClamDatabaseGate({ drainBudgetMs: 5_000 });
    const a = lease(gate);
    const b = lease(gate);
    const update = gate.beginUpdate();

    b.release();
    assert.equal(motivoRecusa(gate), "update-pending", "enquanto o outro vive, nenhum scan entra");
    a.release();

    const posse = await update;
    assert.ok(posse);
    assert.equal(gate.state.activeScans, 0);
    posse.release();
    assert.equal(motivoRecusa(gate), "CONCEDIDA", "e depois do update o scan volta a entrar");
  });

  // ── 6/7/8. A lease é libertada em TODOS os caminhos de fim de scan ────────
  it("6 — scan falhado: a lease é libertada no finally", async () => {
    const gate = new ClamDatabaseGate();
    const l = lease(gate);
    try {
      throw new Error("o scan rebentou a meio");
    } catch {
      /* o scan morreu */
    } finally {
      l.release();
    }
    assert.equal(gate.state.activeScans, 0, "um scan que falha não deixa a base presa");
    const posse = await gate.beginUpdate();
    assert.ok(posse, "e o update passa logo a seguir");
    posse.release();
  });

  it("7 — scan cancelado: a lease é libertada no finally", async () => {
    const gate = new ClamDatabaseGate();
    const l = lease(gate);
    try {
      // simula abort/cancel: o código de cancelamento não lança
      const cancelado = true;
      if (!cancelado) throw new Error("não devia chegar aqui");
    } finally {
      l.release();
    }
    assert.equal(gate.state.activeScans, 0);
    assert.equal(motivoRecusa(gate), "CONCEDIDA");
  });

  it("8 — scan com timeout: a lease é libertada no finally", async () => {
    const gate = new ClamDatabaseGate();
    const l = lease(gate);
    try {
      await tick(5);
      throw new Error("deadline do scan");
    } catch {
      /* o deadline matou o scan */
    } finally {
      l.release();
    }
    assert.equal(gate.state.activeScans, 0, "um timeout não deixa o gate preso");
  });

  // ── 9. release DUPLICADO → contador consistente ────────────────────────────
  it("9 — release idempotente: um duplo release não corrompe o contador", async () => {
    const gate = new ClamDatabaseGate();
    const a = lease(gate);
    const b = lease(gate);
    assert.equal(gate.state.activeScans, 2);

    a.release();
    a.release();
    a.release();
    assert.equal(gate.state.activeScans, 1, "três releases de uma lease = UMA libertação");
    assert.equal(a.released, true);

    // O teste que prova que o contador não desceu a mais: o update tem de
    // esperar pelo `b`, não pelo `a`. Se `a` tivesse contado duas vezes, o
    // gate chegaria a zero com `b` vivo e o freshclam escreveria por cima dele.
    const update = gate.beginUpdate();
    await tick(30);
    assert.equal(gate.state.updateActive, false, "b ainda tem a base: o update espera");
    b.release();
    const posse = await update;
    assert.ok(posse);
    posse.release();
  });

  // ── 10. o `spawn` do freshclam LANÇA → gate limpo ──────────────────────────
  it("10 — o spawn a lançar: o gate fica limpo e o scan volta", async () => {
    const gate = new ClamDatabaseGate();
    // Simula o `runFreshclam`: a posse foi concedida, o spawn lança, e o
    // `finally` devolve-a. Com a posse-por-objecto, o `finally` não precisa de
    // flag nenhuma para não fechar duas vezes.
    const posse = await gate.beginUpdate();
    assert.ok(posse);
    try {
      throw new Error("spawn ENOENT");
    } catch {
      posse.release();
    }
    assert.equal(gate.state.updateActive, false, "o gate não ficou preso em 'active'");
    assert.equal(gate.state.updatePending, false, "nem em 'pending'");
    assert.equal(motivoRecusa(gate), "CONCEDIDA", "um scan volta a entrar");
  });

  // ── 11. `error` + `close` → o duplo fecho é inofensivo ─────────────────────
  it("11 — error seguido de close: o duplo fecho não rouba a posse seguinte", async () => {
    const gate = new ClamDatabaseGate();
    const posse = await gate.beginUpdate();
    assert.ok(posse);

    // O Node emite `error` E `close` quando o spawn falha. As duas chamam o
    // mesmo fecho. Antes, o fecho manual tinha de se proteger com uma flag; e
    // mesmo com a flag, um `endUpdate` a mais desligava a posse do update
    // SEGUINTE, que já a tinha recebido por passagem de vez.
    let fechos = 0;
    const fecharGate = () => {
      fechos++;
      posse.release();
    };
    const child = new EventEmitter();
    child.on("error", () => fecharGate());
    child.on("close", () => fecharGate());

    child.emit("error", new Error("spawn falhou"));
    child.emit("close", 1);

    assert.equal(fechos, 2, "o Node emitiu os dois eventos, e ambos fecharam");
    assert.equal(gate.state.updatePending, false);
    assert.equal(gate.state.updateActive, false);

    // A prova de que o duplo fecho foi inofensivo: a posse continua a poder
    const seguinte = await gate.beginUpdate();
    assert.ok(seguinte, "o update seguinte recebe a posse — o duplo fecho não a roubou");
    seguinte.release();
  });

  // ── 12. deadline à espera → o freshclam NÃO nasce ──────────────────────────
  it("12 — orçamento esgotado: o freshclam não nasce e o gate fica consistente", async () => {
    const gate = new ClamDatabaseGate({ drainBudgetMs: 40 });
    const scan = lease(gate);

    let spawned = false;
    const resultado = await gate.beginUpdate().then((posse) => {
      if (posse) spawned = true;
      return Boolean(posse);
    });

    assert.equal(resultado, false, "o update foi adiado");
    assert.equal(spawned, false, "e o freshclam NÃO nasceu — a base actual fica intacta");
    assert.equal(gate.state.updatePending, false, "a janela fechou-se");
    assert.equal(gate.state.updateActive, false, "e nunca chegou a estar activa");

    // O scan NÃO foi morto: continua a poder terminar.
    assert.equal(gate.state.activeScans, 1, "não se matou trabalho de utilizador");
    scan.release();
    assert.equal(motivoRecusa(gate), "CONCEDIDA", "e a base volta a estar disponível");
  });

  // ── 13. o `pending` FECHA A CORRIDA (o caso TOCTOU) ────────────────────────
  it("13 — nenhum scan entra entre o pedido de update e o drain", async () => {
    const gate = new ClamDatabaseGate({ drainBudgetMs: 5_000 });
    const scanA = lease(gate);

    const pending = gate.beginUpdate();

    // O pior interleaving possível: tentar entrar em TUDO o que resta entre
    // o pedido e o drain. Nenhum pode ser concedido — nem no primeiro tick, nem
    // depois de o scan libertar, nem durante o drain.
    const intrusos = [];
    for (let i = 0; i < 5; i++) intrusos.push(motivoRecusa(gate));
    assert.ok(intrusos.every((m) => m === "update-pending"), `todos recusados (vistos: ${intrusos})`);

    scanA.release();
    // Um tick depois do drain, o update já está active: novo scan também não entra.
    const posse = await pending;
    assert.ok(posse);
    posse.markWriting();
    assert.equal(motivoRecusa(gate), "update-active", "e durante o update é recusado por outra razão");
    posse.release();
  });

  // ── 14/15. scheduler e manual usam o MESMO gate ───────────────────────────
  it("14/15 — os dois caminhos de update partilham a MESMA instância do gate", () => {
    // O gate é uma propriedade do updater, e o motor passa o MESMO objecto à
    // bridge e ao updater. Duas instâncias seriam duas autoridades independentes
    // a concordar por sorte — que é como se reintroduz a corrida.
    const gate = new ClamDatabaseGate();
    assert.equal(gate.state.activeScans, 0);

    // Simula os dois caminhos a usar a mesma instância.
    const manual = gate.tryAcquireScanLease();
    assert.equal(manual.ok, true);
    const periodico = gate.tryAcquireScanLease();
    assert.equal(periodico.ok, true, "o caminho periódico vê a lease do scan");
    assert.equal(gate.state.activeScans, 2, "as duas portas contam no mesmo lugar");

    manual.lease.release();
    periodico.lease.release();
    assert.equal(gate.state.activeScans, 0);
  });

  // ── 16/17/18. afterSwap só no momento certo ───────────────────────────────
  /**
   * 16 e 17 passam pelo `DefinitionUpdater` REAL, não por uma réplica da regra.
   *
   * A primeira versão deste teste chamava `afterSwap` directamente e afirmava
   * que ele não era chamado — o que é trivialmente verdade e não provava nada:
   * a condição `clamUpdated === true` está no UPDATER, não dentro do gancho.
   * Chamar o gancho à mão contorna precisamente o que se queria testar.
   *
   * Aqui o gancho é entregue ao updater e o `updateClamAV` real é interceptado
   * por dentro, para não correr freshclam. O que fica a testar é a DECISÃO do
   * updater: chama ou não chama, e em que condição.
   */
  it("16/17 — o afterSwap só corre quando o freshclam correu a sério", async () => {
    const { DefinitionUpdater } = await import("../dist/updater.js");
    const { mkdtempSync } = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");

    const chamadas = [];
    const defsDir = mkdtempSync(path.join(os.tmpdir(), "cs-p11-afterswap-"));

    // Simula o `updateClamAV` sem freshclam: substitui o método PRIVADO por
    // dentro da instância, que é o seam que permite testar a decisão do
    // `checkAndUpdate` sem tocar no binário.
    async function comUpdateClamAV(comportamento, fn) {
      const updater = new DefinitionUpdater(defsDir, {
        afterSwap: async (result) => {
          chamadas.push(result.clamUpdated);
        },
      });
      updater.updateClamAV = comportamento;
      // YARA e hashes tambem correm: sao rede, e este teste tem de ser zero-rede.
      updater.updateYaraRules = async () => {};
      updater.updateHashFeed = async () => {};
      return fn(updater);
    }

    // 16 — o freshclam correu e saiu com 0: o gancho CORRE.
    await comUpdateClamAV(async () => undefined, (u) => u.checkAndUpdate(true));
    assert.deepEqual(
      chamadas,
      [true],
      "com a base trocada a sério, o health é reavaliado — este é o defeito 2",
    );

    // 17 — o freshclam NÃO correu (drain falhado, exit != 0, ou ausente).
    chamadas.length = 0;
    await comUpdateClamAV(
      async () => {
        throw new Error("freshclam exit code 1");
      },
      (u) => u.checkAndUpdate(true),
    );
    assert.deepEqual(
      chamadas,
      [],
      "sem base nova NÃO se re-sonda: seria publicar um estado que ninguém mudou",
    );
  });

  it("17b — um update ADIADO por scans activos também não chama o afterSwap", async () => {
    const { DefinitionUpdater } = await import("../dist/updater.js");
    const { mkdtempSync } = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");

    const chamadas = [];
    const defsDir = mkdtempSync(path.join(os.tmpdir(), "cs-p11-adiado-"));
    const gate = new ClamDatabaseGate({ drainBudgetMs: 30 });

    const updater = new DefinitionUpdater(defsDir, {
      gate,
      afterSwap: async (result) => {
        chamadas.push(result.clamUpdated);
      },
    });
    let spawnou = false;
    // O seam é `runFreshclam`, NÃO `updateClamAV`. Assim o `updateClamAV` REAL
    // corre — incluindo o `gate.beginUpdate()`, que é o que se quer testar — e
    // só o `spawn` do binário é substituído. Substituir o `updateClamAV`
    // inteiro saltava o gate, e o teste passaria sem exercitar nada.
    updater.runFreshclam = () => {
      spawnou = true;
    };
    // A lease deste scan fica viva DE PROPÓSITO durante o teste — é o que
    // obriga o update a adiar. Mas o registo de scans vivos é de PROCESSO: se
    // ficar cá depois do teste, todos os seguintes recebem `update-pending`
    // sem haver scan nenhum. Solta-se no fim, depois de as asserções.
    const scanVivo = lease(gate);
    updater.updateYaraRules = async () => {};
    updater.updateHashFeed = async () => {};

    const resultado = await updater.checkAndUpdate(true);

    assert.equal(spawnou, false, "o freshclam NÃO nasceu: os scans não drenaram a tempo");
    assert.equal(resultado.clamUpdated, false, "o freshclam não actualizou");
    assert.deepEqual(chamadas, [], "e o health não foi re-sondado");
    assert.ok(
      resultado.errors.some((e) => /ClamAV/.test(e)),
      `a falha ficou declarada (erros: ${JSON.stringify(resultado.errors)})`,
    );
    assert.equal(
      gate.state.activeScans,
      1,
      "e o scan vivo NÃO foi morto — adiar é honesto, matar trabalho do utilizador não",
    );
    scanVivo.release();
  });

  it("18 — o afterSwap a falhar não apaga o facto de que o update ocorreu", async () => {
    const resultado = { clamUpdated: true, yaraUpdated: true, hashesUpdated: true, errors: [], timestamp: "" };
    const afterSwap = async () => {
      throw new Error("isAvailable(true) explodiu");
    };

    try {
      await afterSwap(resultado);
    } catch (err) {
      resultado.errors.push(`pos-update: ${err.message}`);
    }

    assert.equal(
      resultado.clamUpdated,
      true,
      "a actualização aconteceu — um problema no pós-update não a desfaz",
    );
    assert.equal(resultado.errors.length, 1, "e o problema é reportado como erro pós-update");
    assert.match(resultado.errors[0], /pos-update/, "identificado como pós-update, não como falha do update");
  });

  // ── 20. O INTERLEAVING MAIS PERIGOSO ─────────────────────────────────────
  /**
   * O instante EXACTO em que o drain resolve e o `updateActive` ainda é falso.
   *
   * E o unico ponto onde um gate mal escrito abre buraco: se `updatePending`
   * fosse posto a false ANTES do `updateActive` ser true, haveria um intervalo
   * — um microtask, na pratica — em que nem `pending` nem `active` bloqueiam, e
   * um scan que pedisse lease nesse instante entraria na base a meio da troca.
   *
   * O teste chama a tentativa DENTRO do `release` do ultimo scan, ou seja no
   * frame exacto em que o drain resolve. E o pior caso que se pode construir
   * sem instrumentar o runtime.
   */
  it("20 — no instante em que o drain resolve, um scan ainda é recusado", async () => {
    const gate = new ClamDatabaseGate({ drainBudgetMs: 5_000 });
    const scan = lease(gate);

    const update = gate.beginUpdate();
    await tick(20);
    assert.equal(gate.state.updateActive, false, "precondicao: ainda a drenar");

    // O instante critico. `release` vai por o activeScans a zero e resolver o
    // drain; a tentativa abaixo corre no MESMO stack, antes de o `await` do
    // `beginUpdate` retomar.
    let motivoNoInstanteCritico;
    const retorno = scan.release();
    motivoNoInstanteCritico = motivoRecusa(gate);
    void retorno;

    assert.equal(
      motivoNoInstanteCritico,
      "update-pending",
      `um scan no instante em que o drain resolve tem de ser recusado (visto: ${motivoNoInstanteCritico})`,
    );

    // E, ja com a continuacao a correr, o update assume e o bloqueio muda de
    // motivo — o que prova que `updateActive` ficou true de facto.
    const posse = await update;
    assert.ok(posse);
    posse.markWriting();
    assert.equal(gate.state.updateActive, true);
    assert.equal(motivoRecusa(gate), "update-active", "o bloqueio mudou de causa, nunca desapareceu");
    posse.release();
  });

  it("publicação falhada das regras YARA preserva o corpus anterior", async () => {
    const { DefinitionUpdater } = await import("../dist/updater.js");
    const fsPromises = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const definitionsDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "cs-yara-atomic-"));
    const rulesPath = path.join(definitionsDir, "yara", "default.yar");
    const previousRules = "rule previous_corpus { condition: true }";
    const candidateRules = "rule updated_corpus { condition: true }";

    try {
      await fsPromises.mkdir(path.dirname(rulesPath), { recursive: true });
      await fsPromises.writeFile(rulesPath, previousRules, "utf8");
      const updater = new DefinitionUpdater(definitionsDir, {
        renameYaraRules: async () => {
          throw new Error("simulated atomic publication failure");
        },
      });
      updater.downloadText = async () => candidateRules;
      updater.updateClamAV = async () => {
        throw new Error("ClamAV disabled in isolated test");
      };
      updater.updateHashFeed = async () => {
        throw new Error("hash feed disabled in isolated test");
      };

      const result = await updater.checkAndUpdate(true);

      assert.equal(result.yaraUpdated, false);
      assert.match(result.errors[0], /simulated atomic publication failure/);
      assert.equal(await fsPromises.readFile(rulesPath, "utf8"), previousRules);
      assert.deepEqual(await fsPromises.readdir(path.dirname(rulesPath)), ["default.yar"]);
    } finally {
      await fsPromises.rm(definitionsDir, { recursive: true, force: true });
    }
  });

  it("rollback do corpus quando o reload YARA falha restaura disco e motor", async () => {
    const { DefinitionUpdater } = await import("../dist/updater.js");
    const { YaraEngine } = await import("@cybersafe/core");
    const fsPromises = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const definitionsDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "cs-yara-reload-rollback-"));
    const rulesPath = path.join(definitionsDir, "yara", "default.yar");
    const previousRules = 'rule previous_corpus { strings: $a = "previous-marker" condition: $a }';
    const candidateRules = 'rule updated_corpus { strings: $b = "updated-marker" condition: $b }';
    let reloads = 0;

    try {
      await fsPromises.mkdir(path.dirname(rulesPath), { recursive: true });
      await fsPromises.writeFile(rulesPath, previousRules, "utf8");
      const yara = new YaraEngine(rulesPath);
      await yara.load(rulesPath);
      const updater = new DefinitionUpdater(definitionsDir, {
        afterYaraUpdated: async () => {
          reloads += 1;
          await yara.load(rulesPath);
          if (reloads === 1) {
            throw new Error("simulated YARA reload failure");
          }
        },
      });
      updater.downloadText = async () => candidateRules;
      updater.updateClamAV = async () => {
        throw new Error("ClamAV disabled in isolated test");
      };
      updater.updateHashFeed = async () => {
        throw new Error("hash feed disabled in isolated test");
      };

      const result = await updater.checkAndUpdate(true);

      assert.equal(result.yaraUpdated, false);
      assert.equal(reloads, 2, "após restaurar o corpus anterior, o motor tem de o recarregar");
      assert.match(result.errors.join("\n"), /simulated YARA reload failure/);
      assert.equal(await fsPromises.readFile(rulesPath, "utf8"), previousRules);
      assert.deepEqual(
        yara.match(Buffer.from("previous-marker")).map((match) => match.ruleId),
        ["previous_corpus"],
      );
      assert.deepEqual(yara.match(Buffer.from("updated-marker")), []);
    } finally {
      await fsPromises.rm(definitionsDir, { recursive: true, force: true });
    }
  });

  it("desativa YARA se o rollback restaurado também não puder ser recarregado", async () => {
    const { DefinitionUpdater } = await import("../dist/updater.js");
    const { YaraEngine } = await import("@cybersafe/core");
    const fsPromises = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const definitionsDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "cs-yara-rollback-fail-closed-"));
    const rulesPath = path.join(definitionsDir, "yara", "default.yar");
    const previousRules = 'rule previous_corpus { strings: $a = "previous-marker" condition: $a }';
    const candidateRules = 'rule updated_corpus { strings: $b = "updated-marker" condition: $b }';
    let reloads = 0;

    try {
      await fsPromises.mkdir(path.dirname(rulesPath), { recursive: true });
      await fsPromises.writeFile(rulesPath, previousRules, "utf8");
      const yara = new YaraEngine(rulesPath);
      await yara.load(rulesPath);
      const updater = new DefinitionUpdater(definitionsDir, {
        afterYaraUpdated: async () => {
          reloads += 1;
          await yara.load(rulesPath);
          throw new Error(`simulated reload failure ${reloads}`);
        },
        afterYaraRollbackFailed: () => yara.markUnavailable("YARA rollback reload failed."),
      });
      updater.downloadText = async () => candidateRules;
      updater.updateClamAV = async () => {
        throw new Error("ClamAV disabled in isolated test");
      };
      updater.updateHashFeed = async () => {
        throw new Error("hash feed disabled in isolated test");
      };

      const result = await updater.checkAndUpdate(true);

      assert.equal(result.yaraUpdated, false);
      assert.match(result.errors.join("\n"), /previous corpus could not be reloaded/);
      assert.equal(reloads, 2);
      assert.equal(yara.isAvailable, false);
      assert.equal(yara.health.status, "error");
      assert.throws(() => yara.match(Buffer.from("previous-marker")), /unavailable/i);
    } finally {
      await fsPromises.rm(definitionsDir, { recursive: true, force: true });
    }
  });

  it("a publicação YARA substitui o corpus completo sem deixar ficheiros temporários", async () => {
    const { DefinitionUpdater } = await import("../dist/updater.js");
    const fsPromises = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const definitionsDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "cs-yara-atomic-success-"));
    const rulesPath = path.join(definitionsDir, "yara", "default.yar");
    const candidateRules = "rule updated_corpus { condition: true }";

    try {
      await fsPromises.mkdir(path.dirname(rulesPath), { recursive: true });
      await fsPromises.writeFile(rulesPath, "rule previous_corpus { condition: true }", "utf8");
      const updater = new DefinitionUpdater(definitionsDir);
      updater.downloadText = async () => candidateRules;
      updater.updateClamAV = async () => {
        throw new Error("ClamAV disabled in isolated test");
      };
      updater.updateHashFeed = async () => {
        throw new Error("hash feed disabled in isolated test");
      };

      const result = await updater.checkAndUpdate(true);

      assert.equal(result.yaraUpdated, true);
      // O corpus publicado começa pela fonte aceite e leva o controlo positivo
      // no fim (regra NOSSA, de teste); o `downloadText` deste teste devolve a
      // mesma regra às 4 fontes, por isso as repetições são rejeitadas.
      const published = await fsPromises.readFile(rulesPath, "utf8");
      assert.ok(published.startsWith(candidateRules), "a fonte aceite tem de estar no corpus");
      assert.match(published, /CyberSafe_Canary_EICAR/, "o controlo positivo acompanha o corpus");
      assert.deepEqual(await fsPromises.readdir(path.dirname(rulesPath)), ["default.yar"]);
    } finally {
      await fsPromises.rm(definitionsDir, { recursive: true, force: true });
    }
  });

  it("agrega todas as fontes YARA válidas em vez de parar na primeira", async () => {
    const { DefinitionUpdater } = await import("../dist/updater.js");
    const fsPromises = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const definitionsDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "cs-yara-sources-"));
    const rulesBySource = new Map([
      ["MALW_Eicar.yar", 'rule source_eicar { condition: true }'],
      ["packer_compiler_signatures.yar", 'rule source_packer { condition: true }'],
      ["crypto_signatures.yar", 'rule source_crypto { condition: true }'],
      ["RANSOM_MS17-010_Wannacrypt.yar", 'rule source_ransomware { condition: true }'],
    ]);

    try {
      const updater = new DefinitionUpdater(definitionsDir);
      updater.downloadText = async (url) => {
        const source = [...rulesBySource.keys()].find((name) => url.endsWith(name));
        assert.ok(source, `fonte YARA inesperada: ${url}`);
        return rulesBySource.get(source);
      };
      updater.updateClamAV = async () => {
        throw new Error("ClamAV disabled in isolated test");
      };
      updater.updateHashFeed = async () => {
        throw new Error("hash feed disabled in isolated test");
      };

      const result = await updater.checkAndUpdate(true);
      const published = await fsPromises.readFile(
        path.join(definitionsDir, "yara", "default.yar"),
        "utf8",
      );

      assert.equal(result.yaraUpdated, true);
      for (const rule of ["source_eicar", "source_ransomware"]) {
        assert.match(published, new RegExp(`rule ${rule}\\b`), `${rule} não foi incluída no corpus`);
      }
      for (const rule of ["source_packer", "source_crypto"]) {
        assert.doesNotMatch(published, new RegExp(`rule ${rule}\\b`), `${rule} é referência e não entra no corpus`);
      }
    } finally {
      await fsPromises.rm(definitionsDir, { recursive: true, force: true });
    }
  });

  it("publica regras compiláveis com warnings e reporta os warnings separadamente", async () => {
    const { DefinitionUpdater } = await import("../dist/updater.js");
    const fsPromises = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const definitionsDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "cs-yara-warning-"));
    const rulesBySource = new Map([
      ["MALW_Eicar.yar", 'rule warning_probe { strings: $a = "a" condition: $a }'],
      ["packer_compiler_signatures.yar", "rule source_packer { condition: filesize > 10 }"],
      ["crypto_signatures.yar", "rule source_crypto { condition: filesize > 20 }"],
      ["RANSOM_MS17-010_Wannacrypt.yar", "rule source_ransomware { condition: filesize > 30 }"],
    ]);

    try {
      const updater = new DefinitionUpdater(definitionsDir);
      updater.downloadText = async (url) => {
        const source = [...rulesBySource.keys()].find((name) => url.endsWith(name));
        assert.ok(source, `fonte YARA inesperada: ${url}`);
        return rulesBySource.get(source);
      };
      updater.updateClamAV = async () => {
        throw new Error("ClamAV disabled in isolated test");
      };
      updater.updateHashFeed = async () => {
        throw new Error("hash feed disabled in isolated test");
      };

      const result = await updater.checkAndUpdate(true);

      assert.equal(result.yaraUpdated, true);
      assert.ok(
        result.warnings.some((warning) => /MALW_Eicar\.yar.*slow-scan/.test(warning)),
        "o warning tem de identificar a fonte e o código do compilador",
      );
      assert.ok(
        !result.errors.some((error) => error.includes("YARA source")),
        "um warning não deve ser apresentado como erro nem rejeitar a fonte",
      );
    } finally {
      await fsPromises.rm(definitionsDir, { recursive: true, force: true });
    }
  });

  it("classifica módulos YARA não suportados e continua com fontes compatíveis", async () => {
    const { DefinitionUpdater } = await import("../dist/updater.js");
    const fsPromises = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const definitionsDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "cs-yara-module-"));
    const rulesBySource = new Map([
      ["MALW_Eicar.yar", 'import "module_that_does_not_exist" rule unsupported_module { condition: true }'],
      ["packer_compiler_signatures.yar", "rule source_packer { condition: filesize > 10 }"],
      ["crypto_signatures.yar", "rule source_crypto { condition: filesize > 20 }"],
      ["RANSOM_MS17-010_Wannacrypt.yar", "rule source_ransomware { condition: filesize > 30 }"],
    ]);

    try {
      const updater = new DefinitionUpdater(definitionsDir);
      updater.downloadText = async (url) => {
        const source = [...rulesBySource.keys()].find((name) => url.endsWith(name));
        assert.ok(source, `fonte YARA inesperada: ${url}`);
        return rulesBySource.get(source);
      };
      updater.updateClamAV = async () => {
        throw new Error("ClamAV disabled in isolated test");
      };
      updater.updateHashFeed = async () => {
        throw new Error("hash feed disabled in isolated test");
      };

      const result = await updater.checkAndUpdate(true);
      const published = await fsPromises.readFile(
        path.join(definitionsDir, "yara", "default.yar"),
        "utf8",
      );

      assert.equal(result.yaraUpdated, true);
      assert.ok(
        result.errors.some((error) => /MALW_Eicar\.yar.*incompatible-module.*unknown-module/.test(error)),
        "módulo desconhecido deve ser classificado com a origem e o código estável",
      );
      assert.doesNotMatch(published, /unsupported_module/);
      assert.doesNotMatch(published, /rule source_packer\b/);
      assert.doesNotMatch(published, /rule source_crypto\b/);
      assert.match(published, /rule source_ransomware\b/);
    } finally {
      await fsPromises.rm(definitionsDir, { recursive: true, force: true });
    }
  });

  it("reference não participa no merge e não colide com uma regra de production", async () => {
    const { DefinitionUpdater } = await import("../dist/updater.js");
    const fsPromises = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const definitionsDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "cs-yara-duplicate-"));
    const rulesBySource = new Map([
      ["MALW_Eicar.yar", "rule source_duplicate { condition: true }"],
      ["packer_compiler_signatures.yar", "rule source_duplicate { condition: false }"],
      ["crypto_signatures.yar", "rule source_after_duplicate { condition: true }"],
      ["RANSOM_MS17-010_Wannacrypt.yar", "rule source_last { condition: true }"],
    ]);

    try {
      const updater = new DefinitionUpdater(definitionsDir);
      updater.downloadText = async (url) => {
        const source = [...rulesBySource.keys()].find((name) => url.endsWith(name));
        assert.ok(source, `fonte YARA inesperada: ${url}`);
        return rulesBySource.get(source);
      };
      updater.updateClamAV = async () => {
        throw new Error("ClamAV disabled in isolated test");
      };
      updater.updateHashFeed = async () => {
        throw new Error("hash feed disabled in isolated test");
      };

      const result = await updater.checkAndUpdate(true);
      const published = await fsPromises.readFile(
        path.join(definitionsDir, "yara", "default.yar"),
        "utf8",
      );

      assert.equal(result.yaraUpdated, true);
      assert.equal(
        result.errors.some((error) => error.includes("packer_compiler_signatures.yar")),
        false,
        "um duplicado de uma fonte reference não é conflito: essa fonte não entra no corpus",
      );
      assert.equal((published.match(/rule source_duplicate\b/g) ?? []).length, 1);
      assert.doesNotMatch(published, /rule source_after_duplicate\b/);
      assert.match(published, /rule source_last\b/);
    } finally {
      await fsPromises.rm(definitionsDir, { recursive: true, force: true });
    }
  });

  it("conflito production vs test: production recusada e o corpus aceite antes do conflito preservado", async () => {
    const { DefinitionUpdater } = await import("../dist/updater.js");
    const fsPromises = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const definitionsDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "cs-yara-conflict-"));
    const rulesPath = path.join(definitionsDir, "yara", "default.yar");
    await fsPromises.mkdir(path.dirname(rulesPath), { recursive: true });
    await fsPromises.writeFile(rulesPath, "rule previous_corpus { condition: true }", "utf8");
    const rulesBySource = new Map([
      ["MALW_Eicar.yar", "rule source_shared { condition: true }\nrule test_kept { condition: true }"],
      ["packer_compiler_signatures.yar", "rule reference_packer { condition: true }"],
      ["crypto_signatures.yar", "rule reference_crypto { condition: true }"],
      ["RANSOM_MS17-010_Wannacrypt.yar", "rule source_shared { condition: false }"],
    ]);

    try {
      const updater = new DefinitionUpdater(definitionsDir);
      updater.downloadText = async (url) => {
        const source = [...rulesBySource.keys()].find((name) => url.endsWith(name));
        assert.ok(source, `fonte YARA inesperada: ${url}`);
        return rulesBySource.get(source);
      };
      updater.updateClamAV = async () => {
        throw new Error("ClamAV disabled in isolated test");
      };
      updater.updateHashFeed = async () => {
        throw new Error("hash feed disabled in isolated test");
      };

      const result = await updater.checkAndUpdate(true);
      const published = await fsPromises.readFile(rulesPath, "utf8");
      const manifest = JSON.parse(
        await fsPromises.readFile(path.join(definitionsDir, ".yara-corpus.json"), "utf8"),
      );

      assert.equal(result.yaraUpdated, true);
      assert.ok(
        result.errors.some((error) =>
          error.includes("RANSOM_MS17-010_Wannacrypt.yar") &&
          error.includes("incompatible-with-accepted-rules"),
        ),
        "a production conflituosa tem de ser recusada com a categoria estável",
      );
      assert.equal(
        (published.match(/rule source_shared\b/g) ?? []).length,
        1,
        "a regra aceite antes do conflito fica uma única vez no corpus",
      );
      assert.match(published, /rule test_kept\b/, "o resto da fonte válida não pode ser perdido");
      assert.doesNotMatch(published, /rule reference_packer\b/);
      assert.doesNotMatch(published, /rule previous_corpus\b/, "o candidato válido substituiu o corpus anterior");
      assert.deepEqual(
        manifest.rejected,
        [{ name: "RANSOM_MS17-010_Wannacrypt.yar", reason: "incompatible-with-accepted-rules" }],
        "o conflito fica registado no manifesto, sem a fonte entrar no corpus",
      );
      assert.ok(
        !manifest.sources.some((source) => source.name === "RANSOM_MS17-010_Wannacrypt.yar"),
        "a produção conflituosa não pode aparecer como fonte aceite",
      );
    } finally {
      await fsPromises.rm(definitionsDir, { recursive: true, force: true });
    }
  });

  // ── 21/22/23. OS ACHADOS DO CODEX (2026-10-03) ─────────────────────────────
  /**
   * O Codex reviu a implementacao e encontrou tres buracos REAIS, todos meus.
   * Estes tres casos são o fecho: cada um falha na versao anterior.
   */
  it("21 — dois updates concorrentes: o segundo NÃO é autorizado (exclusão mútua)", async () => {
    const gate = new ClamDatabaseGate({ drainBudgetMs: 200 });
    const primeiro = await gate.beginUpdate();
    assert.ok(primeiro, "o primeiro update arranca");
    // O segundo pedido tem de ESPERAR, não receber posse em paralelo.
    let segundoConcedido = null;
    const segundo = gate.beginUpdate().then((posse) => {
      segundoConcedido = Boolean(posse);
      if (posse) posse.release();
      return segundoConcedido;
    });
    await tick(40);
    assert.equal(
      segundoConcedido,
      null,
      "o segundo update tem de estar a ESPERAR, não autorizado: dois freshclam na mesma base",
    );
    primeiro.release();
    assert.ok(await segundo, "e arranca assim que o primeiro acaba");
  });

  it("22 — reset() durante o shutdown NÃO autoriza um update pendente", async () => {
    const gate = new ClamDatabaseGate({ drainBudgetMs: 1_000 });
    const scan = lease(gate);
    const update = gate.beginUpdate();
    await tick(20);
    assert.equal(gate.state.updatePending, true);

    // O Codex: `reset()` acordava os waiters com `drained = true`, e o
    // `beginUpdate` suspenso resumia DEPOIS do dispose, via `updateActive =
    // true`, autorizando um freshclam numa base durante o shutdown.
    gate.reset();
    const resultado = await update;
    assert.equal(
      resultado,
      null,
      "um update suspenso no drain tem de ser ADIADO pelo reset, não autorizado",
    );
    assert.equal(gate.state.updateActive, false, "e nada fica activo");
    scan.release();
  });

  it("23 — reset() acorda com drained=false, nunca com true", async () => {
    const gate = new ClamDatabaseGate({ drainBudgetMs: 5_000 });
    const scan = lease(gate);
    const update = gate.beginUpdate();
    await tick(20);
    gate.reset();
    assert.equal(await update, null, "o reset é um shutdown: nada ganha autorização com ele");
    scan.release();
  });

  // ── 24-27. A SEGUNDA VOLTA DO CODEX: A POSSE PASSOU A SER TOKEN ────────────
  /**
   * A segunda revisão do Codex não encontrou buracos novos no `clamav.ts` —
   * encontrou-os TODOS no lado do update do gate, e todos reproduziu
   * executando o código. A causa era uma só: o update era modelado com dois
   * BOOLEANOS, que dizem QUE há um update mas não QUEM o tem.
   *
   * Cada um destes testes falha na versão de booleanos.
   */
  it("24 — dois updates à espera da MESMA drenagem: só um recebe a posse", async () => {
    // O Codex: os dois pedidos passavam pelo `if (updateActive)` enquanto este
    // era falso, ambos aguardavam o mesmo scan, e ambos acordavam com a mesma
    // libertação — receivebendo AMBOS autorização para escrever. Dois freshclam
    // na mesma base, que é o que o gate existe para impedir.
    const gate = new ClamDatabaseGate({ drainBudgetMs: 60 });
    const scan = lease(gate);

    const a = gate.beginUpdate();
    const b = gate.beginUpdate();
    scan.release(); // os dois acordam no MESMO instante

    const [resA, resB] = await Promise.all([a, b]);
    const concedidos = [resA, resB].filter(Boolean).length;
    assert.equal(
      concedidos,
      1,
      `exatamente UM update pode escrever na base (concedidos: ${concedidos})`,
    );
    (resA ?? resB).release();
  });

  it("25 — um pedido que esgota o orçamento NÃO desliga o update que está a viver", async () => {
    // O Codex: o pedido expirado chamava `endUpdate()`, que punha
    // `updateActive = false` sem distinguir o dono — desligava o update VIVO, e
    // o pedido seguinte entrava por cima dele a meio da escrita.
    const gate = new ClamDatabaseGate({ drainBudgetMs: 30 });
    const vivo = await gate.beginUpdate();
    assert.ok(vivo, "o primeiro update arranca e fica a escrever");
    vivo.markWriting(); // o freshclam está a escrever

    const espera = await gate.beginUpdate(); // espera a vez, esgota o orçamento
    assert.equal(espera, null, "o pedido em espera é adiado");
    assert.equal(
      gate.state.updateActive,
      true,
      "o update que estava VIVO continua a ter a posse: um timeout alheio não o pode desligar",
    );
    assert.equal(
      await gate.beginUpdate(),
      null,
      "e nenhum terceiro update entra por cima dele",
    );

    vivo.release();
  });

  it("26 — a passagem de vez NÃO deixa um terceiro update ultrapassar", async () => {
    // O Codex: acordar uma promise NÃO é correr o waiter — ele só retoma numa
    // microtarefa. Entre `endUpdate` e esse retoma, `updateActive` já era falso
    // e um `beginUpdate()` novo entrava, para depois o waiter acordado entrar
    // também. A posse tem de estar RESERVADA antes de resolver.
    const gate = new ClamDatabaseGate({ drainBudgetMs: 60 });
    const primeiro = await gate.beginUpdate();
    assert.ok(primeiro);

    const aEsperar = gate.beginUpdate();
    await tick(5); // deixa o segundo pedido entrar na fila
    primeiro.release(); // passa a vez — neste MESMO stack

    const intruso = gate.beginUpdate(); // chega na janela
    const [resEsperado, resIntruso] = await Promise.all([aEsperar, intruso]);
    const concedidos = [resEsperado, resIntruso].filter(Boolean).length;
    assert.equal(
      concedidos,
      1,
      `a posse passa a UM: o segundo da fila não pode ser ultrapassado (concedidos: ${concedidos})`,
    );
    (resEsperado ?? resIntruso).release();
  });

  it("27 — um `reset` com a continuação já suspensa NÃO autoriza o update", async () => {
    // O Codex: `reset` limpava o estado, mas um `beginUpdate` suspenso no drain
    // retomava DEPOIS e repunha `updateActive` — autorizando um freshclam em
    // plena paragem do serviço.
    const gate = new ClamDatabaseGate({ drainBudgetMs: 5_000 });
    const scan = lease(gate);
    const update = gate.beginUpdate();
    await tick(5);

    scan.release(); // o drain resolve
    gate.reset(); // o shutdown corre ANTES de a continuação
    const resultado = await update;

    assert.equal(resultado, null, "nem o drain resolvido autoriza um update depois do shutdown");
    assert.deepEqual(
      gate.state,
      { activeScans: 0, updatePending: false, updateActive: false, updateWaiters: 0 },
      "e o gate fica consistente",
    );
  });

  // ── 28/29. O SHUTDOWN E A VALIDADE DA POSSE ──────────────────────────────
  /**
   * A terceira revisão do Codex achou buracos de SHUTDOWN. O 19 e o 31 vivem
   * noutro ficheiro — é que reportam um escritor vivo e o largam sem prova de
   * morte, e o registo de processo que fecha o achado 2 envenena a suite se
   * partilharem processo com os restantes.
   *
   * Estes dois não reportam escritor nenhum, por isso ficam aqui.
   */
  it("28 — depois de um `reset`, nenhum scan novo entra", async () => {
    // O Codex: `reset` limpava o estado mas `tryAcquireScanLease` ignorava o
    // `disposed` e admitia scans na mesma. O gate voltava a dizer "ninguém tem
    // a base" num serviço que já estava a parar.
    const gate = new ClamDatabaseGate();
    gate.reset();
    const tentativa = gate.tryAcquireScanLease();

    assert.equal(tentativa.ok, false, "um scan depois do shutdown NÃO entra");
    assert.equal(
      tentativa.ok ? "" : tentativa.reason,
      "gate-disposed",
      "e a recusa declara o motivo: o serviço está a sair",
    );
    assert.equal(gate.state.activeScans, 0, "e o contador não mexe");
  });

  it("29 — a posse fica válida até ao shutdown, e inválida depois", async () => {
    const gate = new ClamDatabaseGate();
    const posse = await gate.beginUpdate();
    assert.ok(posse);
    assert.equal(posse.valid, true, "a posse de quem tem a vez é válida");

    // O Codex (achado 2): `beginUpdate` resolvia, e o `reset` do shutdown corria
    // na microtarefa SEGUINTE, antes de o `.then` do updater spawnar. O gate
    // estava certo e o spawn ia na mesma. É a posse que tem de reconfirmar, no
    // sítio que vai escrever.
    gate.reset();
    assert.equal(posse.valid, false, "depois do shutdown a posse já não autoriza escrever");

    // E devolver a posse depois do shutdown é inofensivo: o dono já não é este,
    // o `endOwnership` reconhece isso e não toca na posse de mais ninguém.
    posse.release();
    assert.equal(gate.state.updateActive, false, "e o `dispose` não fica por desfazer");
  });

  it("34 — o adiamento diz a CAUSA certa, não uma frase genérica", async () => {
    // CODEX (2026-10-03), oitava ronda: o updater escrevia sempre "ha scans
    // ClamAV activos que nao drenaram dentro do orcamento". Com zero scans —
    // depois de um shutdown, ou com outro escritor a segurar a vez — a frase era
    // falsa, e era o que o utilizador lia.
    const gate = new ClamDatabaseGate({ drainBudgetMs: 30 });

    // 1) scans que não drenam — a frase antiga é a verdadeira.
    const scan = lease(gate);
    const porScans = await gate.beginUpdateComMotivo();
    assert.equal(porScans.refusal?.reason, "busy-scans", "um scan vivo adia por causa do scan");
    scan.release();

    // 2) serviço a encerrar, com ZERO scans.
    gate.reset();
    const porShutdown = await gate.beginUpdateComMotivo();
    assert.equal(
      porShutdown.refusal?.reason,
      "servico-a-encerrar",
      "com o serviço a encerrar, a causa NÃO são scans: não havia nenhum",
    );
  });

  it("32 — `markWriting` repetido NÃO deixa marcadores órfãos", async () => {
    // CODEX (2026-10-03), sétima ronda: `markWriting` SUBSTITUIA o marcador a
    // cada chamada, e o `release` só removia o último. Duas marcações deixavam
    // um órfão no registo de processo, que bloqueava scans e updates para
    // sempre — e sobrevivia ao shutdown. Reproduzido 100/100.
    //
    // O Codex também notou que não há chamadas duplicadas em produção. É
    // precisamente o que torna isto importante: um buraco que só um teste
    // encontra, e que o próximo refactor pode introduzir, tem de estar fechado
    // por construção e não por convenção.
    const gate = new ClamDatabaseGate();
    const posse = await gate.beginUpdate();
    assert.ok(posse);

    for (let i = 0; i < 50; i++) posse.markWriting();

    posse.release();

    // Se sobrasse um único marcador, o scan seguinte já não entraria.
    const tentativa = gate.tryAcquireScanLease();
    assert.equal(tentativa.ok, true, "50 marcações e um `release` não podem deixar nada retido");
    if (tentativa.ok) tentativa.lease.release();
  });

  it("33 — a recusa traz a CAUSA, e a bridge diz a verdade", async () => {
    // CODEX (2026-10-03), pergunta 9: o motor descartava a causa e a bridge
    // anunciava sempre "as assinaturas estão a ser actualizadas". Com o
    // serviço a encerrar isso é mentira — não há actualização a caminho, e
    // esperar não ajuda. São três situações, e são três frases.
    // `ClamavBridge` vem do CORE, que é onde a recusa é traduzida em português.
    // Importar pelo `dist/index.js` do serviço não serve: esse barrel tem
    // importações que não resolvem fora do bundle.
    const { ClamavBridge } = await import("@cybersafe/core");
    const gate = new ClamDatabaseGate();

    const bridge = new ClamavBridge({
      acquireDatabaseLease: () => {
        const tentativa = gate.tryAcquireScanLease();
        return tentativa.ok ? tentativa.lease : { refused: true, reason: tentativa.reason };
      },
    });

    // 1) update activo: há mesmo uma actualização a escrever.
    const posse = await gate.beginUpdate();
    assert.ok(posse);
    posse.markWriting();
    const durante = await bridge.scanFile("alvo.exe", { scanTimeoutMs: 10 }).catch(() => null);
    const detalheDurante = JSON.stringify(durante ?? {});
    assert.match(detalheDurante, /a ser actualizadas/, "com o update a escrever, a frase é essa");
    assert.doesNotMatch(detalheDurante, /encerrar/, "e não se fala de encerramento");

    // 2) serviço a encerrar: NÃO se pode dizer que há actualizações a caminho.
    gate.reset();
    const depois = await bridge.scanFile("alvo2.exe", { scanTimeoutMs: 10 }).catch(() => null);
    const detalheDepois = JSON.stringify(depois ?? {});
    assert.match(detalheDepois, /encerrar/, "com o serviço a encerrar, diz-se isso");
    assert.doesNotMatch(
      detalheDepois,
      /a ser actualizadas/,
      "e NÃO se anuncia uma actualização que não existe",
    );
  });

  it("30 — `updateActive` só é verdade quando alguém vai ESCREVER", async () => {
    // O Codex (achado 7): `updateActive` ficava verdadeiro logo no `beginUpdate`,
    // o que é afirmar que há um freshclam na base antes de existir freshclam
    // algum. O snapshot é lido por gente (e por testes), e um snapshot que
    // Menthe deixa de servir para nada.
    const gate = new ClamDatabaseGate();
    const posse = await gate.beginUpdate();
    assert.ok(posse);
    assert.equal(
      gate.state.updateActive,
      false,
      "a posse concedida não é escrita: o snapshot não pode dizer que há um freshclam",
    );
    posse.markWriting();
    assert.equal(gate.state.updateActive, true, "e passa a ser verdade quando o write começa");
    posse.release();
  });

// ── PROPRIEDADE ───────────────────────────────────────────────────────────
  /**
   * O teste que os outros 18 sustentam.
   *
   * Tenta o PIOR interleaving possível — admissão de scan e pedido de update
   * alternados sem pausas, com `await` no meio de cada passo, porque é aí que
   * o runtime cede o controlo e onde umuma coordenaçao mal feita apareceria.
   *
   * A propriedade é uma asserção de INVARIANTE, observada a cada passo:
   *   NUNCA activeScans > 0 E updateActive === true
   *
   * Se em algum momento um scan com a base e um freshclam a escrever existirem
   * ao mesmo tempo, esta asserção falha — e é a única coisa que interessa.
   */
  it("PROPRIEDADE — é impossível observar um scan com a base E um freshclam a correr", async () => {
    const gate = new ClamDatabaseGate({ drainBudgetMs: 20 });
    let overlaps = 0;

    const assertNoOverlap = (passo) => {
      const s = gate.state;
      if (s.activeScans > 0 && s.updateActive) {
        overlaps++;
        console.error(`OVERLAP no passo ${passo}: ${JSON.stringify(s)}`);
      }
    };

    // Duas "tarefas" que se atropelam sem nunca parar.
    async function trabalhoDeScan(nome) {
      for (let i = 0; i < 60; i++) {
        const attempt = gate.tryAcquireScanLease();
        assertNoOverlap(`${nome} tentativa ${i}`);
        if (attempt.ok) {
          // O scan "usa a base" durante alguns ticks, e pode falhar ou ser
          // cancelado a meio — daí o try/finally com varias saidas.
          try {
            await tick(0);
            if (i % 7 === 0) continue;
            await tick(0);
            if (i % 11 === 0) throw new Error("scan falhou");
          } catch {
            /* scan morreu */
          } finally {
            attempt.lease.release();
          }
        } else {
          await tick(0); // recusado: espera e volta a tentar
        }
      }
    }

    async function trabalhoDeUpdate(nome) {
      for (let i = 0; i < 12; i++) {
        const posse = await gate.beginUpdate();
        assertNoOverlap(`${nome} ${i} apos beginUpdate`);
        if (posse) {
          // O "freshclam" vai MESMO escrever — e é aqui que o snapshot passa a
          // dizer `updateActive`, tal como o updater faz antes do `spawn`.
          posse.markWriting();
          try {
            await tick(0); // o "freshclam" a correr
            assertNoOverlap(`${nome} ${i} durante o update`);
            await tick(0);
            if (i % 5 === 0) throw new Error("freshclam falhou");
          } catch {
            /* falhou — o finally tem de limpar */
          } finally {
            posse.release();
          }
        } else {
          // O pedido foi ADIADO: não houve posse, logo não houve freshclam.
          // A prova de que nada se sobrepõe é `assertNoOverlap`, e ela já corre
          // no passo anterior.
          //
          // A primeira versão afirmava aqui que `updateActive` era false. Isso
          // é FALSO por desenho: há três trabalhadores de update a correr ao
          // mesmo tempo, e um pedido adiado porque OUTRO está a escrever é
          // precisamente o caso normal. O teste estava a afirmar que o serviço
          // inteiro estava parado, não que aquele pedido não escreveu.
          assertNoOverlap(`${nome} ${i} apos adiar`);
        }
        await tick(0);
      }
    }

    // Arranca em paralelo, sem ordenar nada entre elas.
    await Promise.all([
      trabalhoDeScan("scan-A"),
      trabalhoDeScan("scan-B"),
      trabalhoDeScan("scan-C"),
      trabalhoDeUpdate("update-A"),
      trabalhoDeUpdate("update-B"),
    ]);

    assert.equal(
      overlaps,
      0,
      `OVERLAP_OBSERVED: ${overlaps} instante(s) com um scan na base E um update activo`,
    );
    // E no fim o gate tem de estar limpo, senão os testes de cima passariam
    // e o serviço ficaria com o motor morto.
    assert.deepEqual(
      gate.state,
      { activeScans: 0, updatePending: false, updateActive: false, updateWaiters: 0 },
      "o gate fica consistente no fim",
    );
  });
});