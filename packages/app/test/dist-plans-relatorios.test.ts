import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * DIST13 — o que é essencial, o que é de empresa, e o que ninguém pode comprar.
 *
 * O contrato desta edição académica é gratuito, e a verificação dirigida provou
 * que **não existe caminho nenhum para atribuir um plano**: o `POST /auth/register`
 * ignora `plan` e nasce `free` (`packages/api/src/index.ts:322-325`), não há
 * `PATCH`/`PUT` de conta (`:360`, `:452`, `:471`, `:568`, `:628`, `:710`, `:791`
 * são os únicos mutations), e `getNextPlan`, `isUpgradeAvailable`, `getUserLimits`,
 * `isProFeature` e `NAV_FEATURE_MAP` **não têm um único consumidor** em
 * `packages/app/src`. Logo: um bloqueio por `pro`/`premium` não é uma porta que
 * se possa abrir — é uma parede.
 *
 * O defeito real (RED abaixo): `REPORTS` estava atado ao **plano**, ao contrário
 * do `BUSINESS_SECURITY_CENTER`, que é do **tipo de conta**. Uma conta de empresa
 * `free` — exatamente o que este produto consegue criar — ficava de fora do
 * relatório PDF do painel de Relatórios enquanto o Centro de Segurança lhe estava
 * aberto. É o mesmo isolamente de conta, com duas regras: `personal` nunca vê
 * Relatórios (isso é tenant, não dinheiro), `business` vê porque é a conta dela.
 *
 * Não alarga features futuras, não toca em `role` nem em `tenant`, e não mexe na
 * matriz `PLANS` inteira: é uma linha de regra, com o motivo escrito.
 */

