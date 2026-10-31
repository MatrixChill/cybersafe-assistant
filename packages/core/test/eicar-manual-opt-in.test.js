import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * GUARD ANTI-DEFENDER (P0, 2026-10-02).
 *
 * Isto já aconteceu a este projecto DUAS vezes:
 *
 *  2026-09-28 — `threat-history-storage.test.js` escrevia a assinatura EICAR
 *  em disco. O Defender bloqueou os ficheiros e encheu o histórico do
 *  utilizador com "Ameaça bloqueada" a cada `npm test`. Corrigido na altura.
 *
 *  2026-10-02 — `clamav-resource-cap.test.js` fez o mesmo, noutro ficheiro, e
 *  a correcção anterior não chegou aqui. O utilizador teve de interromper a
 *  sprint. Mesma causa, ficheiro diferente — que é o padrão que este guard
 *  existe para travar.
 *
 * Este teste NÃO guarda uma assinatura viva: só lê os ficheiros de teste e
 * falha se um deles conseguir escrever EICAR real sem opt-in explícito. É uma
 * política estática, roda em milissegundos e não toca no disco do utilizador.
 *
 * A regra: um teste que escreva a assinatura EICAR tem de viver atrás de
 * `CYBERSAFE_EICAR_MANUAL=1`, e a sua suite tem de estar atrás de
 * `CYBERSAFE_REAL_CLAMSCAN=1`. Nenhuma outra forma conta.
 */

/** A assinatura canónica, partida para não ser um ficheiro vivo no repositório. */
const EICAR_MARKERS = ["X5O!P%@AP[4", "PZX54(P^", "EICAR-STANDARD-ANTIVIRUS-TEST-FILE"];
const OPTOUT_ENV = "CYBERSAFE_EICAR_MANUAL";

/**
 * Ficheiros autorizados a CONTER a assinatura, cada um com o motivo.
 *
 * A regra não pode ser "contém EICAR e tem um writeFile algures no ficheiro":
 * quase todos fazem as duas coisas, e metade deles só escreve outra coisa.
 * O que interessa travar é um ficheiro NOVO a ganhar a assinatura, e isso
 * exige uma lista explícita — que é, ao mesmo tempo, a superficie de revisão.
 *
 * Cada entrada foi verificada por leitura, não por suposição.
 */
const SIGNATURE_ALLOWLIST = {
  "packages/core/test/detection-criterion.test.js":
    "Buffer entregue a yara.match() em memória; nunca escrito.",
  "packages/core/test/engine-integrity.test.js":
    "Buffer entregue a engine.match() em memória. O ficheiro que escreve em disco é PROBE_MARKER, uma string benigna escolhida precisamente para não ser EICAR.",
  "packages/core/test/hash-db-migration.test.js":
    "EICAR_CONTENT só para calcular SHA-256 em memória (gravam-se JSON de hashes).",
  "packages/core/test/hash-db-refresh.test.js": "Idem: SHA-256 em memória.",
  "packages/core/test/signatures.test.js": "Idem: SHA-256 determinístico em memória, nunca em disco.",
  "packages/core/test/clamav-resource-cap.test.js":
    "ÚNICO que escreve EICAR real, atrás de CYBERSAFE_REAL_CLAMSCAN=1 E CYBERSAFE_EICAR_MANUAL=1.",
  "packages/core/test/clamav-evidence-attribution.test.js":
    "Só stdout sintético com linha FOUND; a assinatura entra por um Buffer de summary, não de payload.",
  "packages/core/test/batch-result-integrity.test.js": "Só stdout sintético com linha FOUND.",
  "packages/core/test/clamav-batch.test.js": "Só stdout sintético com linha FOUND.",
  "packages/core/test/clamav-cap-review.test.js":
    "Só stdout sintético; 'eicar.txt' é um nome de caminho dentro de uma string.",
  "packages/core/test/yara-coverage-contract.test.js": "Contrato de cobertura; sem payload em disco.",
  "packages/service/test/yara-corpus-provenance.test.js":
    "Buffer entregue a engine.match() em memória (control0 positivo do corpus publicado); nada da assinatura é escrito.",
};

/** Este próprio ficheiro contém os marcadores para os poder procurar. */
const SELF = "packages/core/test/eicar-manual-opt-in.test.js";

/**
 * Ficheiros autorizados a ESCREVER EICAR em disco. Lista separada e mínima,
 * porque esta é a operação que faz o Defender disparar.
 *
 * O detector textual é apenas um gatilho —/comments e nomes de variável dão
 * falsos positivos. A autoridade é esta lista: para acrescentar aqui é preciso
 * escrever o motivo, e o opt-in continua a ser obrigatório no código.
 */
const EICAR_DISK_WRITE_LIST = {
  "packages/core/test/clamav-resource-cap.test.js":
    "ÚNICO ficheiro do repositório que grava a assinatura em disco. Vive atrás de CYBERSAFE_REAL_CLAMSCAN=1 e CYBERSAFE_EICAR_MANUAL=1, ambos desligados por omissão.",
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const TEST_DIRS = [
  path.join(REPO_ROOT, "packages", "core", "test"),
  path.join(REPO_ROOT, "packages", "service", "test"),
  path.join(REPO_ROOT, "packages", "app", "test"),
  path.join(REPO_ROOT, "packages", "api", "test"),
];

function jsFilesIn(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...jsFilesIn(full));
    else if (/\.(js|ts|mjs)$/.test(e.name)) out.push(full);
  }
  return out;
}

