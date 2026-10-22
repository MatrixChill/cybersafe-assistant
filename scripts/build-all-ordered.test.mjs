import assert from "node:assert/strict";
import test from "node:test";
import { ORDEM_BUILD, correrBuildOrdenado, lerGrafoWorkspaces, validarOrdemDeBuild } from "./build-all-ordered.mjs";

test("a ordem cobre exatamente os workspaces reais, sem duplicados", () => {
  const grafo = lerGrafoWorkspaces();
  assert.equal(grafo.size, 8, "o monorepo tem 8 workspaces (packages/native-engine nao e' workspace npm)");
  assert.deepEqual(validarOrdemDeBuild(ORDEM_BUILD, grafo), []);
  assert.equal(new Set(ORDEM_BUILD).size, ORDEM_BUILD.length, "sem nomes repetidos");
  assert.equal(ORDEM_BUILD.length, grafo.size, "todos os workspaces entram no build");
});

test("shared-types e' o primeiro e desktop o ultimo (a causa do clone limpo falhar)", () => {
  assert.equal(ORDEM_BUILD[0], "@cybersafe/shared-types");
  assert.equal(ORDEM_BUILD.at(-1), "@cybersafe/desktop");
  assert.ok(ORDEM_BUILD.indexOf("@cybersafe/shared-types") < ORDEM_BUILD.indexOf("api"));
  assert.ok(ORDEM_BUILD.indexOf("@cybersafe/shared-types") < ORDEM_BUILD.indexOf("@cybersafe/core"));
});

test("cada dependencia interna e' construida antes de quem depende dela (grafo real)", () => {
  const grafo = lerGrafoWorkspaces();
  for (const [nome, info] of grafo) {
    for (const dep of info.deps) {
      assert.ok(
        ORDEM_BUILD.indexOf(dep) >= 0,
        `${dep} (dependencia de ${nome}) tem de estar na ordem`,
      );
      assert.ok(
        ORDEM_BUILD.indexOf(dep) < ORDEM_BUILD.indexOf(nome),
        `${dep} tem de ser construido ANTES de ${nome}`,
      );
    }
  }
});

test("fail-fast: ao primeiro erro para e nao corre os restantes (subprocessos mockados)", async () => {
  const chamadas = [];
  const falhaEm = "@cybersafe/native-windows";
  const resultado = await correrBuildOrdenado({
    correr: async (nome) => {
      chamadas.push(nome);
      return { ok: nome !== falhaEm, erro: nome === falhaEm ? "exit 2" : "" };
    },
    registar: () => {},
  });

  assert.equal(resultado.ok, false);
  assert.equal(resultado.falhou, falhaEm);
  assert.match(resultado.erro, /exit 2/);
  assert.deepEqual(
    chamadas,
    ORDEM_BUILD.slice(0, ORDEM_BUILD.indexOf(falhaEm) + 1),
    "nada corre depois do primeiro erro",
  );
  assert.deepEqual(resultado.corridos, ORDEM_BUILD.slice(0, ORDEM_BUILD.indexOf(falhaEm)));
});

test("sucesso: corre a ordem toda, pela ordem exata, uma vez cada (mockado)", async () => {
  const chamadas = [];
  const resultado = await correrBuildOrdenado({
    correr: async (nome) => {
      chamadas.push(nome);
      return { ok: true };
    },
    registar: () => {},
  });

  assert.equal(resultado.ok, true);
  assert.equal(resultado.falhou, null);
  assert.deepEqual(chamadas, [...ORDEM_BUILD]);
  assert.deepEqual(resultado.corridos, [...ORDEM_BUILD]);
});

test("fail-fast: excecao do runner tambem aborta em vez de seguir (mockado)", async () => {
  const chamadas = [];
  const resultado = await correrBuildOrdenado({
    correr: async (nome) => {
      chamadas.push(nome);
      if (nome === "@cybersafe/core") throw new Error("spawn indisponivel");
      return { ok: true };
    },
    registar: () => {},
  });

  assert.equal(resultado.ok, false);
  assert.equal(resultado.falhou, "@cybersafe/core");
  assert.match(resultado.erro, /spawn indisponivel/);
  assert.deepEqual(chamadas, ["@cybersafe/shared-types", "@cybersafe/core"]);
});

test("falha na primeira entrada nao corre mais nada (mockado)", async () => {
  const chamadas = [];
  const resultado = await correrBuildOrdenado({
    correr: async (nome) => {
      chamadas.push(nome);
      return { ok: false, erro: "exit 1" };
    },
    registar: () => {},
  });

  assert.equal(resultado.ok, false);
  assert.equal(resultado.falhou, "@cybersafe/shared-types");
  assert.deepEqual(chamadas, ["@cybersafe/shared-types"]);
  assert.deepEqual(resultado.corridos, []);
});

test("a validacao apanha ordem invalida: dependencia depois do dependente", () => {
  const grafo = new Map([
    ["@cybersafe/shared-types", { dir: "packages/shared-types", deps: [] }],
    ["@cybersafe/core", { dir: "packages/core", deps: ["@cybersafe/shared-types"] }],
  ]);
  const problemas = validarOrdemDeBuild(["@cybersafe/core", "@cybersafe/shared-types"], grafo);
  assert.ok(
    problemas.some((p) => p.includes("@cybersafe/core") && p.includes("@cybersafe/shared-types")),
    `esperava um problema de ordem, veio: ${JSON.stringify(problemas)}`,
  );
});

test("a validacao apanha workspaces em falta e nomes repetidos", () => {
  const grafo = new Map([
    ["@cybersafe/shared-types", { dir: "packages/shared-types", deps: [] }],
    ["@cybersafe/core", { dir: "packages/core", deps: ["@cybersafe/shared-types"] }],
  ]);
  const problemas = validarOrdemDeBuild(["@cybersafe/shared-types", "@cybersafe/shared-types"], grafo);
  assert.ok(problemas.some((p) => p.includes("duplicado")));
  assert.ok(problemas.some((p) => p.includes("em falta")));
});
