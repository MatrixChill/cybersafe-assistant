import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * POSTHUMAN13 — UI: copy do USB, erro de registo acessível e as três palavras
 * do firewall.
 *
 * Ângulo de cada bloco:
 *  - **USB**: a copy tinha «Observador» e «Opt-in», que não dizem o que o
 *    interruptor faz. O que o serviço faz, lido na fonte
 *    (`packages/service/src/usb-protection.ts`): com `enabled`, uma unidade
 *    **nova** entra na fila e é analisada uma de cada vez; as que já estavam
 *    ligadas no momento da ativação ficam na baseline e não são analisadas; sem
 *    prova de modo só-leitura, o auto-scan é bloqueado no próprio serviço. A
 *    leitura é um poll (`INTERVALO_CONSULTA_MS`, 5 s) — não é tempo real, não
 *    bloqueia, não ejeta. A copy tem de dizer isso, não «monitoriza».
 *  - **Registo**: um erro sem contorno, sem ícone e sem relação campo↔mensagem
 *    é um erro a meias. E revalidar tem de funcionar nos dois sentidos: o que
 *    se corrige desaparece, o que se estraga pelo meio aparece — sem depender
 *    de um segundo clique no submit.
 *  - **Firewall**: «desconhecido», «a verificar» e «não foi possível» são três
 *    coisas. Nenhuma delas é «desligado», e nenhuma é o módulo WFP do CyberSafe.
 *
 * As funções puras são exportadas de propósito (`estadoFirewallPC`,
 * `atributosDeCampo`, `revalidarAoEditar`, `MensagemDeErro`): é o único modo de
 * testar estado interativo sem browser — e o que fica de fora está dito no
 * handoff, não escondido.
 */

