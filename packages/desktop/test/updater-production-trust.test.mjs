import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createProductionUpdater } from "../src/updater/production.ts";

/**
 * O que a suíte de 138 testes do updater NÃO exercia: `createProductionUpdater`
 * era apenas mencionada numa regex ao código-fonte
 * (`dev-windows-readonly-boundary.test.mjs:987`). Ou seja, o ramo que decide se o
 * canal é consultado — `production.ts:14-17` — nunca foi invocado num teste.
 *
 * Este ficheiro invoca-o de facto e fixa o comportamento atual: com
 * `release-trust.json` sem chave pública, o updater de produção tem de nascer
 * `unconfigured` e recusar check e install sem tocar em rede nem instalador.
 *
 * É um trip-wire, não uma aprovação: quando a chave pública real do proprietário
 * for pinada (`enabled:true` + PEM + fingerprint), o teste 4 passa a falhar se
 * alguém ativar o canal a meio, e os testes 1-3 passam a exigir revisão consciente
 * — a recusa deixa de ser explicada por «sem chave» e passa a ter de ser explicada
 * por outra coisa qualquer.
 */

const trustPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "updater",
  "release-trust.json",
);
const trust = JSON.parse(fs.readFileSync(trustPath, "utf-8"));

function opts(extra = {}) {
  return {
    runtimeSupported: true,
    installedVersion: "0.1.11",
    cacheDir: path.join(process.cwd(), ".fixture-cache-que-nao-existe"),
    installedBuild: "build-de-teste",
    installedCommit: "0000000",
    ...extra,
  };
}

describe("updater de produção — gate de confiança, medido no código real", () => {
  it("com a trust atual (sem chave), nasce unconfigured em vez de consultar o canal", async () => {
    const u = createProductionUpdater(opts());
    assert.equal(u.snapshotCopy().phase, "unconfigured");
    const r = await u.check();
    assert.equal(r.ok, false, "sem chave aprovada nao pode haver pedido de atualização");
    assert.equal(r.error, "unconfigured");
  });

  it("runtime suportado e cacheDir valido nao bastam: a recusa nao e do ambiente", () => {
    // Se algum dia a recusa depender de `runtimeSupported` ou do directório de
    // cache, este caso passa a ser falso — e é mesmo essa a distinção que importa
    // não perder: ambiente limitado pode dizer `unsupported`; falta de aprovação
    // diz `unconfigured`.
    const u = createProductionUpdater(opts({ runtimeSupported: true }));
    assert.equal(u.snapshotCopy().phase, "unconfigured");
    const semCache = createProductionUpdater(opts({ cacheDir: "" }));
    assert.equal(semCache.snapshotCopy().phase, "unconfigured");
  });

  it("install recusa antes de qualquer execução de instalador", async () => {
    const u = createProductionUpdater(opts());
    const r = await u.install({ confirmed: true, expectedVersion: "0.2.0" });
    assert.equal(r.ok, false, "sem canal aprovado nao ha instalador para executar");
  });

  it("a trust publicada esta completa OU esta fechada — nunca a meio", () => {
    const semChave = trust.enabled !== true;
    if (semChave) {
      assert.equal(
        trust.publicKeyPem,
        "",
        "`enabled:false` com chave pinada é uma contradição: ou o canal está ligado, ou não está",
      );
      assert.equal(trust.pinnedKeyFingerprint, "");
      return;
    }
    assert.ok(
      typeof trust.publicKeyPem === "string" && trust.publicKeyPem.includes("BEGIN"),
      "canal ativo exige PEM real do proprietário",
    );
    assert.match(String(trust.pinnedKeyFingerprint), /^[0-9a-f]{16,}$/i, "canal ativo exige fingerprint");
    assert.equal(
      trust.publisherLabel,
      "CyberSafe Assistant — academic unsigned",
      "o rótulo do publicador não muda sem decisão explícita",
    );
  });

  it("o feed so pode ser o repositorio oficial por HTTPS", () => {
    assert.match(
      String(trust.feedManifestUrl),
      /^https:\/\/github\.com\/MatrixChill\/cybersafe-assistant\/releases\/(latest\/)?download\/.+\.json$/,
      "fora do repositório oficial não há canal",
    );
  });
});
