import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { after } from "node:test";

import {
  APPROVERS_ENV,
  APPROVERS_SCHEMA,
  aprovaçãoProblemas,
  buildManifest,
  carregarRegistoAprovadores,
  verifySourceFreeze,
} from "../source-freeze.mjs";

/**
 * O mecanismo de aprovadores do congelamento de fonte.
 *
 * Antes, o nome aceite era uma constante no código (`"Codex Lead"`). O Codex deixou
 * de participar no projeto, e as duas saídas fáceis eram piores do que o problema:
 * aceitar qualquer nome (o gate passa a não significar nada) ou pôr uma flag de
 * bypass (a mesma coisa com um interruptor). A saída formal é a identidade sair do
 * código e passar a um **registo fora da raiz do repo**, com falha fechada.
 *
 * O que estes casos protegem, um por um:
 *   1. sem registo não há aprovação possível — nem para o dono, nem para o
 *      verificador do empacotamento;
 *   2. o registo não pode viver dentro do que aprova;
 *   3. um `approvedBy` que não consta do registo é recusado, incluindo o valor
 *      histórico `"Codex Lead"` (não há aceitação por herança);
 *   4. um integrador só vale se quem o autorizar for um proprietário **declarado no
 *      mesmo registo** — ninguém se auto-nomeia;
 *   5. registos malformed (schema, duplicados, nomes vazios, listas em falta)
 *      falham no carregamento, não em tempo de comparação;
 *   6. a verificação do manifesto (o caminho que o `package-windows.mjs` usa) lê o
 *      registo outra vez: editar o `.approved.json` à mão para outro nome falha no
 *      build, não só no `--write`.
 */

const DONO = "Caio Amorim";
const RAIZ_FIXTURE = fs.mkdtempSync(path.join(os.tmpdir(), "cs-approvers-root-"));
const FORA = fs.mkdtempSync(path.join(os.tmpdir(), "cs-approvers-fora-"));
after(() => {
  fs.rmSync(RAIZ_FIXTURE, { recursive: true, force: true });
  fs.rmSync(FORA, { recursive: true, force: true });
});

function escreverRaiz() {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), "cs-approvers-arvore-"));
  const escreve = (rel, conteúdo) => {
    const abs = path.join(raiz, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, conteúdo);
  };
  escreve("package.json", "{}\n");
  escreve("package-lock.json", "{}\n");
  escreve("product-version.json", '{"version":"0.2.0"}\n');
  escreve("scripts/a.mjs", "export const a = 1;\n");
  escreve("packages/core/src/index.ts", "export const b = 2;\n");
  escreve("packages/native-engine/build/Release/scan-engine.exe", "MZ\n");
  escreve("vendor/clamav/VENDOR.json", "{}\n");
  escreve("assets/licenses/THIRD-PARTY-NOTICES.txt", "Avisos.\n");
  escreve("assets/licenses/PROVENANCE.json", '{"schema":1,"obrigacaoPorResolver":{"bloqueador":false,"evidencia":["fixture"]}}\n');
  escreve("vendor/yara/VENDOR.json", '{"schema":1,"version":"4.6.0"}\n');
  escreve("vendor/yara/yara64.exe", "MZ\n");
  return raiz;
}

function registo(conteúdo, nome = "approvers.json") {
  const caminho = path.join(FORA, `${Date.now()}-${Math.random().toString(36).slice(2)}-${nome}`);
  fs.writeFileSync(caminho, typeof conteúdo === "string" ? conteúdo : `${JSON.stringify(conteúdo, null, 2)}\n`);
  return caminho;
}

const VÁLIDO = { schema: APPROVERS_SCHEMA, owners: [DONO], integrators: [] };

test("sem registo configurado ninguém pode aprovar, e o verificador falha fechado", () => {
  const { registry, problems } = carregarRegistoAprovadores({ root: RAIZ_FIXTURE, env: {} });
  assert.equal(registry, null);
  assert.equal(problems[0].kind, "approver-registry-missing");

  const raiz = escreverRaiz();
  const manifesto = path.join(FORA, "aprovado.json");
  fs.writeFileSync(manifesto, `${JSON.stringify(buildManifest({ root: raiz, approval: { approvedBy: DONO, candidateId: "c1", approvedAt: "2026-11-01T00:00:00.000Z" } }), null, 2)}\n`);
  const relatorio = verifySourceFreeze({ root: raiz, manifestPath: manifesto, env: {} });
  assert.equal(relatorio.ok, false, "um manifesto com aprovação válida na forma não basta sem registo");
  assert.ok(relatorio.problems.some((p) => p.kind === "approver-registry-missing"));
});

test("o registo não pode estar dentro da raiz que aprova", () => {
  const dentro = path.join(RAIZ_FIXTURE, "approvers.json");
  fs.writeFileSync(dentro, `${JSON.stringify(VÁLIDO)}\n`);
  const { registry, problems } = carregarRegistoAprovadores({ root: RAIZ_FIXTURE, env: { [APPROVERS_ENV]: dentro } });
  assert.equal(registry, null);
  assert.equal(problems[0].kind, "approver-registry-invalid");
  assert.match(problems[0].detail, /fora|não pode estar dentro/i);
});

