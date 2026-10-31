/**
 * TESTE E2E DO CAMINHO DE PRODUÇÃO (opt-in): `stageWorkspaces()` real.
 *
 * R1: o R0 testava os helpers e uma árvore montada à mão; não executava
 * `stageWorkspaces` (passos 1–7 do pipeline) e por isso não apanhava o wiring
 * errado das versões. Este teste corre a FUNÇÃO DE PRODUÇÃO, depois mede o que
 * ela devolveu:
 *
 *   1. compila workspaces + renderer, empacota os tarballs e faz o
 *      `npm install --omit=dev` do staging (igual ao build verdadeiro);
 *   2. dentro de `stageWorkspaces`: higiene de `file:`, pins exactos medidos
 *      contra o lock, remoção dos dois lockfiles de instalação e rebuild dos
 *      addons para a ABI do Electron (node-gyp 12.1.0);
 *   3. depois do retorno: confirma no disco que os metadados de instalação
 *      desapareceram, que as versões fixadas se mantêm, que a ABI é 130 e que
 *      não sobreviveu nenhum caminho do staging;
 *   4. sonda no Electron 33.4.11 (CWD fora do repo): SQLite CREATE/INSERT/
 *      SELECT/reopen e uma regra YARA-X explícita de teste em ficheiro benigno.
 *
 * Não gera candidata, não corre electron-builder, não toca no gate. A árvore
 * de staging é removida quando o teste passa; numa falha fica o caminho no log.
 *
 * Uso:
 *   CYBERSAFE_STAGING_E2E=1 node --test scripts/test/staging-sqlite-runtime.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { execFileSync } from "node:child_process";

import {
  electronAbi,
  stageWorkspaces,
  verifyNativeAddons,
  verifyStagingSafety,
} from "../package-windows.mjs";
import { describeStagingDrift, expectedStagingVersions, verifyStagedVersions } from "../staging-dependency-pins.mjs";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const LOCK = path.join(REPO_ROOT, "package-lock.json");
const PROBE = path.join(HERE, "fixtures", "staging-runtime-probe.mjs");
const ELECTRON_EXE = path.join(REPO_ROOT, "node_modules", "electron", "dist", "electron.exe");

const enabled = process.env.CYBERSAFE_STAGING_E2E === "1";

describe(
  "staging de produção — pinos, ABI 130 e runtime",
  { skip: !enabled && "define CYBERSAFE_STAGING_E2E=1 para correr (build de workspaces + npm install + rebuild nativo)" },
  () => {
    it("stageWorkspaces produz uma árvore fixada, sem metadados de instalação, e o Electron executa SQLite e YARA", () => {
      const electronVersion = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "node_modules", "electron", "package.json"), "utf8")).version;
      assert.equal(electronVersion, "33.4.11", "a versão do Electron do repositório mudou: reconfirmar headers e ABI");
      const targetAbi = electronAbi(electronVersion);
      assert.equal(targetAbi, 130);
      const expected = expectedStagingVersions({ lockFile: LOCK, platform: process.platform, arch: process.arch });

      let stagingRoot = null;
      let passed = false;
      try {
        // 1–7 do pipeline, SEM electron-builder e SEM candidata.
        const result = stageWorkspaces();
        stagingRoot = result.stagingRoot;
        const appDir = result.appDir;
        assert.ok(stagingRoot.startsWith(os.tmpdir()), `staging fora de %TEMP%: ${stagingRoot}`);

        // O passo de produção 7b tem de ter removido os dois lockfiles.
        assert.equal(fs.existsSync(path.join(appDir, "package-lock.json")), false, "package-lock.json de instalação sobreviveu ao stage");
        assert.equal(
          fs.existsSync(path.join(appDir, "node_modules", ".package-lock.json")),
          false,
          ".package-lock.json de instalação sobreviveu ao stage",
        );
        // Recursos de runtime que o passo NÃO pode ter apagado.
        for (const relative of [
          "node_modules/better-sqlite3/package.json",
          "node_modules/better-sqlite3/build/Release/better_sqlite3.node",
          "node_modules/@litko/yara-x/package.json",
          "node_modules/@cybersafe/core/package.json",
          "node_modules/@cybersafe/core/definitions/yara/default.yar",
        ]) {
          assert.equal(fs.existsSync(path.join(appDir, ...relative.split("/"))), true, `recurso de runtime ausente: ${relative}`);
        }

        // O binário nativo do YARA-X pode ficar içado ou aninhado no wrapper.
        const yaraAddon = [
          "node_modules/@litko/yara-x-win32-x64-msvc/yara-x.win32-x64-msvc.node",
          "node_modules/@litko/yara-x/node_modules/@litko/yara-x-win32-x64-msvc/yara-x.win32-x64-msvc.node",
        ].some((relative) => fs.existsSync(path.join(appDir, ...relative.split("/"))));
        assert.equal(yaraAddon, true, "binário nativo do YARA-X ausente no staging");

        // Versões fixadas continuam a ser as do lock (medição pós-stage).
        const staged = verifyStagedVersions(appDir, expected);
        assert.equal(staged.ok, true, `deriva de versões: ${describeStagingDrift(staged)}`);
        for (const entry of expected) {
          assert.ok(staged.checked.some((item) => item.name === entry.name && item.actual === entry.version), `${entry.name} ${entry.version}`);
        }

        // ABI medida de novo na árvore devolvida pela produção.
        const native = verifyNativeAddons(appDir, { targetAbi });
        assert.equal(native.ok, true, `addons com ABI errada: ${native.problems.join("; ")}`);
        assert.ok(native.addons.length >= 2, `esperava pelo menos 2 addons, medi ${native.addons.length}`);

        // Nenhum caminho do staging pode ter ficado dentro do pacote.
        const safety = verifyStagingSafety(appDir, {
          forbiddenContent: [stagingRoot, stagingRoot.replaceAll("\\", "/")],
        });
        assert.equal(safety.ok, true, `staging recusado: ${JSON.stringify(safety.problems.slice(0, 5))}`);

        // Sonda no Electron real, CWD fora do repositório.
        const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "cybersafe-qa2-probe-"));
        const dbPath = path.join(probeDir, "qa2-engines.db");
        const benignFile = path.join(probeDir, "benigno.txt");
        fs.writeFileSync(benignFile, "ficheiro benigno de ensaio; marcador CYBERSAFE_QA2_BENIGN_MARKER\n");
        const output = execFileSync(ELECTRON_EXE, [PROBE, appDir, dbPath, benignFile], {
          cwd: probeDir,
          encoding: "utf8",
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
          timeout: 120_000,
        });
        fs.rmSync(probeDir, { recursive: true, force: true });
        const probe = JSON.parse(output.trim().split(/\r?\n/).pop());
        assert.equal(probe.error, null, `sonda falhou: ${probe.error}`);
        assert.equal(probe.electronVersion, "33.4.11");
        assert.equal(probe.abi, 130);
        assert.equal(probe.betterSqlite3.version, "12.10.0");
        assert.equal(probe.betterSqlite3.created, true);
        assert.equal(probe.betterSqlite3.selected, true);
        assert.equal(probe.betterSqlite3.persistedAfterReopen, 1);
        assert.match(probe.betterSqlite3.sqliteVersion, /^3\.\d+\.\d+$/);
        assert.equal(probe.yara.wrapperVersion, "0.5.0");
        assert.equal(probe.yara.nativeVersion, "0.5.0");
        assert.equal(probe.yara.compiled, true);
        assert.equal(probe.yara.matched, true, `regra de teste não casou: ${JSON.stringify(probe.yara)}`);
        assert.deepEqual(probe.yara.matchedRules, ["cybersafe_qa2_benign_marker"]);
        assert.ok(!path.resolve(probe.cwd).toLowerCase().startsWith(REPO_ROOT.toLowerCase()), `CWD dentro do repo: ${probe.cwd}`);
        assert.ok(!fs.readFileSync(PROBE, "utf8").includes("EICAR"));
        process.stderr.write(`${JSON.stringify(probe)}\n`);
        passed = true;
      } finally {
        if (passed && stagingRoot) {
          fs.rmSync(stagingRoot, { recursive: true, force: true });
        } else if (stagingRoot) {
          process.stderr.write(`[staging-e2e] árvore preservada para inspeção: ${stagingRoot}\n`);
        }
      }
    });
  },
);
