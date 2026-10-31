import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

/**
 * TP-GUI02 — PC Center sem cartões esticados.
 *
 * Sem runtime gráfico nesta ronda, prova-se o que é verificável no fonte e no
 * SSR: a grelha usa `items-start`, o cartão de armazenamento não tem `h-full`
 * nem `overflow-hidden`, e os detalhes físicos estão numa superfície própria
 * fora da grelha. O checklist humano cobre 1920x1080 e 1366x768.
 */

const PC = fs.readFileSync(new URL("../src/pages/PCCenterPage.tsx", import.meta.url), "utf8");
const PAINEL = fs.readFileSync(new URL("../src/components/StorageHealthPanel.tsx", import.meta.url), "utf8");
const DISPLAY = fs.readFileSync(new URL("../src/lib/storageHealthDisplay.ts", import.meta.url), "utf8");

const entre = (fonte: string, inicio: string, fim: string): string => {
  const i = fonte.indexOf(inicio);
  const j = fonte.indexOf(fim, i + inicio.length);
  assert.ok(i >= 0 && j > i, `marcador em falta: ${inicio} -> ${fim}`);
  return fonte.slice(i, j);
};

test("a grelha principal usa items-start: cada cartão fica na altura natural", () => {
  const grelha = entre(PC, "{/* Main Grid", "<StorageCard disk={hardware.disk} />");
  assert.match(grelha, /grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 items-start/);
});

test("o cartão de armazenamento não estica nem corta o conteúdo", () => {
  const cartao = entre(PC, "function StorageCard", "// A copy/estado de temperatura");
  assert.doesNotMatch(cartao, /flex flex-col h-full/, "o cartão voltou a preencher a altura da linha");
  assert.doesNotMatch(cartao, /rounded-xl p-6 relative overflow-hidden/, "o cartão voltou a cortar o conteúdo");
  assert.match(cartao, /className="bg-card cyber-border rounded-xl p-6 relative group/);
  assert.match(cartao, /StorageHealthPanel disk=\{disk\} nowMs=\{nowMs\} mode="summary"/);
  assert.doesNotMatch(cartao, /mode="details"/, "os detalhes ainda estão dentro do cartão da grelha");
});

test("os detalhes de saúde vivem numa superfície própria, depois da grelha", () => {
  const inicioGrelha = PC.indexOf("{/* Main Grid");
  const marca = PC.indexOf('data-testid="storage-health-surface"');
  const superficie = PC.lastIndexOf("<details", marca);
  const topProcessos = PC.indexOf("{/* Top Processes */}");
  assert.ok(inicioGrelha >= 0 && superficie > inicioGrelha, "a superfície não está depois da grelha");
  assert.ok(superficie < topProcessos, "a superfície ficou no lugar errado do fluxo");

  const bloco = PC.slice(superficie, topProcessos);
  assert.match(bloco, /<details[^>]*data-testid="storage-health-surface"/, "a superfície tem de ser expansível");
  assert.match(bloco, /<summary[^>]*>[\s\S]*?Saúde física dos discos[\s\S]*?detalhes por disco/);
  assert.match(bloco, /StorageHealthPanel disk=\{hardware\.disk\} nowMs=\{nowMs\} mode="details"/);
});

test("Rede e Bateria não têm h-full nem espaçadores que as estiquem", () => {
  const rede = entre(PC, "{/* Network Card */}", "{/* Battery Card");
  const bateria = entre(PC, "{/* Battery Card", "{/* Saúde física: superfície própria");
  for (const [nome, bloco] of [["Rede", rede], ["Bateria", bateria]] as const) {
    assert.doesNotMatch(bloco, /flex flex-col h-full/, `${nome} voltou a esticar`);
    assert.doesNotMatch(bloco, /flex-grow/, `${nome} voltou a usar um espaçador elástico`);
  }
});

test("o resumo de armazenamento só mostra espaço medido por volume e sem mapping inventado", () => {
  const cartao = entre(PC, "function StorageCard", "// A copy/estado de temperatura");
  assert.match(cartao, /diskVolumeRows\(disk\)/, "as linhas por volume deixaram de ser a fonte");
  assert.match(cartao, /primary\.usedGb/);
  assert.match(cartao, /primary\.freeGb/);
  assert.match(cartao, /primary\.totalGb/);
  assert.doesNotMatch(cartao, /physical\[[^\]]+\]\.(usedGb|freeGb|totalGb)/, "o cartão atribuiu espaço a um disco físico");
  assert.doesNotMatch(cartao, /mount.*===.*deviceId|deviceId.*===.*mount/, "volumes não são casados com discos por nome/índice");
  assert.match(DISPLAY, /não associa cada volume a um disco físico/);
  assert.match(PAINEL, /storageHealthView\(disk, nowMs\)/, "o cartão apresenta o contrato, não uma cópia local");
});
