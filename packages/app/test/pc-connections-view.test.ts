/**
 * P1-B2 — tabela de conexões do PC Center (teste humano de 15/10).
 *
 * O que aqui fica fixado, com a medição que o sustenta:
 *
 *  1. A coluna «Estado» mostrava «100». A fonte é
 *     `Get-NetTCPConnection … | ConvertTo-Json`, que serializa o enum `State`
 *     como NÚMERO, e 100 = Bound é o valor MAIS frequente desta máquina (70 de
 *     ~208 tomadas). Medido correlacionando o nome com o número:
 *     Bound=100, Listen=2, Established=5, CloseWait=8, TimeWait=11.
 *     Nenhum mapa do produto tinha o 100, e o código cru era impresso como se
 *     fosse um estado.
 *  2. Código desconhecido = «Desconhecido». Nunca um número solto, nunca uma
 *     percentagem, nunca um significado inventado.
 *  3. IPv6 legível, ausentes como «—» (nunca `0`, nunca `undefined`), e uma
 *     tomada à escuta/reservada sem par remoto não inventa um destino.
 *  4. O cabeçalho da tabela é pegajoso e OPACO (era translúcido: liam-se as
 *     linhas a passar por baixo) e as três medidas do PC Center passam a estar
 *     explicadas em texto visível.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const {
  estadoTcp,
  estadoTcpTitle,
  formatEndpoint,
  formatOwningProcess,
  formatRemote,
  ESTADO_DESCONHECIDO,
} = await import("../src/lib/netConnectionsView");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (...parts: string[]) => fs.readFileSync(path.join(HERE, ...parts), "utf8");
const PC_HEALTH = read("..", "src", "components", "PCHealthSection.tsx");
const PC_CENTER = read("..", "src", "pages", "PCCenterPage.tsx");

describe("P1-B2 (2) — o estado TCP lê-se, não se adivinha", () => {
  test("mapa numérico MEDIDO nesta máquina (inclui 100 = Bound)", () => {
    const medido: Array<[number, string]> = [
      [2, "Listen"],
      [5, "Established"],
      [8, "CloseWait"],
      [11, "TimeWait"],
      [100, "Bound"],
    ];
    for (const [codigo, canonico] of medido) {
      assert.equal(estadoTcp(codigo).canonico, canonico, `código ${codigo} da fonte`);
    }
  });

  test("o defeito reportado: o código cru nunca é o que se mostra", () => {
    const estado = estadoTcp(100);
    assert.notEqual(estado.label, "100", "volta a ser impresso o código cru");
    assert.notEqual(estado.label, estado.codigoCru, "o código cru virou rótulo");
    assert.match(estado.label, /[A-Za-zÀ-ÿ]/, "o rótulo tem de ser uma palavra, não um número");
    assert.equal(/%/.test(estado.label), false, "estado não é percentagem");
  });

  test("o mesmo estado em número, em número-como-texto ou em nome", () => {
    for (const entrada of [5, "5", "Established", "established", "ESTABLISHED"] as const) {
      assert.equal(estadoTcp(entrada).label, "Estabelecida", String(entrada));
    }
    assert.equal(estadoTcp(2).label, "À escuta");
    assert.equal(estadoTcp("Listen").label, "À escuta");
  });

  test("código que o mapa não conhece: «Desconhecido», com o código guardado como evidência", () => {
    for (const entrada of [999, "13", "IPv6", "Nonsense"] as const) {
      const estado = estadoTcp(entrada);
      assert.equal(estado.label, ESTADO_DESCONHECIDO, String(entrada));
      assert.equal(estado.canonico, null);
      assert.match(estadoTcpTitle(estado) ?? "", /Estado não reconhecido/, String(entrada));
    }
    // Ausência pura não é código nenhum para mostrar.
    for (const entrada of [null, undefined, "", "   "] as const) {
      assert.equal(estadoTcp(entrada).label, ESTADO_DESCONHECIDO, String(entrada));
      assert.equal(estadoTcp(entrada).codigoCru, null);
    }
  });

  test("os rótulos são PT-PT e nenhum estado conhecido é apresentado em inglês", () => {
    for (const codigo of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 100]) {
      const { label } = estadoTcp(codigo);
      assert.match(label, /^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ ()]*$/, `rótulo estranho em ${codigo}: ${label}`);
      assert.equal(
        ["Bound", "Closed", "Listen"].includes(label),
        false,
        `o inglês da fonte passou para o ecrã em ${codigo}`,
      );
    }
  });
});

describe("P1-B2 (3) — endereços legíveis e ausência dita como ausência", () => {
  test("IPv6 ganha parênteses rectos (senão `::1:443` não se lê)", () => {
    assert.equal(formatEndpoint("fe80::1c2b:3f4a", 443), "[fe80::1c2b:3f4a]:443");
    assert.equal(formatEndpoint("::", 0), "[::]");
    assert.equal(formatEndpoint("127.0.0.1", 49712), "127.0.0.1:49712");
  });

  test("ausente é «—»; porta 0 não se escreve; nada vira 0 nem undefined", () => {
    assert.equal(formatEndpoint(undefined, undefined), "—");
    assert.equal(formatEndpoint(null, null), "—");
    assert.equal(formatEndpoint("", 0), "—");
    assert.equal(formatEndpoint("0.0.0.0", 0), "0.0.0.0");
    assert.equal(formatEndpoint("0.0.0.0", "0"), "0.0.0.0");
    for (const entrada of [undefined, null, ""] as const) {
      assert.equal(/undefined|null|NaN/.test(formatEndpoint(entrada, entrada)), false);
    }
  });

  test("escutas e portas reservadas não inventam par remoto", () => {
    assert.equal(formatRemote(estadoTcp(2), "0.0.0.0", 0), "—");
    assert.equal(formatRemote(estadoTcp(100), "::", 0), "—");
    assert.equal(formatRemote(estadoTcp(5), "142.250.0.1", 443), "142.250.0.1:443");
    // Estado desconhecido: mostram-se os dados, sem interpretação nenhuma.
    assert.equal(formatRemote(estadoTcp(999), "0.0.0.0", 0), "0.0.0.0");
  });

  test("processo dono: nome, senão o PID, senão «—»", () => {
    assert.equal(formatOwningProcess("chrome.exe", 1234), "chrome.exe");
    assert.equal(formatOwningProcess(null, 8824), "PID 8824");
    assert.equal(formatOwningProcess("", 0), "—");
    assert.equal(formatOwningProcess(null, null), "—");
  });
});

describe("P1-B2 (1) — o cabeçalho da tabela não deixa ver as linhas por baixo", () => {
  // A tabela das CONEXÕES, não a dos processos: é a única com cabeçalho pegajoso.
  const thead = /<thead[^>]*sticky[^>]*>/.exec(PC_HEALTH)?.[0] ?? "";
  const inicioTabela = PC_HEALTH.indexOf(thead);
  const tabela = inicioTabela >= 0
    ? PC_HEALTH.slice(inicioTabela, PC_HEALTH.indexOf("</table>", inicioTabela))
    : "";

  test("o cabeçalho pegajoso é opaco (era `bg-secondary/50`, ~6% de alfa)", () => {
    assert.ok(thead !== "", "não encontrei o cabeçalho pegajoso das conexões");
    assert.match(thead, /sticky top-0/, "o cabeçalho deixou de ser pegajoso");
    assert.match(thead, /\bconnections-thead\b/, "falta a classe opaca do cabeçalho");
    // MEDIDO: `bg-secondary` resolve para rgba(129,207,207,0.12) e o `/50` para
    // ~6%. Qualquer fundo por token de superfície deixa ver as linhas a passar.
    assert.equal(/bg-secondary\/\d/.test(thead), false, "voltou o cabeçalho translúcido");
    assert.equal(/\bbg-secondary\b/.test(thead), false, "`bg-secondary` sozinho não é opaco");
    assert.equal(/\bbg-card\b/.test(thead), false, "`--card` é translúcido em 7 dos 10 temas");
    assert.match(thead, /\bz-10\b/, "sem z-index o cabeçalho pode ficar por baixo das linhas");
  });

  test("a classe opaca assenta num token opaco em TODOS os temas", () => {
    const css = read("..", "src", "index.css");
    const regra = /\.connections-thead\s*\{[^}]*\}/.exec(css)?.[0] ?? "";
    assert.match(regra, /background-color:\s*var\(--background\)/, "a base do cabeçalho não é opaca");
    assert.match(
      regra,
      /background-image:\s*linear-gradient\(var\(--secondary\),\s*var\(--secondary\)\)/,
      "o tom do sistema tem de entrar como camada pintada por cima da base opaca",
    );
    // O invariante que faz isto funcionar: `--background` nunca ganha alfa.
    const fundos = [...css.matchAll(/--background:\s*([^;]+);/g)].map((m) => m[1].trim());
    assert.ok(fundos.length >= 8, `esperava um --background por tema, obtive ${fundos.length}`);
    for (const valor of fundos) {
      assert.equal(
        /rgba\(|\/\s*0?\.\d+\s*\)/.test(valor),
        false,
        `--background translúcido (${valor}): o cabeçalho voltaria a deixar ver as linhas`,
      );
    }
  });

  test("sem cantos redondos num cabeçalho fixo (deixavam ver os cantos das linhas)", () => {
    assert.ok(tabela !== "", "não isolei a tabela das conexões");
    assert.equal(/rounded-t[lr]-lg/.test(tabela), false, "voltaram os cantos redondos no cabeçalho fixo");
  });

  test("a tabela usa os helpers e já não tem mapa local de estados", () => {
    assert.match(PC_HEALTH, /from "@\/lib\/netConnectionsView"/);
    assert.match(PC_HEALTH, /const estado = estadoTcp\(c\.state\)/);
    assert.match(PC_HEALTH, /formatEndpoint\(c\.localAddress, c\.localPort\)/);
    assert.match(PC_HEALTH, /formatRemote\(estado, c\.remoteAddress, c\.remotePort\)/);
    assert.equal(
      /TCP_STATE_PT\[c\.state\] \?\? c\.state/.test(PC_HEALTH),
      false,
      "voltou o `?? c.state` que imprimia o código cru",
    );
    assert.equal(/const TCP_STATE_PT/.test(PC_HEALTH), false, "mapa de estados duplicado no componente");
  });

  test("os números da tabela alinham (tabular-nums nas colunas de endereço)", () => {
    const tabulares = PC_HEALTH.match(/text-muted-foreground tabular-nums/g) ?? [];
    assert.ok(tabulares.length >= 2, `esperava Local e Remoto com tabular-nums, obtive ${tabulares.length}`);
  });
});

describe("P1-B2 (4) — as três medidas do PC Center explicadas em texto", () => {
  test("há uma frase visível que distingue veredicto, stress e saúde do Windows", () => {
    assert.match(PC_CENTER, /três medidas diferentes e não se somam/);
    const frase = /três medidas diferentes e não se somam[\s\S]{0,600}?<\/p>/.exec(PC_CENTER)?.[0] ?? "";
    assert.match(frase, /veredicto dos achados/, "não diz de onde vem o título do estado");
    assert.match(frase, /Índice de Stress/, "não nomeia o índice de stress");
    assert.match(frase, /carga\s+instantânea/, "não diz o que o índice de stress mede");
    assert.match(frase, /Saúde do PC/, "não nomeia a saúde do PC");
    assert.match(frase, /nota lida ao Windows/, "não diz de onde vem a saúde do PC");
  });

  test("a frase é texto, não um tooltip escondido", () => {
    // O `title=` antigo só aparecia com o rato parado por cima; a explicação
    // tem de estar no ecrã, em parágrafo.
    assert.match(PC_CENTER, /<p className="mt-3 max-w-md[^"]*">\s*\n\s*São três medidas/);
    // O tooltip antigo do «Saúde do PC» vive no componente da saúde do Windows
    // e não foi removido: a frase nova acrescenta-se a ele, não o substitui.
    assert.match(PC_HEALTH, /title="Nota de saúde do computador/);
  });

  test("a temperatura continua a não contar como zero quando não é medida", () => {
    assert.match(PC_CENTER, /unmeasured: !temperatureMeasured/);
    assert.match(PC_CENTER, /c\.unmeasured \? "s\/ leitura" : c\.value/);
  });
});