test("nome fora do registo é recusado — incluindo o valor histórico `Codex Lead`", () => {
  const caminho = registo(VÁLIDO);
  const { registry } = carregarRegistoAprovadores({ root: RAIZ_FIXTURE, env: { [APPROVERS_ENV]: caminho } });
  assert.deepEqual(aprovaçãoProblemas({ approvedBy: "Codex Lead" }, registry), [
    'approvedBy «Codex Lead» não consta do registo de aprovadores',
  ]);
  assert.deepEqual(aprovaçãoProblemas({ approvedBy: DONO }, registry), []);
  assert.equal(aprovaçãoProblemas({ approvedBy: DONO }, null)[0], "registo de aprovadores indisponível");
});

test("integrador precisa de um proprietário declarado no mesmo registo", () => {
  const autorizado = registo({ schema: APPROVERS_SCHEMA, owners: [DONO], integrators: [{ name: "Integrador", authorizedBy: DONO }] });
  const { registry } = carregarRegistoAprovadores({ root: RAIZ_FIXTURE, env: { [APPROVERS_ENV]: autorizado } });
  assert.deepEqual(aprovaçãoProblemas({ approvedBy: "Integrador" }, registry), []);

  const auto = registo({ schema: APPROVERS_SCHEMA, owners: [DONO], integrators: [{ name: "Auto-nomeado", authorizedBy: "Ele próprio" }] });
  const carregado = carregarRegistoAprovadores({ root: RAIZ_FIXTURE, env: { [APPROVERS_ENV]: auto } });
  assert.ok(carregado.registry, "a estrutura do registo é legível; o problema é a identidade");
  assert.match(aprovaçãoProblemas({ approvedBy: "Auto-nomeado" }, carregado.registry)[0], /não é proprietário declarado/);
});

test("registo malformed falha no carregamento, não em tempo de comparação", () => {
  const casos = [
    [{ schema: 99, owners: [DONO], integrators: [] }, /schema/],
    [{ schema: APPROVERS_SCHEMA, owners: [DONO] }, /owners|integrators/],
    [{ schema: APPROVERS_SCHEMA, owners: [], integrators: [] }, /nenhum aprovador/],
    [{ schema: APPROVERS_SCHEMA, owners: [DONO, DONO], integrators: [] }, /duplicado/],
    [{ schema: APPROVERS_SCHEMA, owners: ["  "], integrators: [] }, /inválido/],
    [{ schema: APPROVERS_SCHEMA, owners: [DONO], integrators: [{ name: "Sem autorizador" }] }, /sem autorizador/],
    ["não é json", /ilegível|JSON/i],
  ];
  for (const [conteúdo, regex] of casos) {
    const caminho = registo(conteúdo, `mau-${Buffer.from(String(conteúdo)).length}.json`);
    const { registry, problems } = carregarRegistoAprovadores({ root: RAIZ_FIXTURE, env: { [APPROVERS_ENV]: caminho } });
    assert.equal(registry, null, `tinha de recusar: ${JSON.stringify(conteúdo).slice(0, 60)}`);
    assert.match(problems[0].detail, regex, `mensagem inesperada para ${JSON.stringify(conteúdo).slice(0, 60)}: ${problems[0].detail}`);
  }
});

test("o gate do empacotamento recusa um manifesto editado para outro nome", () => {
  const raiz = escreverRaiz();
  const caminho = registo(VÁLIDO);
  const manifestoPath = path.join(FORA, "editado.json");
  const manifesto = buildManifest({ root: raiz, approval: { approvedBy: DONO, candidateId: "c2", approvedAt: "2026-11-01T00:00:00.000Z" } });
  manifesto.approval.approvedBy = "Quem mexeu no ficheiro";
  fs.writeFileSync(manifestoPath, `${JSON.stringify(manifesto, null, 2)}\n`);
  const relatorio = verifySourceFreeze({ root: raiz, manifestPath: manifestoPath, env: { [APPROVERS_ENV]: caminho } });
  assert.equal(relatorio.ok, false);
  assert.ok(relatorio.problems.some((p) => /não consta do registo/.test(p.detail ?? "")),
    `esperava recusa de identidade, obtido ${JSON.stringify(relatorio.problems)}`);

  // E com a identidade certa o mesmo caminho fica verde — o gate não é só «não».
  fs.writeFileSync(manifestoPath, `${JSON.stringify(manifesto, null, 2).replace("Quem mexeu no ficheiro", DONO)}\n`);
  const verde = verifySourceFreeze({ root: raiz, manifestPath: manifestoPath, env: { [APPROVERS_ENV]: caminho } });
  assert.equal(verde.ok, true, `manifesto conforme devia verificar; problemas: ${JSON.stringify(verde.problems)}`);
});
