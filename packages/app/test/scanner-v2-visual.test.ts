import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/* ═══ TP-PAP-DESIGN-V2-SCANNER-VISUAL-20261027 — camada visual do Scanner ══
   O que este ficheiro prova, e o que NÃO prova:
   - prova que a página é V2-scoped (`.cs-scanner-root`), que as superfícies
     passaram a ler tokens, e que o cartão por ficheiro transporta o estado em
     atributo para o CSS poder pintar sem mentir;
   - prova que o patch não partiu os invariants que OUTROS testes têm sobre
     este ficheiro enquanto texto (contagens e strings congeladas);
   - não prova aspeto. Nada aqui diz «o Scanner está bonito»: a validação
     visual faz-se no Electron com dados reais, e a lane não tem dependências.

   Corre no harness do app (a lane não tem `node_modules`; executa-se na cópia
   com dependências):
     cd packages/app && TSX_TSCONFIG_PATH=tsconfig.app.json node --import tsx --test test/scanner-v2-visual.test.ts
   ═══════════════════════════════════════════════════════════════════════ */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGINA = path.join(HERE, "..", "src", "pages", "FileScannerPage.tsx");
const CSS = path.join(HERE, "..", "src", "index.css");

// JSX clássico sob `tsx` e render de servidor: os dois stubs do precedente
// (`scanner-page-render.test.ts`), sem os quais o import rebenta.
(globalThis as Record<string, unknown>).React = await import("react");
(globalThis as Record<string, unknown>).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const { default: FileScannerPage, PerFileEngineCard } = await import("../src/pages/FileScannerPage");
const { AppearanceProvider } = await import("../src/contexts/AppearanceContext");
const { NO_DETECTIONS_NOTE, SCAN_CONTENTION_MESSAGES, PER_FILE_ENGINE_COVERAGE_NOTE } =
  await import("../src/lib/scanSession");

const texto = (p: string) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const semComentarios = (html: string) => html.replace(/<!--[\s\S]*?-->/g, "");

const paginaIdle = () =>
  semComentarios(
    renderToStaticMarkup(
      createElement(AppearanceProvider, null, createElement(FileScannerPage, {})),
    ),
  );

/**
 * Facto do cartão por ficheiro. A forma real é `PerFileFacts`; declarada aqui
 * estruturalmente para o fixture não depender de tipos internos do serviço. O
 * cartão recebe o objeto como `never` precisamente porque isto é um substituto
 * de teste, não uma reimplementação do contrato.
 */
interface FactoCartao {
  fileName: string;
  analysisState: string;
  native: { status: string; failure?: string };
  verdict?: string;
  rulesTriggered: string[];
  canClaimClean: boolean;
}

const facto = (x: Partial<FactoCartao>): FactoCartao => ({
  fileName: "aplicativo.exe",
  analysisState: "completed",
  native: { status: "completed" },
  rulesTriggered: [],
  canClaimClean: true,
  ...x,
});

const cartao = (estado: unknown) =>
  semComentarios(
    renderToStaticMarkup(
      createElement(PerFileEngineCard as never, { estado, onAnalisar: () => {}, scanAtivo: false } as never),
    ),
  );

/* ─── 1. a página é V2-scoped ────────────────────────────────────────────── */

test("raiz do Scanner declara o escopo V2", () => {
  const html = paginaIdle();
  assert.match(html, /cs-scanner-root/, "a página não está dependurada no escopo V2");
  assert.match(html, /data-scanner-v2="ativo"/, "falta o marcador de versão visual");
  assert.match(html, /cs-scanner-header/, "o cabeçalho não entrou no vocabulário");
});

test("os quatro cartões de ação usam a superfície de token", () => {
  const html = paginaIdle();
  assert.equal((html.match(/cs-scanner-acao/g) ?? []).length, 4, "nem todos os cartões migraram");
  assert.doesNotMatch(html, /bg-black\/20/, "ficou wash preto fixo no render");
});

test("nenhum literal de wash preto sobra na página", () => {
  // O `bg-black/20` era o defeito: um preto a 20 % que no modo claro escurece
  // por cima do cartão e em nenhuma identidade acompanha o tema.
  assert.doesNotMatch(texto(PAGINA), /bg-black\/20/, "ainda há `bg-black/20` no código");
  assert.equal((texto(PAGINA).match(/cs-scanner-tile/g) ?? []).length, 4, "as métricas não migraram todas");
});

/* ─── 2. o cartão por ficheiro transporta estado, o CSS pinta ────────────── */

test("inerte não desenha nada", () => {
  assert.equal(cartao({ fase: "inerte" }), "");
});

test("cada fase chega ao DOM como atributo legível pelo CSS", () => {
  for (const fase of ["disponivel", "a_analisar", "sem_ligacao", "sem_resposta", "erro"] as const) {
    const html = cartao({ fase, fileName: "x.exe", mensagem: "mensagem do serviço" });
    assert.match(html, /cs-scanner-perfile/, `${fase}: o cartão não é V2`);
    assert.match(html, new RegExp(`data-fase="${fase}"`), `${fase}: o estado não viajou até ao DOM`);
  }
});