(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const { canAccess, canUserAccess, FEATURES, PLANS, getUserFeatures } =
  await import("../src/lib/featureControl");
const Sidebar = (await import("../src/components/Sidebar")).default;
const { AppearanceProvider } = await import("../src/contexts/AppearanceContext");

describe("DIST13 — Relatórios: tipo de conta, não plano inexistente", () => {
  test("empresa free tem o mesmo acesso a Relatórios que tem ao Centro de Segurança", () => {
    const centro = canAccess(FEATURES.BUSINESS_SECURITY_CENTER, "business", "free", "user");
    const relatorios = canAccess(FEATURES.REPORTS, "business", "free", "user");
    assert.equal(centro, true, "o Centro de Segurança de empresa free desapareceu");
    assert.equal(relatorios, centro,
      "Relatórios está atado a um plano que esta edição não sabe atribuir");
  });

  test("o isolamento personal/business mantém-se em todos os planos", () => {
    for (const plan of ["free", "pro", "premium"] as const) {
      assert.equal(canAccess(FEATURES.REPORTS, "personal", plan, "user"), false,
        `personal/${plan} passou a ver o que é de empresa`);
      assert.equal(canAccess(FEATURES.REPORTS_ADVANCED, "personal", plan, "user"), false,
        `personal/${plan} passou a ver relatórios avançados`);
      assert.equal(canAccess(FEATURES.BUSINESS_SECURITY_CENTER, "personal", plan, "user"), false);
    }
  });

  test("admin personal não desbloqueia Relatórios (a regra é de conta, não de role)", () => {
    assert.equal(canAccess(FEATURES.REPORTS, "personal", "free", "admin"), false,
      "o role passou a valer como tipo de conta");
    assert.equal(canAccess(FEATURES.REPORTS, "business", "free", "user"), true);
  });

  test("contas com plano atribuído não perdem nada", () => {
    assert.equal(canAccess(FEATURES.REPORTS, "business", "pro", "user"), true);
    assert.equal(canAccess(FEATURES.REPORTS, "business", "premium", "user"), true);
    assert.equal(canAccess(FEATURES.REPORTS_ADVANCED, "business", "premium", "user"), true);
    assert.ok(PLANS.pro.features.includes(FEATURES.SCANNER_DEEP), "a matriz PLANS foi alterada");
    assert.ok(getUserFeatures("personal", "free").includes(FEATURES.SCANNER), "free perdeu o scanner");
  });

  test("o essencial da demonstração continua free para uma conta pessoal", () => {
    for (const f of [FEATURES.DASHBOARD_BASIC, FEATURES.SCANNER, FEATURES.THREATS,
      FEATURES.MONITOR_BASIC, FEATURES.SIMULATOR, FEATURES.AI_ASSISTANT, FEATURES.QUARANTINE] as const) {
      assert.equal(canUserAccess(f, { type: "personal", plan: "free", role: "user" }), true,
        `${f} deixou de estar disponível numa conta free`);
    }
  });
});

describe("DIST13 — compatibilidade: Pro legado não perde o essencial do free", () => {
  /** Reproduzido ANTES do patch, medido a 13/10 com o `canAccess` real:
   *  «NAO SCANNER personal/pro»«NAO THREATS personal/pro»«NAO DASHBOARD_BASIC
   *  personal/pro»«NAO MONITOR_BASIC business/pro»«NAO QUARANTINE personal/pro»
   *  «NAO AI_ASSISTANT personal/pro». Causa: `getUserFeatures` para `pro`
   *  devolvia `PLANS.pro.features + accountSpecific`, sem a base do `free` — logo
   *  a sidebar escondia a Análise de Segurança, as Ameaças, o PC Center, o
   *  Monitor, a Quarentena e o Assistente IA a uma conta Pro já existente. */
  const base = [FEATURES.DASHBOARD_BASIC, FEATURES.SCANNER, FEATURES.THREATS,
    FEATURES.MONITOR_BASIC, FEATURES.SIMULATOR, FEATURES.AI_ASSISTANT, FEATURES.QUARANTINE] as const;

  test("pro (pessoal e empresa) mantém o que o free já tinha", () => {
    for (const f of base) {
      assert.equal(canAccess(f, "personal", "pro", "user"), true, `personal/pro perdeu ${f}`);
      assert.equal(canAccess(f, "business", "pro", "user"), true, `business/pro perdeu ${f}`);
      assert.equal(canAccess(f, "personal", "premium", "user"), true, `personal/premium perdeu ${f}`);
    }
  });

  test("a união não é um cheque em branco: nada de empresa em contas pessoais", () => {
    for (const plan of ["free", "pro", "premium"] as const) {
      assert.equal(canAccess(FEATURES.USB_PROTECTION, "personal", plan, "user"), false,
        `personal/${plan} ganhou uma feature de empresa`);
      assert.equal(canAccess(FEATURES.DEVICE_MANAGEMENT, "personal", plan, "user"), false);
      assert.equal(canAccess(FEATURES.REPORTS, "personal", plan, "user"), false);
      assert.equal(canAccess(FEATURES.REPORTS_ADVANCED, "personal", plan, "user"), false);
      assert.equal(canAccess(FEATURES.BUSINESS_SECURITY_CENTER, "personal", plan, "user"), false);
    }
    assert.equal(canAccess(FEATURES.REPORTS, "personal", "premium", "user"), false,
      "a asserção antiga personal/premium sem REPORTS tinha de se manter");
    assert.equal(canAccess(FEATURES.SCANNER_DEEP, "personal", "free", "user"), false,
      "a análise profunda passou a grátis sem decisão nenhuma");
  });

  test("a matriz PLANS não foi reescrita: a união acontece na resolução", () => {
    assert.ok(!PLANS.free.features.includes(FEATURES.SCANNER_DEEP),
      "o free passou a ter o que é futuro");
    assert.ok(!PLANS.pro.features.includes(FEATURES.SCANNER),
      "meteram a base na tabela: a regra deixou de se poder ler");
    assert.ok(PLANS.pro.features.includes(FEATURES.SCANNER_DEEP));
    assert.equal(PLANS.pro.features.includes(FEATURES.REPORTS), false);
  });
});

describe("DIST13 — a sidebar não anuncia uma tier que ninguém pode comprar", () => {
  /** A placa «PRO» vive só do `proOnly` do item (`Sidebar.tsx:239-243`). O badge
      «BUSINESS» é o ramo de cima e descreve a conta, não um preço: fica. */
  const renderizar = (tipo: "personal" | "business", plano: "free" | "pro" | "premium") =>
    renderToStaticMarkup(createElement(AppearanceProvider, null, createElement(Sidebar as React.ComponentType<Record<string, unknown>>, {
      activePage: "dashboard",
      onNavigate: () => {},
      theme: "dark",
      onThemeChange: () => {},
      accent: "cyan",
      onAccentChange: () => {},
      identity: "cybersafe-core",
      onIdentityChange: () => {},
      user: {
        id: "u-1", name: "Ana Sousa", email: "ana@exemplo.pt",
        type: tipo, plan: plano, role: "user", createdAt: "2026-10-13T00:00:00.000Z",
      },
      onLogout: () => {},
      level: null,
    })));

  const textoDe = (tipo: "personal" | "business", plano: "free" | "pro" | "premium") =>
    renderizar(tipo, plano).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

  test("empresa free vê Relatórios, sem placa de tier", () => {
    const texto = textoDe("business", "free");
    assert.match(texto, /Relatórios/, "o item de Relatórios desapareceu da conta de empresa");
    assert.equal(/(^|\s)PRO(\s|$)/.test(texto), false,
      "a placa «PRO» anuncia um plano que este produto não atribui");
    assert.match(texto, /BUSINESS/, "o badge de empresa (descreve a conta) tinha de ficar");
  });

  test("conta pessoal não vê Relatórios nem Business Center, em nenhum plano", () => {
    for (const plano of ["free", "pro", "premium"] as const) {
      const texto = textoDe("personal", plano);
      assert.equal(texto.includes("Relatórios"), false, `Relatórios apareceu a personal/${plano}`);
      assert.equal(texto.includes("Business Center"), false, `o centro de empresa apareceu a personal/${plano}`);
      assert.equal(/(^|\s)PRO(\s|$)/.test(texto), false, `placa de tier em personal/${plano}`);
      assert.match(texto, /Otimizar/);
      assert.match(texto, /Análise de Segurança/);
    }
  });

  test("Pro legado volta a ver o scanner no menu (o defeito medido, em markup)", () => {
    const texto = textoDe("personal", "pro");
    assert.match(texto, /Análise de Segurança/, "Pro legado perdeu a Análise de Segurança do menu");
    assert.match(texto, /Ameaças/);
    assert.match(texto, /PC Center/);
    assert.match(texto, /Monitor em Tempo Real/);
    assert.match(texto, /Otimizar/);
  });
});
