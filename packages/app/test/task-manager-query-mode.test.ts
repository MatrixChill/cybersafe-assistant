/** Individual termination protocol replaces the historical query-only UI.
 * SSR checks presentation; behavioral prepare/confirm/cancel tests are in
 * individual-process-termination.test.ts. The legacy tree path stays denied. */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { isProtectedProcess } from "@cybersafe/shared-types";
import type { ProcessSnapshot } from "@cybersafe/shared-types";
import TaskManagerPage, { QUERY_MODE_BADGE } from "@/pages/TaskManagerPage";
import { KILL_READONLY_UNAVAILABLE } from "@/lib/processActions";

const pagina = readFileSync(new URL("../src/pages/TaskManagerPage.tsx", import.meta.url), "utf8");

const proc = (overrides: Partial<ProcessSnapshot> & { pid: number }): ProcessSnapshot =>
  ({
    ppid: 0,
    name: "sample.exe",
    path: "",
    commandLine: "",
    user: undefined,
    cpu: 0,
    memoryMb: 0,
    startedAt: new Date(0).toISOString(),
    trusted: "neutral",
    ...overrides,
  }) as ProcessSnapshot;

/** Uma linha protegida e uma linha normal, escolhidas pela própria regra partilhada. */
const LINHAS: ProcessSnapshot[] = (() => {
  const candidatos = [
    proc({ pid: 4001, name: "csrss.exe", cpu: 12.5, memoryMb: 256 }),
    proc({ pid: 4002, name: "notepad.exe", cpu: 0.25, memoryMb: 32 }),
    proc({ pid: 4003, name: "wininit.exe", cpu: 0, memoryMb: 8 }),
    proc({ pid: 4004, name: "chrome.exe", cpu: 33.3, memoryMb: 1024 }),
  ];
  const protegida = candidatos.find((p) => isProtectedProcess(p));
  const normal = candidatos.find((p) => !isProtectedProcess(p));
  assert.ok(protegida && normal, "os candidatos têm de incluir uma linha protegida e uma normal");
  return [protegida, normal];
})();

const render = (props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(TaskManagerPage, { processes: LINHAS, ...props }));

describe("terminação individual — o que o ecrã diz", () => {
  test("o modo está declarado no corpo da página, visível sem interagir", () => {
    const html = render();
    assert.match(html, /data-query-mode-badge/, "o badge da política de terminação individual tem de estar marcado");
    assert.ok(html.includes(QUERY_MODE_BADGE), "a página tem de mostrar o rótulo da política de terminação individual");
    assert.match(html, /Terminação individual limitada/, "o texto legível diz «Modo de consulta»");
  });

  test("nenhum markup de terminação é produzido", () => {
    const html = render();
    for (const proibido of [
      "Terminar este processo?",
      "Sim, Terminar",
      "Terminar Ameaça",
      "Encerrar processo",
    ]) {
      assert.ok(!html.includes(proibido), `a página produziu markup de terminação: "${proibido}"`);
    }
  });

  test("a seleção prepara um ticket, mas nunca submete a terminação", () => {
    const funil = pagina.slice(pagina.indexOf("const selectKillTarget"), pagina.indexOf("const clearKillTarget"));
    assert.match(funil,/prepareIndividualTermination/);
    assert.doesNotMatch(funil,/confirmIndividualTermination|killProcessTree/);
  });
});

describe("terminação individual — o que a página continua a mostrar", () => {
  test("PID, CPU e RAM de cada linha sobrevivem à mudança", () => {
    const html = render();
    for (const p of LINHAS) {
      assert.ok(html.includes(`data-row-action="${p.pid}"`), `a linha ${p.pid} perdeu a sua acção`);
      assert.ok(html.includes(String(p.pid)), `a linha ${p.pid} perdeu o PID`);
      assert.ok(html.includes(`${p.cpu}%`) || html.includes(`${p.memoryMb} MB`), `a linha ${p.pid} perdeu indicadores`);
    }
  });

  test("a linha protegida continua a dar a sua razão própria, não a do modo", () => {
    const html = render();
    for (const p of LINHAS) {
      const esperada = isProtectedProcess(p)
        ? "Processo protegido: o Windows precisa dele"
        : "Verificar elegibilidade e terminar este processo";
      const label = new RegExp(`aria-label="([^"]*)"[^>]*data-row-action="${p.pid}"|data-row-action="${p.pid}"[^>]*aria-label="([^"]*)"`);
      const m = html.match(label);
      assert.ok(m, `a linha ${p.pid} não tem aria-label`);
      assert.equal((m[1] ?? m[2]).replace(/&quot;/g, '"'), esperada, `aria-label errada na linha ${p.pid}`);
    }
  });

  test("sem resposta do serviço a página não rebenta e o modo continua declarado", () => {
    const html = render({ serviceConnected: null, processesObservedAt: null, processTruth: null, aEnumerar: false });
    assert.ok(html.includes(QUERY_MODE_BADGE), "a ausência de resposta não apaga a política de terminação individual");
  });

  test("com lista vazia o modo não é escondido atrás de um estado vazio", () => {
    const html = render({ processes: [], serviceConnected: true, processesObservedAt: Date.now() });
    assert.ok(html.includes(QUERY_MODE_BADGE));
  });
});

describe("terminação individual — o funil exige preparação e confirmação", () => {
  test("o selector monta o modal só depois de receber um ticket válido", () => {
    // O que tem de desaparecer é o ENVIO, não o membro do tipo `KillEvent` (que
    // continua a existir enquanto o reducer for testado isoladamente).
    assert.match(pagina, /setKill\(\{type:"select"/, "a seleção só é montada depois de preparar o ticket");
    assert.match(pagina,/if\(!prepared\?\.ok\)/);
  });

  test("o selector nunca confirma nem termina árvores", () => {
    const funil = pagina.slice(pagina.indexOf("const selectKillTarget"), pagina.indexOf("const clearKillTarget"));
    assert.doesNotMatch(funil, /killProcessTree|confirmIndividualTermination/, "o selector não pode enviar IPC");
  });

  test("não existe call site legado; só há uma confirmação individual", () => {
    // A invariante de sempre: se algum dia o kill voltar, é num sítio só — e
    // esse sítio é o handler do confirm, que a página já não consegue montar.
    assert.equal((pagina.match(/api\.killProcessTree/g) ?? []).length, 0);
    assert.equal((pagina.match(/return confirmIndividualTermination/g) ?? []).length,1);
    assert.doesNotMatch(pagina, /onClick=\{handleKill|\(\(\) => handleKill\(\)\)/, "nenhum botão submete directamente");
  });

  test("o modal de análise não oferece terminar a ameaça", () => {
    assert.doesNotMatch(pagina, /onClick=\{\(\) => \{ selectKillTarget\(analysisResult/);
    assert.ok(!pagina.includes("Terminar Ameaça"), "a promessa saiu do código, não só do ecrã");
  });
});