test("pronto pinta o estado de cada facto, não um resultado", () => {
  const html = cartao({ fase: "pronto", fileName: "x.exe", facts: [facto({ analysisState: "inconclusive", canClaimClean: false })] });
  assert.match(html, /data-fase="pronto"/);
  assert.match(html, /data-estado="inconclusive"/, "o estado do facto não chegou ao DOM");
  assert.match(html, /Inconclusivo/);
});

test("o verde não vem desta camada: facto concluído usa tinta de processo", () => {
  // `completed` significa «o motor respondeu», não «é limpo». Se alguém ligar
  // `--state-ok-*` a um selector `[data-estado=`, este teste parte.
  const bloco = texto(CSS).slice(texto(CSS).indexOf("CS-V2 · SCANNER"));
  for (const regra of bloco.split(/\n\s*}\n/)) {
    if (!/--state-ok-/.test(regra)) continue;
    assert.match(regra, /\[data-ton="/, `regra com verde fora do tom do resultado:\n${regra.trim().slice(0, 160)}`);
  }
});

/* ─── 3. nada do que era verdade visual deixou de ser verdade ────────────── */

test("falha de um motor não se veste de limpeza", () => {
  const html = cartao({ fase: "erro", fileName: "x.exe", mensagem: "O motor não devolveu um resultado por ficheiro." });
  assert.match(html, /role="alert"/);
  assert.equal(html.includes(NO_DETECTIONS_NOTE), false, "erro a mostrar a frase de «sem deteções»");
});

test("bloqueio por análise em curso continua dito", () => {
  const html = semComentarios(
    renderToStaticMarkup(
      createElement(PerFileEngineCard as never, {
        estado: { fase: "disponivel", fileName: "x.exe" },
        onAnalisar: () => {},
        scanAtivo: true,
      } as never),
    ),
  );
  assert.match(html, /Bloqueado durante a análise/);
  assert.ok(html.includes(SCAN_CONTENTION_MESSAGES.analise_em_curso));
  assert.match(html, /role="status"/);
});

test("fronteira de atribuição por motor continua impressa", () => {
  const html = cartao({ fase: "pronto", fileName: "x.exe", facts: [facto({})] });
  assert.ok(html.includes(PER_FILE_ENGINE_COVERAGE_NOTE), "desapareceu a nota sobre o que o contrato não diz");
  assert.ok(html.includes(NO_DETECTIONS_NOTE), "com os três factos presentes a frase de limpeza é devida");
});

test("o cartão nunca escreve um caminho", () => {
  const corpo = texto(PAGINA).slice(
    texto(PAGINA).indexOf("export function PerFileEngineCard"),
    texto(PAGINA).indexOf("interface FileScannerPageProps"),
  );
  assert.equal(/perFilePathRef|estado\.path|\.filePath/.test(corpo), false);
});

/* ─── 4. invariants dos testes alheios (não partir o suite de mais ninguém) ─
   `r7-l3-history-ui`, `r8-usb-painel`, `scanner-progress-readout` e
   `scan-per-file-engine-facts` lêem este ficheiro como TEXTO e contam
   ocorrências. Um patch «só visual» que mude uma classe contada parte-os sem
   tocar em comportamento. Esta secção existe para isso não voltar a acontecer
   por minha causa — e sobreviver-me. */

const codigo = () => texto(PAGINA);

test("contagens vigiadas por terceiros não mexeram", () => {
  const c = codigo();
  assert.equal((c.match(/ScanHistoryPanel/g) ?? []).length, 3);
  assert.equal((c.match(/UsbProtectionPanel/g) ?? []).length, 3);
  assert.equal((c.match(/<ScanHistoryPanel/g) ?? []).length, 1);
  assert.equal((c.match(/earlyEventsRef\.current/g) ?? []).length, 7);
  assert.equal((c.match(/\bdecideScanEvent\(/g) ?? []).length, 1);
});

test("strings de apresentação congeladas continuam presentes", () => {
  const c = codigo();
  for (const [nome, re] of [
    ["valor numérico das métricas", /font-bold text-foreground tabular-nums", scope === "file"/],
    ["ameaças em vermelho", /text-cyber-red tabular-nums/],
    ["track da barra", /h-2 bg-secondary rounded-full overflow-hidden/],
    ["largura da barra", /style=\{\{ width: `\$\{bar\.percent\}%` \}\}/],
    ["barra primária", /const bar = scanPrimaryBar\(scanProgress\)/],
    ["cartão montado com scanAtivo", /<PerFileEngineCard estado=\{perFile\} scanAtivo=\{isActive\}/],
    ["histórico como último filho", /<ScanHistoryPanel sessaoTerminada=\{sessaoTerminada\} \/>\s*\n\s*<\/div>/],
  ] as const) {
    assert.ok(re.test(c), `${nome} desapareceu do código`);
  }
  assert.equal(/scanLog/.test(c), false);
});

test("nenhum atributo JSX duplicado (o erro que este patch quase teve)", () => {
  // Na primeira versão escrevi `className` duas vezes no mesmo elemento — um
  // erro de compilação em JSX, não uma escolha de estilo.
  assert.equal(/className=(?:(?!className=)[^>])*className=/.test(codigo()), false,
    "className duplicado no mesmo elemento");
});

/* ─── 5. disciplina do CSS acrescentado ─────────────────────────────────── */

test("o bloco do Scanner só usa tokens, nunca cor literal", () => {
  const css = texto(CSS);
  const inicio = css.indexOf("CS-V2 · SCANNER");
  assert.ok(inicio > 0, "não há bloco CS-V2 · SCANNER");
  const bloco = css.slice(inicio);
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(bloco), false, "hex literal no bloco do Scanner");
  assert.equal(/\b(rgba?|hsla?)\(/.test(bloco), false, "função de cor literal no bloco");
  assert.match(bloco, /var\(--surface-inset\)/, "as superfícies não lêem o token de inseto");
  assert.match(bloco, /var\(--shell-radius-card\)/, "o raio não vem da métrica do shell");
});

/**
 * As regras do bloco do Scanner, e só elas.
 *
 * `slice(indexOf("CS-V2 · SCANNER"))` ia até ao fim do `index.css`: a partir
 * dalí o ficheiro recebe outros patches (POST017 acrescentou
 * `padding-bottom: var(--matrix-floating-clearance, 0px)` a `[data-cs-main]`,
 * com token medido em runtime pelo `AIAssistant.tsx:2022`), e o guard do
 * Scanner passou a acusar CSS que nunca foi seu. O contrato sempre foi
 * «o que ESTE bloco escreve»; por isso se recortam as regras de topo cujo
 * seletor — ou o corpo, no caso de `@supports`/`@media` — nomeia `cs-scanner`.
 * Os comentários ficam fora: o contrato são declarações, não prosa.
 */
function regrasDoScanner(css: string): string {
  const inicio = css.indexOf("CS-V2 · SCANNER");
  assert.ok(inicio > 0, "não há bloco CS-V2 · SCANNER");
  const corpo = css.slice(inicio).replace(/\/\*[\s\S]*?\*\//g, "");
  const regras: string[] = [];
  let profundidade = 0;
  let abreEm = -1;
  let cursor = 0;
  for (let i = 0; i < corpo.length; i++) {
    const ch = corpo[i];
    if (ch === "{") {
      if (profundidade === 0) abreEm = i;
      profundidade++;
    } else if (ch === "}") {
      profundidade--;
      if (profundidade === 0 && abreEm >= 0) {
        const seletor = corpo.slice(cursor, abreEm);
        const bloco = corpo.slice(abreEm, i + 1);
        if (`${seletor}${bloco}`.includes("cs-scanner")) regras.push(`${seletor}${bloco}`);
        cursor = i + 1;
        abreEm = -1;
      }
    }
  }
  return regras.join("\n");
}

test("o bloco não acrescenta movimento nem espaçamento", () => {
  // O produto ainda não tem escala de spacing nem tokens de duração: enquanto
  // não existirem, nada neste patch os inventa.
  const regras = regrasDoScanner(texto(CSS));
  // Não-vacuidade: um recorte que devolvesse nada passaria sempre, que é a
  // pior forma de um guard errar.
  assert.ok(regras.includes("cs-scanner-tile"), "o recorte não apanhou as regras do Scanner");
  assert.ok(/var\(--surface-inset\)/.test(regras), "o recorte não apanhou as superfícies do Scanner");
  for (const proibido of ["margin", "padding", "transition", "animation", "gap:"] as const) {
    assert.equal(new RegExp(`\\b${proibido}`).test(regras), false, `o bloco declara ${proibido}`);
  }
});

test("as degradações estão declaradas", () => {
  const bloco = texto(CSS).slice(texto(CSS).indexOf("CS-V2 · SCANNER"));
  assert.match(bloco, /@supports \(color: color-mix/, "sem `color-mix` não há caminho de degradação");
  assert.match(bloco, /@media \(forced-colors: active\)/, "contraste forçado não foi considerado");
  assert.match(bloco, /CanvasText/, "em contraste forçado as arestas de estado têm de vir do SO");
});

test("tudo o que o bloco pinta está dependurado na raiz do Scanner", () => {
  const bloco = texto(CSS).slice(texto(CSS).indexOf("CS-V2 · SCANNER"));
  const selectores = [...bloco.matchAll(/^([.#@][^\n{]+)\s*\{$/gm)].map((m) => m[1].trim());
  assert.ok(selectores.length >= 10, `demasiado poucos selectores (${selectores.length}) — o bloco não foi lido`);
  const soltos = selectores.filter((s) => s.startsWith(".") && !s.startsWith(".cs-scanner-root"));
  assert.deepEqual(soltos, [], "regras globais fora do escopo do Scanner");
});
