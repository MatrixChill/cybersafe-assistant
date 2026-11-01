import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * R7-L3-B + R7-L3-FOLLOWUP — histórico de análises DENTRO de "Análise de
 * Segurança", o PDF do relatório, e PT-PT.
 *
 * História do desenho, porque é isso que este ficheiro fixa: a Fase 2 do
 * R7-L3-B aterrou uma página própria (`pages/ScanHistoryPage.tsx`), com entrada
 * na sidebar, `case "history"` e `"history"` no `VALID` do App. O teste humano
 * do utilizador rejeitou-o — a experiência fragmentava — e o FOLLOWUP moveu o
 * mesmo conteúdo para `components/ScanHistoryPanel.tsx`, montado no fim de
 * `pages/FileScannerPage.tsx`. Daí as duas metades: o painel tem de dizer a
 * verdade sobre o que o serviço sabe, E a rota própria tem de ter deixado de
 * existir em ficheiro, menu, App e assistente.
 *
 * LIMITES DECLARADOS (não escondidos): o package não tem DOM nem jsdom, por
 * isso `renderToStaticMarkup` não corre efeitos e não há cliques — o estado
 * INICIAL prova-se por render e o resto pela estrutura do código. Não se
 * compila código-fonte com `new Function` para «executar» as funções: num
 * produto de segurança isso é exatamente o padrão que se anda a eliminar, e um
 * teste não vale essa troca. Ficam por provar (teste humano): o clique em
 * «Carregar mais» e em «Ver detalhes», os ramos de erro/sem-bridge com efeito
 * correto, o refresco automático quando uma análise atinge terminal, o diálogo
 * de gravação e o PDF real.
 */

(globalThis as Record<string, unknown>).React = React;

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** O checkout em Windows pode trazer CRLF; o contrato destes testes é o conteúdo, não o EOL. */
const read = (...parts: string[]) =>
  fs.readFileSync(path.join(HERE, "..", ...parts), "utf8").replace(/\r\n/g, "\n");
/**
 * `Sidebar.tsx` e `FileScannerPage.tsx` estão em CRLF no working tree. Os regex
 * de várias linhas precisam de uma só forma de acabar linha, por isso o texto é
 * normalizado antes de ser sondado — o ficheiro em disco não é tocado.
 */
const lf = (texto: string) => texto.replace(/\r\n/g, "\n");

const reports = read("src", "pages", "ReportsPage.tsx");
const simulator = read("src", "pages", "SimulatorPage.tsx");
const jogos = read("src", "pages", "EducationalGamesPage.tsx");
const sidebar = lf(read("src", "components", "Sidebar.tsx"));
const app = read("src", "App.tsx");
const assistente = read("src", "components", "AIAssistant.tsx");
const scanner = lf(read("src", "pages", "FileScannerPage.tsx"));
const painel = read("src", "components", "ScanHistoryPanel.tsx");
/** P0-A-app (15/10): a expressão da duração passou a viver aqui. */
const relatorio = read("src", "lib", "scanHistoryReport.ts");
const sharedTypes = read("..", "shared-types", "src", "index.ts");
const electronDts = read("src", "electron.d.ts");
/** O CSS sem comentários: as classes usadas têm de ter regra, não promessa. */
const decls = read("src", "index.css").replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * O painel sem comentários nem classes: o que se proíbe é o que é RENDERIZADO,
 * e os comentários do próprio ficheiro citam por nome as palavras proibidas.
 * As classes do Tailwind trazem `w-4`/`max-w-[92ch]`; não são texto do ecrã.
 */
const textoVisivel = painel
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "")
  .replace(/className="[^"]*"/g, "");

const { ScanHistoryPanel } = await import("../src/components/ScanHistoryPanel");

/**
 * O vocabulário PT-BR que o produto não usa (a app trata por «tu»).
 * Os gerúndios entram porque em PT-PT europeu a forma é «a + infinitivo»
 * («Continua a praticar», não «Continue praticando») — foi exatamente esta
 * palavra que passou ao lado do guarda na ronda anterior.
 */
const PT_BR = [
  "você", "Você", "usuário", "gerenciar", "salvar", "equipe", "planejamento", "celular",
  "praticando", "carregando", "monitorando", "configurando", "entendendo", "salvando", "clicando",
];