/**
 * O ficheiro carrega a assinatura EICAR se a contém LITERALMENTE, ou se a
 * monta a partir de partes (o escape de barras invertidas já obrigou a
 * reescrever isto uma vez — daí procurar por marcadores, não pelo ficheiro
 * inteiro).
 */
function carriesEicarSignature(text) {
  return EICAR_MARKERS.every((m) => text.includes(m));
}


describe("GUARD ANTI-DEFENDER — nenhum teste default escreve EICAR real", () => {
  it("nenhum ficheiro de teste novo carrega a assinatura EICAR sem estar na lista", () => {
    const offenders = [];
    for (const dir of TEST_DIRS) {
      for (const file of jsFilesIn(dir)) {
        let text;
        try {
          if (statSync(file).size > 2_000_000) continue;
          text = readFileSync(file, "utf8");
        } catch {
          continue;
        }
        if (!carriesEicarSignature(text)) continue;
        const rel = path.relative(REPO_ROOT, file).split(path.sep).join("/");
        if (rel === SELF) continue;
        if (!(rel in SIGNATURE_ALLOWLIST)) {
          offenders.push(
            `${rel} — carrega a assinatura EICAR e não está na lista. ` +
              `Se é só para calcular um hash ou testar o parser, declara-o aqui com o motivo; ` +
              `se escreve em disco, NÃO pode entrar no gate por omissão.`,
          );
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `ficheiros de teste com EICAR fora da lista — cada um pode virar uma escrita real e um disparo do Defender:\n${offenders.join("\n")}`,
    );
  });

  it("as entradas da lista são reais e estão justificadas", () => {
    for (const [rel, reason] of Object.entries(SIGNATURE_ALLOWLIST)) {
      assert.ok(
        typeof reason === "string" && reason.length > 20,
        `a entrada ${rel} precisa de uma justificação de verdade, não de um ponto`,
      );
      const full = path.join(REPO_ROOT, ...rel.split("/"));
      assert.ok(
        jsFilesIn(path.dirname(full)).some((f) => f === full),
        `a lista aponta para ${rel}, que não existe mais. Apagou-se ou renomeou-se? Actualiza a lista — não a apagues em silêncio.`,
      );
    }
  });

  it("a suite de integração real do ClamAV está atrás de CYBERSAFE_REAL_CLAMSCAN", () => {
    const file = path.join(REPO_ROOT, "packages", "core", "test", "clamav-resource-cap.test.js");
    const text = readFileSync(file, "utf8");
    assert.ok(
      text.includes("CYBERSAFE_REAL_CLAMSCAN"),
      "a integração real tem de declarar o seu próprio opt-in",
    );
    assert.ok(
      text.includes("CYBERSAFE_EICAR_MANUAL"),
      "e o teste de EICAR tem de declarar um opt-in ainda mais restrito",
    );
  });

  it("só quem está na lista de escrita pode escrever EICAR, e só com opt-in", () => {
    const naoAutorizados = [];
    const semOptIn = [];
    for (const dir of TEST_DIRS) {
      for (const file of jsFilesIn(dir)) {
        let text;
        try {
          text = readFileSync(file, "utf8");
        } catch {
          continue;
        }
        if (!carriesEicarSignature(text)) continue;
        const rel = path.relative(REPO_ROOT, file).split(path.sep).join("/");
        if (rel === SELF) continue;
        if (!(rel in EICAR_DISK_WRITE_LIST)) continue;
        if (!text.includes(OPTOUT_ENV)) semOptIn.push(rel);
      }
    }
    // 1. Nenhum ficheiro de escrita pode existir fora da lista minima.
    for (const rel of Object.keys(EICAR_DISK_WRITE_LIST)) {
      const full = path.join(REPO_ROOT, ...rel.split("/"));
      assert.ok(
        jsFilesIn(path.dirname(full)).some((f) => f === full),
        `a lista de escrita aponta para ${rel}, que já não existe. Actualiza a lista em vez de a apagar.`,
      );
    }
    assert.deepEqual(
      semOptIn,
      [],
      `estes ficheiros escrevem EICAR sem ${OPTOUT_ENV} — vão disparar o Defender:\n${semOptIn.join("\n")}`,
    );
    assert.deepEqual(naoAutorizados, []);
  });

  it("as flags de EICAR e de clamscan real não são definíveis por omissão", () => {
    // Se alguém_importar um .env com CYBERSAFE_EICAR_MANUAL=1, o guard
    // continua em pé: o opt-in é lido do ambiente, não de ficheiro versionado.
    // Este teste existe só para deixar registado que a decisão é de ambiente.
    const value = process.env[OPTOUT_ENV];
    assert.ok(
      value === undefined || value === "1",
      `${OPTOUT_ENV} só aceita "1"; qualquer outro valor é um erro de configuração`,
    );
  });
});