(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const { UsbProtectionPanel } = await import("../src/components/UsbProtectionPanel");
const { descreverMonitor, INTERVALO_CONSULTA_MS } = await import("../src/lib/usbProtection");
const { estadoFirewallPC } = await import("../src/components/PCHealthSection");
const RegisterPage = (await import("../src/pages/RegisterPage")).default;
const { atributosDeCampo, idDoErro, revalidarAoEditar, MensagemDeErro, validarRegisto } =
  await import("../src/pages/RegisterPage");
const { AuthProvider } = await import("../src/contexts/AuthContext");

const ler = (...partes: string[]) =>
  readFileSync(new URL(`../src/${partes.join("/")}`, import.meta.url), "utf8");
const painelUsb = ler("components", "UsbProtectionPanel.tsx");
/** A fonte do painel sem quebras de linha: as frases do JSX vão por duas linhas. */
const fonte = painelUsb.replace(/\s+/g, " ");
const pccentro = ler("components", "PCHealthSection.tsx");
const registo = ler("pages", "RegisterPage.tsx");

const snapshotDe = (over: Record<string, unknown> = {}) => ({
  version: 1 as const,
  enabled: false,
  monitorStatus: "operational",
  updatedAt: "2026-10-13T10:00:00.000Z",
  devices: [],
  ...over,
});

describe("POSTHUMAN13 — copy do USB diz o que o serviço faz", () => {
  test("os três títulos do monitor mudaram de nome, sem mudar de semântica", () => {
    assert.equal(descreverMonitor(snapshotDe({ monitorStatus: "starting" }) as never).titulo,
      "Monitorização USB a arrancar");
    assert.equal(descreverMonitor(snapshotDe({ monitorStatus: "unavailable" }) as never).titulo,
      "Monitorização USB indisponível");
    // SESSION14: o título conta LIGADOS CONFIRMADOS. Este fixture não tem
    // `present`, e presença sem campo de presença não se afirma — a string
    // pinada segue a semântica, o assertion continua a ser o mesmo título.
    assert.equal(descreverMonitor(snapshotDe({
      monitorStatus: "operational", devices: [{ id: "u1" }],
    }) as never).titulo, "Monitorização operacional · 0 unidades ligadas");
    // O vazio continua a não ser garantia de nada.
    assert.match(descreverMonitor(snapshotDe() as never).detalhe, /não é uma garantia de proteção/);
  });

  test("a copy descreve análise autorizada, fila, só-leitura e baseline", () => {
    const texto = fonte.replace(/<[^>]+>/g, " ");
    assert.match(texto, /pede a análise/, "a copy diz só «monitoriza» e esconde que analisa");
    assert.match(texto, /uma de cada vez/, "a fila do motor não está dita");
    assert.match(texto, /só-leitura/, "a condição de leitura só-leitura não está dita");
    assert.match(texto, /já estava ligado/, "a baseline (o que já estava ligado não é analisado) não está dita");
  });

  test("a copy não promete tempo real, bloqueio nem ejeção", () => {
    assert.match(fonte, /não é proteção em tempo real/);
    assert.match(fonte, /Não bloqueia, não ejeta/);
    // O intervalo é o do lib — o número da frase não pode divergir do poll.
    assert.equal(INTERVALO_CONSULTA_MS, 5_000);
    assert.match(fonte, /é lida a cada 5 s/);
  });

  test("«Observador» e «Opt-in» saíram do painel", () => {
    assert.equal(/Observador|Opt-in/.test(painelUsb), false, "voltou a palavra que não dizia nada");
    const markup = renderToStaticMarkup(createElement(UsbProtectionPanel));
    assert.match(markup, /Monitorização de unidades USB/);
    assert.match(markup, /Monitorização USB: <b class="font-semibold">desconhecida<\/b>/);
    assert.match(markup, /A consultar a monitorização USB ao serviço…/);
    assert.match(markup, /Ligar monitorização/);
  });
});

describe("POSTHUMAN13 — o erro de registo é dito, não insinuado", () => {
  test("sem erro não há atributos de erro", () => {
    assert.deepEqual(atributosDeCampo("email", {}), {});
    assert.equal("aria-invalid" in atributosDeCampo("email", {}), false,
      "aria-invalid=false é ruído na árvore de acessibilidade");
  });

  test("com erro: invalido dito, mensagem no id apontado, contorno do token", () => {
    const atributos = atributosDeCampo("email", { email: "O formato do email não é válido." });
    assert.equal(atributos["aria-invalid"], true);
    assert.equal(atributos["aria-describedby"], "register-email-erro");
    assert.equal(atributos.style?.borderColor, "var(--state-crit-edge)",
      "o contorno não vem do token do estado crítico");

    const markup = renderToStaticMarkup(createElement(MensagemDeErro, {
      campo: "email", erros: { email: "O formato do email não é válido." },
    }));
    // O id prometido pelo campo tem de existir na mensagem, senão o
    // `aria-describedby` aponta para o nada.
    assert.match(markup, /id="register-email-erro"/);
    assert.equal(markup.includes(idDoErro("email") ?? "?"), true, "id divergente do declarado");
    assert.match(markup, /role="alert"/, "a mensagem não é anunciada");
    assert.match(markup, /<svg/, "não há ícone: a cor seria a única pista");
    assert.match(markup, /border-color:var\(--cyber-red-text\)|color:var\(--cyber-red-text\)/,
      "a mensagem não usa a variante de texto medida do vermelho");
  });

  test("os ids de erro e de campo batem certo em todos os campos", () => {
    for (const campo of ["name", "email", "password", "company"] as const) {
      const id = idDoErro(campo);
      assert.ok(id?.startsWith(`register-${campo}`), `${campo}: id improvável ${id}`);
      assert.ok(registo.includes(`id="register-${campo === "company" ? "company" : campo}"`),
        `${campo}: o input não tem o id de que a mensagem depende`);
    }
  });

  test("revalidar: antes do submit não há queixas; depois, os dois sentidos", () => {
    const bons = {
      name: "Ana Sousa", email: "ana@exemplo.pt", password: "segura123",
      confirmPassword: "segura123", accountType: "personal" as const, companyName: "",
    };
    assert.deepEqual(revalidarAoEditar({ ...bons, name: "" }, false), {},
      "o formulário queixa-se antes da primeira tentativa");
    // Corrigido → a queixa sai.
    assert.deepEqual(revalidarAoEditar(bons, true), {});
    // Estragado pelo meio → a queixa nova aparece sem novo submit.
    assert.match(revalidarAoEditar({ ...bons, confirmPassword: "outra" }, true).password ?? "",
      /não coincidem/);
    // E a ausência de nome continua a ser dita (nada foi «escondido para limpar».)
    assert.ok(revalidarAoEditar({ ...bons, confirmPassword: "outra", name: " " }, true).name);
    assert.ok(Object.keys(validarRegisto({ ...bons, email: "x" })).length >= 1);
  });

  test("o arranque continua honesto: pessoal por defeito, sem erros pintados", () => {
    const markup = renderToStaticMarkup(createElement(AuthProvider, null,
      createElement(RegisterPage, { onSwitchToLogin: () => {} })));
    assert.equal(/aria-invalid/.test(markup), false, "há campos inválidos antes de qualquer tentativa");
    assert.equal(/style="border-color/.test(markup), false, "contorno de erro sem erro");
    assert.equal(markup.includes("aria-pressed=\"true\""), true);
  });
});

describe("POSTHUMAN13 — as três palavras do Firewall do Windows", () => {
  const lido = (enabled: boolean) => ({
    available: true, enabled, profiles: [{ name: "Domain", enabled }, { name: "Public", enabled }],
  });

  test("leitura confirmada diz ativo/desligado, com os perfis em pt-PT", () => {
    assert.deepEqual(estadoFirewallPC(lido(true)), {
      valor: "Ativo", detalhe: "Domínio:ativo · Pública:ativo", cor: "ok",
    });
    const off = estadoFirewallPC(lido(false));
    assert.equal(off.valor, "Desligado");
    assert.equal(off.cor, "crit");
    assert.match(off.detalhe, /domínio:desligado · pública:desligado/i);
  });

  test("sem leitura NÃO é «desligado»; e os três tipos de ignorância separam-se", () => {
    for (const estado of [undefined, null, { available: false, enabled: false, profiles: [] }] as const) {
      const e = estadoFirewallPC(estado as never);
      assert.equal(e.valor, "Não verificado", `${JSON.stringify(estado)}: ausência virou afirmação`);
      assert.equal(e.cor, undefined, "o desconhecido herdou a cor do desligado");
      assert.match(e.detalhe, /ausência de leitura não é firewall desligado/);
    }
    assert.equal(estadoFirewallPC(undefined, true).valor, "A verificar…");
    assert.equal(estadoFirewallPC(undefined, false, true).valor, "Não foi possível verificar");
    // Um pedido em voo manda no que se mostra; uma rejeição não vira «Ativo».
    assert.equal(estadoFirewallPC(undefined, true, true).valor, "A verificar…");
    assert.equal(estadoFirewallPC(lido(true), true).valor, "Ativo",
      "o refresh apaga uma leitura que já existia");
  });

  test("a linha chama-se Firewall do Windows e não se confunde com o WFP", () => {
    assert.match(pccentro, /label="Firewall do Windows"/);
    assert.equal(/label="Firewall"/.test(pccentro.replace(/label="Firewall do Windows"/g, "")), false,
      "voltou a etiqueta ambígua");
    // O valor desta linha só pode vir do `firewall` do snapshot do Windows.
    assert.match(pccentro, /estadoFirewallPC\(health\.firewall, refreshing, readError !== null\)/);
    assert.equal(/estadoFirewallPC\([^)]*(wfp|subsystems|engine)/.test(pccentro), false,
      "o módulo WFP do CyberSafe voltou a fazer de firewall da Microsoft");
    assert.match(ler("lib", "protectionHealth.ts"), /Isto não significa que o Firewall do Windows esteja desligado/);
  });
});