/** O corpo de uma função do painel, recortado entre a assinatura e o `}` final. */
function corpoDe(nome: string, fonte: string = painel): string {
  const ini = fonte.indexOf(`function ${nome}(`);
  assert.ok(ini >= 0, `falta a função ${nome} na fonte indicada`);
  const fim = fonte.indexOf("\n}", ini);
  assert.ok(fim > ini, `não se encontrou o fim de ${nome}`);
  return fonte.slice(ini, fim);
}

/** Os membros, EM ORDEM, de um union `type Page = "a" | "b"`. */
function membros(fonte: string, nome: string): string[] {
  const m = /(?:export )?type Page = ([^\r\n]+)/.exec(fonte);
  assert.ok(m, `${nome}: não se encontrou o union Page`);
  return (m[1].match(/"([a-z]+)"/g) ?? []).map((x) => x.replace(/"/g, ""));
}

const doSidebar = membros(sidebar, "Sidebar.tsx");

describe("R7-L3-B 1 — PT-PT no documento de relatório, no simulador e no painel", () => {
  test("nenhum locale pt-BR em código de produto", () => {
    for (const [nome, fonte] of [["ReportsPage", reports], ["SimulatorPage", simulator], ["ScanHistoryPanel", painel]] as const) {
      assert.equal(/pt-BR/.test(fonte), false, `${nome}: ainda há locale pt-BR`);
      assert.match(fonte, /"pt-PT"/, `${nome}: sem locale PT-PT explícito`);
    }
  });

  test("o HTML A4 do relatório declara a língua certa, uma vez por documento", () => {
    const lang = reports.match(/<html lang="pt-PT">/g) ?? [];
    assert.equal(lang.length, 1, `esperava um só <html lang=…>, obtive ${lang.length}`);
    assert.equal(/<html lang="(?!pt-PT)/.test(reports), false, "o documento declara outra língua");
    // O A4 de UM registo do histórico é outro documento, e também se declara.
    assert.match(painel, /<html lang="pt-PT">/);
    assert.equal(/<html lang="(?!pt-PT)/.test(painel), false, "o A4 do histórico declara outra língua");
  });

  test("as datas formatadas lêem-se em PT-PT em todos os pontos", () => {
    const chamadas = [...reports.matchAll(/toLocale(?:String|DateString|DateTimeFormat)\("([A-Za-z-]+)"/g)];
    assert.ok(chamadas.length >= 4, `esperava as datas do relatório todas medidas, vi ${chamadas.length}`);
    for (const m of chamadas) assert.equal(m[1], "pt-PT", `locale errado: ${m[0]}`);
    assert.match(simulator, /toLocaleDateString\("pt-PT"\)/);
    assert.match(painel, /toLocaleString\("pt-PT", \{ dateStyle: "short", timeStyle: "short" \}\)/);
  });

  test("sem tratamento pt-BR no simulador, nos jogos, no relatório e no painel", () => {
    for (const [nome, fonte] of [["SimulatorPage", simulator], ["EducationalGamesPage", jogos], ["ReportsPage", reports], ["ScanHistoryPanel", painel]] as const) {
      for (const palavra of PT_BR) {
        assert.equal(fonte.includes(palavra), false, `${nome}: ${palavra}`);
      }
    }
    assert.match(simulator, /Vais receber 6 URLs reais/);
    assert.match(simulator, /Vê como te saíste no desafio de phishing/);
    assert.match(simulator, /Acertaste /);
  });

  test("o feedback de pontuação baixa é PT-PT europeu nos cinco sítios, com os emojis intactos", () => {
    // O guarda acima prova a ausência; este prova a substituição — «Continua a
    // praticar» é a forma europeia com o tratamento por «tu» que a app usa.
    // Os emojis são decisão de design desta lane não é para tocar: fixam-se aqui
    // para uma correção de língua não apagar o 💪 que já lá estava.
    assert.equal((simulator.match(/Continua a praticar/g) ?? []).length, 1, "SimulatorPage sem a forma europeia");
    assert.equal((jogos.match(/Continua a praticar/g) ?? []).length, 4, "EducationalGamesPage sem a forma europeia nos quatro sítios");
    assert.match(simulator, /"Continua a praticar 💪"/);
    assert.equal(/"Continue praticando/.test(simulator + jogos), false, "voltou o gerúndio pt-BR");
  });

  test("a honestidade do relatório sobreviveu à mudança de língua", () => {
    assert.match(reports, /não constitui auditoria formal/);
    assert.match(reports, /Ausência de ameaças detetadas não significa garantia absoluta/);
  });
});

describe("R7-L3-B 2 — o contrato do R7-L3-A está ligado, sem duplicação", () => {
  test("os tipos e a IPC existem com a forma do packet, e o painel só os usa", () => {
    assert.match(sharedTypes, /export type ScanHistoryStatus = "completed" \| "cancelled" \| "failed"/);
    assert.match(sharedTypes, /export interface ScanHistoryEntry \{[\s\S]*?target: "default" \| "custom"/);
    assert.match(sharedTypes, /export interface ScanHistoryPage \{[\s\S]*?nextCursor: string \| null/);
    assert.match(
      electronDts,
      /getScanHistory: \(payload\?: \{ limit\?: number; cursor\?: string \}\) => Promise<ScanHistoryPage>/,
    );
    assert.match(
      electronDts,
      /exportReportPdf: \(html: string, suggestedName: string\) => Promise<\{ success: boolean; path\?: string; canceled\?: boolean; error\?: string \}>/,
    );
    assert.match(painel, /import type \{[^}]*ScanHistoryEntry[^}]*\} from "@cybersafe\/shared-types"/);
    assert.equal(/interface ScanHistoryEntry|type ScanHistoryEntry =/.test(painel), false, "tipo duplicado localmente");
    assert.equal(/interface ScanHistoryPage|type ScanHistoryPage =/.test(painel), false, "página duplicada localmente");
  });

  test("o painel consome o contrato do serviço, sem lhe impor uma página", () => {
    assert.match(painel, /const api = window\.electronAPI\?\.getScanHistory;/);
    // O primeiro pedido não impõe `limit`: a página por omissão é decisão do serviço.
    assert.match(painel, /const pagina = await api\(\);/);
    assert.match(painel, /const mais = await api\(\{ cursor \}\);/);
    // UI-D2 (28/10): a resposta passa por um classificador — `null` da bridge em
    // encerramento não é página, e uma página confirmada é o que entra na lista.
    assert.match(painel, /const decisao = decidePaginaHistorico\(pagina\);/);
    assert.match(painel, /setEntradas\(decisao\.entradas\)/);
    assert.match(painel, /setCursor\(decisao\.cursor\)/);
    assert.equal(
      /pagina\.entries \?\? \[\]/.test(painel),
      false,
      "a leitura defensiva que transformava «sem resposta» em «sem análises» voltou",
    );
  });

  test("o histórico não é uma página: não há ficheiro nem referência à página antiga", () => {
    assert.equal(
      fs.existsSync(path.join(HERE, "..", "src", "pages", "ScanHistoryPage.tsx")),
      false,
      "pages/ScanHistoryPage.tsx voltou a existir — o desenho rejeitado pelo utilizador",
    );
    for (const [nome, fonte] of [["App.tsx", app], ["Sidebar.tsx", sidebar], ["AIAssistant.tsx", assistente], ["FileScannerPage.tsx", scanner]] as const) {
      assert.equal(/ScanHistoryPage/.test(fonte), false, `${nome} ainda refere a página`);
    }
    // O único lugar que monta o painel é a página da análise.
    assert.equal((scanner.match(/<ScanHistoryPanel/g) ?? []).length, 1, "o painel foi montado mais de uma vez");
  });
});

describe("R7-L3-FOLLOWUP 3 — não há página nem rota própria", () => {
  test("«history» saiu do menu, e o ícone que só servia essa entrada também", () => {
    assert.equal(/"history"/.test(sidebar), false, "Sidebar.tsx ainda conhece a rota");
    assert.equal(/Histórico de Análises/.test(sidebar), false, "a entrada fragmentada voltou ao menu");
    assert.equal(/History/.test(sidebar), false, "ficou o import do ícone que já não é usado");
  });

  test("o App não conhece «history» e continua a ignorar rotas que não conhece", () => {
    assert.equal(/"history"/.test(app), false, "App.tsx ainda traz a rota");
    assert.equal(/case "history"/.test(app), false, "voltou o caso de renderização");
    const valid = /const VALID: Page\[\] = \[([\s\S]*?)\];/.exec(app);
    assert.ok(valid, "não se encontrou a lista VALID de navegação");
    const rotas = (valid[1].match(/"([a-z]+)"/g) ?? []).map((x) => x.replace(/"/g, ""));
    // Um `app:navigate` de fora (tray, atalho) com rota inexistente tem de ser
    // ignorado — é esta a porta, e foi ela que segurou um marcador velho.
    assert.match(app, /if \(VALID\.includes\(next\)\) setPage\(next\);/);
    assert.deepEqual(rotas, doSidebar, "as rotas aceites pelo App divergiram do union do menu");
  });

  test("os dois unions Page coincidem EXATAMENTE (a cópia do assistido é o que partiu o build)", () => {
    // AIAssistant.tsx tem o SEU PRÓPRIO union `Page`. O App passa o valor do
    // Sidebar para lá, por isso uma página nova — ou uma removida — sem
    // sincronia é TS2322 no `App.tsx:917`. A igualdade é o contrato; a ordem
    // também, porque é o que faz a diferença ser um só sítio a ler.
    const doAssistente = membros(assistente, "AIAssistant.tsx");
    assert.deepEqual(doAssistente, doSidebar, "os dois unions divergiram");
    assert.equal(doAssistente.includes("history"), false, "a rota morta ficou no assistente");
    assert.ok(doSidebar.length >= 12, `esperava o menu todo, vi ${doSidebar.length}`);
    assert.ok(doSidebar.includes("scanner"), "o histórico vive na página do scanner");
  });

  test("cada página do union tem rótulo e sugestões no assistente", () => {
    // Records indexados por `Page`: uma página sem entrada não compila, ou
    // mostrava `undefined` no prompt do assistente.
    const rotulos = assistente.slice(assistente.indexOf("const PAGE_LABELS"), assistente.indexOf("const SUGGESTIONS"));
    const sugestoes = assistente.slice(assistente.indexOf("const SUGGESTIONS"), assistente.indexOf("const DEFAULT_SUGGESTIONS"));
    assert.ok(rotulos.length > 0 && sugestoes.length > 0, "marcadores dos mapas do assistente");
    for (const pagina of doSidebar) {
      assert.ok(new RegExp(`\\b${pagina}: "`).test(rotulos), `PAGE_LABELS sem ${pagina}`);
      assert.ok(new RegExp(`\\b${pagina}: \\[`).test(sugestoes), `SUGGESTIONS sem ${pagina}`);
    }
    assert.equal(/history: "/.test(rotulos), false, "rótulo da rota morta");
    assert.equal(/history: \[/.test(sugestoes), false, "sugestões da rota morta");
  });

  test("o histórico continua acessível no plano free — porque é a página do scanner", () => {
    // Antes era uma entrada `proOnly: false` própria; agora é conteúdo do
    // scanner, e quem lança uma análise tem de poder consultar as anteriores.
    assert.match(read("src", "lib", "featureControl.ts"), /FEATURES\.SCANNER,\s*FEATURES\.MONITOR_BASIC/);
    assert.match(read("src", "lib", "featureControl.ts"), /\{ id: "scanner", requiredFeature: FEATURES\.SCANNER, proOnly: false \}/);
  });
});

describe("R7-L3-FOLLOWUP 4 — a integração no scanner é aditiva (L1/L2 intactos)", () => {
  test("o painel entra no FIM da página, depois de tudo o que já lá estava", () => {
    assert.match(scanner, /import \{ ScanHistoryPanel \} from "\.\.\/components\/ScanHistoryPanel"/);
    const lugar = scanner.indexOf("<ScanHistoryPanel sessaoTerminada={sessaoTerminada} />");
    assert.ok(lugar > 0, "o painel não está montado com o sinal do terminal");
    // A ordem pedida: iniciar → em curso → último resultado → arquivo. O último
    // bloco pré-existente é o das dicas; o painel tem de vir depois dele.
    assert.ok(lugar > scanner.indexOf("Análise em Segundo Plano"), "o histórico subiu acima do que já existia");
    assert.match(scanner.slice(lugar), /^<ScanHistoryPanel sessaoTerminada=\{sessaoTerminada\} \/>\s*\n\s*<\/div>/);
  });

  test("o gatilho de refresco é derivado no render, não um efeito novo na página", () => {
    const iniTerminal = scanner.indexOf("const isTerminal = isTerminalUiStatus(uiStatus)");
    const iniSessao = scanner.indexOf("const sessaoTerminada = isTerminal ? activeScanId : null");
    assert.ok(iniTerminal >= 0 && iniSessao > iniTerminal, "o id terminal não é derivado do estado que já existe");
    // Não é pedido à página que consulte o histórico: o painel fá-lo, e só
    // reage quando o id muda — sem polling nem temporizador no painel.
    assert.match(painel, /useEffect\(\(\) => \{\n\s*if \(!sessaoTerminada\) return;\n\s*void consultar\("terminal"\);\n\s*\}, \[sessaoTerminada, consultar\]\);/);
    assert.match(painel, /const consultar = useCallback\(async \(motivo: "inicial" \| "terminal"\)/);
    assert.equal(/setInterval|setTimeout/.test(painel), false, "o painel refresca por temporizador em vez do terminal");
  });

  test("as âncoras de decisão de L1/L2 continuam no sítio, com o mesmo número de chamadas", () => {
    // A pausa desta lane é o scanner e a decisão de estado. Estas chamadas são
    // o perímetro: se uma desaparece ou se duplica, a integração deixou de ser
    // aditiva e isto parte antes dos testes de comportamento.
    for (const funcao of ["decideScanEvent", "decideScanAttachment", "decideScanRecovery"]) {
      assert.ok(new RegExp(`^\\s*${funcao},$`, "m").test(scanner), `falta o import de ${funcao}`);
      assert.ok(scanner.includes(`${funcao}(`), `${funcao} deixou de ser chamada`);
    }
    assert.equal((scanner.match(/\bdecideScanEvent\(/g) ?? []).length, 1, "a decisão de evento foi duplicada");
    assert.equal((scanner.match(/earlyEventsRef\.current/g) ?? []).length, 7, "o amortecedor de eventos precoces mudou de forma");
    assert.ok(scanner.includes("api.onScanProgress((raw: unknown)"), "a subscrição global a scan.progress partiu");
    assert.ok(scanner.includes("expectedScanIdRef.current = null"), "a adopção/rejeição de sessão partiu");
    // O import do painel é a única coisa nova na lista de importações da página.
    assert.equal((scanner.match(/ScanHistoryPanel/g) ?? []).length, 3, "integração do painel não é mínima");
  });
});

describe("R7-L3-FOLLOWUP 5 — o painel diz exatamente o que o serviço sabe", () => {
  test("o estado inicial renderizado é «a consultar» — não uma lista nem um zero", () => {
    (globalThis as Record<string, unknown>).window = { location: { hostname: "" } };
    const h = renderToStaticMarkup(createElement(ScanHistoryPanel, {}));
    assert.match(h, /A consultar o histórico ao serviço…/);
    assert.equal(/history-row|state-chip/.test(h), false, "linhas ou chips antes de haver resposta — H1: a lista virou a tabela do lab, a verdade é a mesma");
    assert.equal(h.includes("Ainda não há análises registadas"), false, "o vazio mostrado antes da primeira leitura");
    assert.equal(h.includes("%"), false, "percentagem desenhada antes de haver leitura");
  });

  test("os três estados terminais têm as três palavras do produto, e mais nenhuma", () => {
    assert.match(
      painel,
      /const ESTADO_LABEL: Record<ScanHistoryEntry\["status"\], string> = \{\n\s*completed: "concluída",\n\s*cancelled: "cancelada",\n\s*failed: "falhou",\n\};/,
    );
    for (const proibido of ["sucesso", "Sucesso"]) {
      assert.equal(textoVisivel.includes(proibido), false, `o painel usa a palavra ${proibido}`);
    }
    // «protegido» só pode existir a negar — é a frase do A4 que diz que o
    // documento NÃO afirma proteção. Mais do que uma ocorrência era veredicto.
    assert.equal((textoVisivel.match(/protegido/g) ?? []).length, 1, "a palavra «protegido» entrou como estado");
    assert.match(textoVisivel, /não afirma\s*\n?\s*que o computador esteja protegido/);
    assert.equal(/Prote[cç][aã]o (ativa|ok|saud)/.test(painel), false, "contagem transformada em veredicto de proteção");
    // Nada de percentagem: o registo tem contagens, não progresso.
    assert.equal(/>[^<]*%/.test(textoVisivel), false, "percentagem pintada no painel do histórico");
  });

  test("campo ausente não é zero, e o que não é número diz «sem leitura»", () => {
    assert.match(corpoDe("numero"), /return typeof valor === "number" && Number\.isFinite\(valor\) \? valor : null;/);
    assert.match(corpoDe("contagem"), /const n = numero\(valor\);/);
    assert.match(corpoDe("contagem"), /\$\{n === null \? "sem leitura" : esc\(n\)\}/);
    for (const campo of ["filesConsidered", "filesAnalyzed", "filesInconclusive", "filesExcluded", "filesFailed", "threatsFound"]) {
      assert.ok(painel.includes(`numero(e.${campo}) ?? "sem leitura"`), `${campo} sem guarda de ausência`);
      assert.equal(painel.includes(`e.${campo} ?? 0`), false, `${campo} substituído por 0`);
    }
  });

  test("resultado inconclusivo aparece como parcial no histórico e no PDF", () => {
    assert.match(painel, /describeScanHistoryOutcome\(e\.status, e\.filesInconclusive\)/);
    assert.match(painel, /resultado\.partial \? "icon-tile icon-tile--warn"/);
    assert.match(painel, /resultado\.label && <span className="state-chip state-chip--na">/);
    const corpo = corpoDe("htmlDoRelatorio");
    assert.match(corpo, /describeScanHistoryOutcome\(e\.status, e\.filesInconclusive\)/);
    assert.match(corpo, /contagem\("Inconclusivos", e\.filesInconclusive\)/);
    assert.match(corpo, /esc\(resultado\.label\)/);
  });

  test("duracao: ms inválido diz «sem leitura», e as unidades têm as suas expressões", () => {
    // A expressão da duração mudou de casa em P0-A-app (15/10): vive em
    // `src/lib/scanHistoryReport.ts` (`formatDuration`) e o painel limita-se a
    // mostrá-la. As asserções mudaram de ficheiro, não de rigor — e ficam
    // acompanhadas da prova de que o painel já não tem uma segunda cópia.
    const corpo = corpoDe("formatDuration", relatorio);
    assert.match(corpo, /if \(typeof ms !== "number" \|\| !Number\.isFinite\(ms\) \|\| ms < 0\) return SEM_LEITURA;/,
      "número ausente ou negativo não pode aparecer como 0 ms");
    assert.match(corpo, /if \(ms < 1000\) return `\$\{Math\.round\(ms\)\} ms`;/);
    assert.match(corpo, /const segundos = ms \/ 1000;/);
    assert.match(corpo, /segundos\.toFixed\(1\)\.replace\("\.", ","\)/,
      "décimo de segundo tem de sair em vírgula (PT-PT)");
    assert.match(corpo, /const minutos = Math\.floor\(segundos \/ 60\);/);
    assert.match(corpo, /if \(minutos < 60\) return `\$\{minutos\} min \$\{resto\} s`;/);
    assert.match(corpo, /return `\$\{horas\} h \$\{minutos % 60\} min`;/);
    assert.equal(painel.includes("function duracao("), false, "o painel voltou a ter a sua própria cópia");
    assert.match(painel, /\{formatDuration\(e\.durationMs\)\}/);
  });

  test("dataHora: PT-PT com guarda para ISO ilegível", () => {
    const corpo = corpoDe("dataHora");
    assert.match(corpo, /if \(Number\.isNaN\(d\.getTime\(\)\)\) return "data ilegível no registo";/,
      "ISO ilegível não pode chegar ao ecrã como Invalid Date");
  });

  test("âmbito e tipo com nomes próprios: Computador / Pasta escolhida", () => {
    assert.match(painel, /default: "Computador",\n\s*custom: "Pasta escolhida",/);
    assert.match(painel, /quick: "Rápida",\n\s*full: "Profunda",\n\s*custom: "Pasta",/);
    // O registo nunca leva caminho de utilizador — nem para mostrar, nem para guardar.
    assert.equal(/e\.path|filePath|targetPath/.test(painel), false, "o painel tentou mostrar um caminho do utilizador");
  });

  test("cada ramificação de leitura está presa ao estado que a justifica", () => {
    assert.match(painel, /if \(typeof api !== "function"\) \{/);
    assert.match(painel, /setFase\("sem_ligacao"\)/);
    assert.match(painel, /setFase\("erro"\)/);
    assert.match(painel, /fase === "sem_ligacao" && \([\s\S]{0,1200}ausência de leitura não é «sem análises»/);
    assert.match(painel, /fase === "pronto" && total === 0 && \([\s\S]{0,1200}Ainda não há análises registadas/);
    assert.match(painel, /fase === "erro" && \([\s\S]{0,900}\{erro\}/);
    // A tentativa de novo existe, mas é a ação do cabeçalho — não um botão por
    // ramo, e nunca um toast que desaparece sozinho.
    assert.match(painel, /onClick=\{\(\) => void consultar\("inicial"\)\}/);
    assert.match(painel, /disabled=\{fase === "a_consultar"\}/);
    assert.match(painel, /\n\s*Recarregar\n/);
    // O texto do vazio só existe dentro do bloco que exige leitura bem-sucedida.
    const iniVazio = painel.indexOf("Ainda não há análises registadas");
    const portaVazio = painel.lastIndexOf('fase === "pronto" && total === 0', iniVazio);
    assert.ok(portaVazio >= 0 && iniVazio - portaVazio < 1200, "o estado vazio saiu do bloco que exige leitura");
  });

  test("«Carregar mais» só existe com cursor, e o pedido leva exatamente o cursor", () => {
    assert.match(painel, /\{cursor !== null && \(/);
    assert.match(painel, /await api\(\{ cursor \}\)/);
    assert.match(painel, /\{aCarregarMais \? "A carregar…" : "Carregar mais"\}/);
    assert.match(painel, /if \(cursor === null \|\| aCarregarMais\) return;/);
  });

  test("cada item tem «Ver detalhes» e «Exportar PDF», nomeados por data, não por índice", () => {
    assert.match(painel, /aria-expanded=\{expandido\}/);
    assert.match(painel, /aria-label=\{`\$\{expandido \? "Ocultar" : "Ver"\} detalhes da análise de \$\{dataHora\(e\.startedAt\)\}`\}/);
    assert.match(painel, /aria-label=\{`Exportar PDF da análise de \$\{dataHora\(e\.startedAt\)\}`\}/);
    assert.match(painel, /disabled=\{!expandido \|\| estado\.tipo === "a_guardar"\}/);
  });

  test("limitações dos motores: só aparecem se o serviço as mediu", () => {
    assert.match(painel, /Array\.isArray\(e\.engineLimitations\) && e\.engineLimitations\.length > 0 && \(/);
    assert.match(painel, /Limitações medidas:<\/b> \{e\.engineLimitations\.join\(" · "\)\}/);
    // Ausente não é substituído por uma afirmação de «sem limitações».
    assert.equal(/sem limitaç/i.test(textoVisivel), false, "o painel afirma ausência de limitação");
  });

  test("o A4 de um registo escapa o que vem do serviço e não empresta números", () => {
    const corpo = corpoDe("htmlDoRelatorio");
    const escrivente = corpoDe("esc");
    for (const substituicao of [/\.replace\(\/&\/g, "&amp;"\)/, /\.replace\(\/<\/g, "&lt;"\)/, /\.replace\(\/>\/g, "&gt;"\)/, /\.replace\(\/"\/g, "&quot;"\)/]) {
      assert.match(escrivente, substituicao, "esc() não cobre todas as entidades");
    }
    for (const campo of ["id", "startedAt", "endedAt", "type", "target", "durationMs", "filesConsidered", "filesAnalyzed", "filesInconclusive", "filesExcluded", "filesFailed", "threatsFound"]) {
      assert.equal(new RegExp(`\\$\\{\\s*e\\.${campo}\\b`).test(corpo), false, `campo ${campo} injectado no HTML sem escapar`);
    }
    // `engineLimitations` é a única coleção: escapa-se item a item, e o valor
    // cru nunca entra no documento.
    assert.match(corpo, /e\.engineLimitations\.map\(\(l\) => esc\(l\)\)\.join\(" · "\)/);
    assert.equal(/e\.engineLimitations\}/.test(corpo), false, "a lista de limitações é injectada sem escapar");
    assert.match(corpo, /esc\(e\.id\)/);
    // Só campos daquele registo: sem score, sem percentagem, sem veredicto.
    assert.equal(/score|riskScore|percent/.test(corpo), false, "o A4 empresta pontuação de outra página");
    assert.match(corpo, /Não é auditoria formal/);
  });

  test("o nome do ficheiro de PDF nasce do id sanitizado, sem caminhos", () => {
    const corpo = corpoDe("nomeDoRegisto");
    assert.match(corpo, /String\(e\.id \?\? ""\)\.replace\(\/\[\^A-Za-z0-9\._-\]\/g, ""\)\.slice\(0, 40\)/);
    assert.match(corpo, /cybersafe-analise-\$\{seguro \|\| "registo"\}\.pdf/);
  });

  test("guardar PDF: canceled é silêncio, sucesso é o caminho devolvido, o resto é erro com a mensagem", () => {
    const corpo = corpoDe("guardarPdf");
    assert.match(corpo, /const api = window\.electronAPI\?\.exportReportPdf;/);
    assert.match(corpo, /if \(result\.canceled === true\) \{/);
    assert.match(corpo, /\{ tipo: "inerte" \}/);
    assert.match(corpo, /result\.success && typeof result\.path === "string" && result\.path !== ""/);
    assert.match(corpo, /result\.error \?\? "A gravação não devolveu caminho nem razão/);
    assert.match(painel, /PDF guardado em: \{estado\.caminho\}/);
    assert.equal(/caminho: "C:\\|"C:\\|savePath/.test(painel), false, "caminho inventado no painel");
  });

  test("as primitivas de design usadas no painel existem todas na folha", () => {
    const usadas = new Set<string>();
    for (const m of painel.matchAll(/"([^"\r\n]{2,})"/g)) {
      for (const token of m[1].split(/\s+/)) {
        if (/^(state-chip|icon-tile|row-|eyebrow-label|evidence-line|stat-card|cyber-border|page-title|page-shell)/.test(token)) {
          usadas.add(token);
        }
      }
    }
    const lista = [...usadas];
    assert.ok(lista.length >= 10, `esperava as primitivas todas, vi ${lista.length}`);
    const semRegra = lista.filter((c) => !decls.includes(`.${c}`));
    assert.equal(semRegra.length, 0, `classes sem regra em index.css: ${semRegra.join(", ")}`);
    // O par chip/mosaico do estado tem de existir na folha — sem modificador inventado.
    for (const estado of ["ok", "crit"]) {
      assert.ok(painel.includes(`icon-tile--${estado}`), `mosaico sem estado ${estado}`);
      assert.ok(decls.includes(`.icon-tile--${estado}`), `.icon-tile--${estado} não existe na folha`);
      assert.ok(painel.includes(`state-chip--${estado}`), `chip sem estado ${estado}`);
      assert.ok(decls.includes(`.state-chip--${estado}`), `.state-chip--${estado} não existe na folha`);
    }
  });
});

describe("R7-L3-B 4 — o PDF do relatório liga-se ao caminho real", () => {
  test("exportar PDF chama exportReportPdf com o HTML e um nome sugerido", () => {
    assert.match(reports, /const exportPdf = \(destino: "pdf" \| "impressao" = "pdf"\)/);
    assert.match(reports, /void guardarPdf\(html, nomeSugerido\(now\)\)/);
    assert.match(reports, /await api\(html, nome\)/);
    assert.match(reports, /cybersafe-relatorio-\$\{now\.getFullYear\(\)\}/);
  });

  test("canceled não é erro; sucesso só afirma o caminho devolvido", () => {
    assert.match(reports, /if \(result\.canceled === true\) \{\n\s*setPdfEstado\(\{ tipo: "inerte" \}\);/);
    assert.match(reports, /result\.success && typeof result\.path === "string" && result\.path !== ""/);
    assert.match(reports, /PDF guardado em: \{pdfEstado\.caminho\}/);
    assert.match(reports, /result\.error \?\? "A gravação não devolveu caminho nem razão/);
  });

  test("o caminho antigo de impressão continua disponível, como ação explícita", () => {
    assert.match(reports, /function abrirParaImpressao\(html: string\)/);
    assert.match(reports, /window\.electronAPI\?\.openReportWindow/);
    assert.match(reports, /exportPdf\("impressao"\)/);
    assert.match(reports, /Abrir para imprimir/);
    assert.match(reports, /Relatório aberto na janela de impressão/);
    // O botão único que prometia PDF e abria impressão deixou de existir.
    assert.equal(reports.includes("Exportar PDF"), false, "volta o botão que mentia sobre o que fazia");
  });

  test("sem o bridge do PDF, diz que não gravou e aponta a reserva", () => {
    assert.match(reports, /Esta janela não tem o guardador de PDF do CyberSafe\. Usa «Abrir para imprimir»\./);
  });
});
