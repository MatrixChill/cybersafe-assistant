import { test, describe } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import { PIPE_NAME } from "@cybersafe/core";
import { resolveDevProfile } from "../src/dev-isolation.ts";

/**
 * P0-ISOLAR-ELECTRON-DEV — o perfil de DEV não pode tocar em nada da instalação.
 *
 * ── O risco, medido a 18/10 ───────────────────────────────────────────────
 * Com o CyberSafe instalado a correr (7 processos `CyberSafe Assistant`), um
 * `electron .` de dev partilhava três coisas com ele:
 *   1. `PIPE_NAME` (constante única de `@cybersafe/core`) → o `ServiceClient` de
 *      dev podia autenticar contra o serviço de proteção da instalação;
 *   2. `app.setName("CyberSafe")` + `requestSingleInstanceLock()` → lock e
 *      AppUserModelId do utilizador;
 *   3. `configureAutoStart()` → `app.setLoginItemSettings({openAtLogin:false})`
 *      com o nome "CyberSafe", que pode APAGAR a entrada de arranque da
 *      instalação enquanto o utilizador está em teste humano.
 * Este ficheiro é o contrato do isolamento. Não abre sockets nem escreve em
 * disco: resolve apenas o perfil, a partir de `isPackaged` e de `env`.
 *
 * Produção tem de continuar exatamente como está — as asserções com `isPackaged:
 * true` são a prova de que o default não mudou.
 */

const REAL_APPDATA = path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"));
const TMP = os.tmpdir();

describe("resolveDevProfile — DEV isolado", () => {
  test("dev não usa o pipe do serviço instalado", () => {
    const p = resolveDevProfile({ isPackaged: false, env: {} });
    assert.notEqual(p.pipeName, PIPE_NAME, "pipe partilhado = dev ligado ao serviço da instalação");
    assert.match(p.pipeName, /cybersafe/, "tem de continuar a ser um pipe do produto");
    assert.match(p.pipeName, /dev/i, "o nome tem de dizer que é dev");
  });

  test("dev usa a porta 4100 e nunca a 4000 da instalação", () => {
    const p = resolveDevProfile({ isPackaged: false, env: {} });
    assert.equal(p.apiPort, 4100);
    assert.notEqual(p.apiPort, 4000);
  });

  test("4100 ocupada ⇒ escolhe a seguinte livre e reporta a escolha", () => {
    const ocupadas = new Set([4100]);
    const p = resolveDevProfile({ isPackaged: false, env: {}, portasOcupadas: ocupadas });
    assert.equal(p.apiPort, 4101);
    assert.ok(p.apiPortNao >= 4100, "nunca desce para baixo da banda dev");
  });

  test("dev tem userData, sessão e instance id próprios, fora do perfil real", () => {
    const p = resolveDevProfile({ isPackaged: false, env: {} });
    for (const dir of [p.userDataDir, p.sessionDir]) {
      assert.ok(dir, "falta o diretório isolado");
      assert.ok(!dir.startsWith(REAL_APPDATA), `dev a escrever no perfil do utilizador: ${dir}`);
      assert.ok(dir.startsWith(TMP) || dir.includes("cybersafe-dev"), `fora da área dev: ${dir}`);
    }
    assert.ok(p.appName && p.appName !== "CyberSafe", "o nome tem de distinguir do artefacto");
    assert.ok(p.instanceId && p.instanceId.length >= 8, "instance id ausente");
    assert.notEqual(p.instanceId, p.appName, "instance id não é só o nome");
  });

  test("base de dados só em caminho temporário; caminho real é recusado", () => {
    const p = resolveDevProfile({ isPackaged: false, env: {} });
    assert.ok(p.dbPath.startsWith(TMP), `CYBERSAFE_DB_PATH fora do temp: ${p.dbPath}`);

    const realNoPerfil = path.join(REAL_APPDATA, "CyberSafe Assistant", "data", "cybersafe.db");
    assert.throws(
      () => resolveDevProfile({ isPackaged: false, env: { CYBERSAFE_DB_PATH: realNoPerfil } }),
      /APPDATA|perfil|real/i,
      "apontar a base do utilizador em dev tem de rebentar, não silenciar",
    );
  });

  test("dev não arranca nem liga o serviço de proteção, e não mexe no arranque", () => {
    const p = resolveDevProfile({ isPackaged: false, env: {} });
    assert.equal(p.protectionService, false, "opção (e): dev sem serviço de proteção");
    assert.equal(p.autoStart, false, "setLoginItemSettings em dev pode apagar a entrada da instalação");
  });

  test("o renderer dev recebe a base da API, sem URL fixo no componente", () => {
    const p = resolveDevProfile({ isPackaged: false, env: { CYBERSAFE_DEV_PORT: "4177" } });
    assert.equal(p.apiPort, 4177);
    assert.equal(p.apiBase, `http://127.0.0.1:${p.apiPort}`);
    assert.equal(p.injectApiBaseInRenderer, true);
  });
});

describe("resolveDevProfile — produção intacta", () => {
  test("empacotado devolve exatamente os valores de hoje", () => {
    const p = resolveDevProfile({ isPackaged: true, env: {} });
    assert.equal(p.pipeName, PIPE_NAME, "o artefacto não pode mudar de pipe");
    assert.equal(p.apiPort, 4000, "a API do artefacto continua na 4000");
    assert.equal(p.appName, "CyberSafe");
    assert.equal(p.userDataDir, undefined, "empacotado usa o userData do Electron");
    assert.equal(p.dbPath, undefined, "empacotado não recebe base temporária");
    assert.equal(p.protectionService, true);
    assert.equal(p.autoStart, true);
  });

  test("variáveis de dev não vazam para o artefacto", () => {
    const p = resolveDevProfile({
      isPackaged: true,
      env: { CYBERSAFE_DEV_PORT: "4100", CYBERSAFE_DB_PATH: path.join(TMP, "x.db") },
    });
    assert.equal(p.apiPort, 4000);
    assert.equal(p.pipeName, PIPE_NAME);
    assert.equal(p.dbPath, undefined);
  });

  test("empacotado com otim-in de isolamento RECUSA em vez de ignorar", () => {
    assert.throws(
      () => resolveDevProfile({ isPackaged: true, env: { CYBERSAFE_DEV_ISOLATION: "1" } }),
      /ISOLAMENTO RECUSADO/,
      "um pedido explicito de isolamento num runtime empacotado nao pode ser silenciado",
    );
  });
});
