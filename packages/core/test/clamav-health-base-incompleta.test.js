import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyClamavHealth } from "../dist/clamav.js";

/**
 * BASE OFICIAL PRESENTE MAS INCOMPLETA.
 *
 * A regra antiga bastava-se «existe .cvd/.cld → active». Medido em percurso real
 * a 2026-11-01: um `freshclam` morto a meio do download deixou `main.cvd`
 * intacto (89 072 577 bytes, sem ficheiro parcial) e `daily.cvd` ausente — e o
 * produto respondia `active`, «2 signature database file(s)». Isso é exatamente
 * a confusão entre contagem de ficheiros e cobertura que o comentário de
 * `classifyClamavHealth` jura evitar, por isso passa a ser asserção.
 */
const base = { versionOutput: "ClamAV 1.5.4/28171/Tue Nov  1 14:30:54 2026", dbDir: "C:\\base", dbFiles: null };

test("main.cvd sem daily: degradado com o que falta nomeado, nunca active", () => {
  const r = classifyClamavHealth({ ...base, dbFiles: ["main.cvd", "bytecode.cvd", "main-63.cvd.sign"] });
  assert.equal(r.available, true, "o binário está presente e as bases que existem carregam-se");
  assert.equal(r.health.status, "degraded", JSON.stringify(r.health));
  assert.match(r.health.detail, /falta a base diária/i);
});

test("main + daily: active com a contagem real", () => {
  const r = classifyClamavHealth({ ...base, dbFiles: ["main.cvd", "daily.cvd", "bytecode.cvd"] });
  assert.equal(r.available, true);
  assert.equal(r.health.status, "active", JSON.stringify(r.health));
  assert.match(r.health.detail, /3 signature database file/);
});

test("nightly conta como base diária (a fonte chama-lhe nightly em certas horas)", () => {
  const r = classifyClamavHealth({ ...base, dbFiles: ["main.cvd", "nightly.cvd"] });
  assert.equal(r.health.status, "active", JSON.stringify(r.health));
});

test("só base local continua degradado, e o vazio continua indisponível", () => {
  const local = classifyClamavHealth({ ...base, dbFiles: ["nossas-regras.ndb"] });
  assert.equal(local.health.status, "degraded");
  assert.match(local.health.detail, /sem base oficial/i);
  const vazio = classifyClamavHealth({ ...base, dbFiles: ["freshclam.dat", "README.txt"] });
  assert.equal(vazio.available, false);
  assert.match(vazio.health.detail, /sem base de assinaturas/i);
});
