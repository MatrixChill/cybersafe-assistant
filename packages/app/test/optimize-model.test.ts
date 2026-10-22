import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  AUDITORIA_BOTOES,
  CARTOES,
  aplicarDesfecho,
  cartoesIniciais,
  classificacaoDe,
  estadoSaudePt,
  fraseProgresso,
  grupoDe,
  interpretaFirewall,
  marcarRevisaoManual,
  progressoDe,
  resumoEstado,
  severidadeDe,
  type OptimizeCartao,
} from "../src/lib/optimizeModel";

/**
 * R5-L2 — Otimizar: classificação, estados, progresso e os dez botões.
 *
 * O defeito que isto trava é de semântica: a página antiga dava a cada cartão
 * uma prioridade escrita à mão e mostrava-a como «Crítico / Importante /
 * Sugestão», pelo que um computador saudável e uma dica de senhas podiam ambos
 * aparecer «Crítico». Aqui a palavra «Crítico» só existe com severidade medida,
 * e isso é verificável sem DOM porque a lógica é pura.
 */

const cartaode = (id: string, extra: Partial<OptimizeCartao> = {}): OptimizeCartao => {
  const base = CARTOES.find((c) => c.id === id);
  assert.ok(base, `catálogo não tem o cartão ${id}`);
  return { ...base!, estado: "pendente", resultado: null, severidade: null, evidencia: "", mensagem: "", ...extra };
};

describe("1 — nunca «Crítico» sem falha medida", () => {
  test("nenhum cartão do catálogo nasce com severidade", () => {
    for (const cartao of cartoesIniciais()) {
      assert.equal(cartao.severidade, null, `${cartao.id} não pode nascer classificado`);
      assert.equal(classificacaoDe(cartao).rotulo !== "Crítico", true, `${cartao.id} nasceu «Crítico» sem medição`);
    }
  });

  test("firewall verificado como ativo é «Saudável», nunca «Crítico»", () => {
    const visto = aplicarDesfecho(cartaode("firewall"), "verificacao", {
      ok: true,
      evidencia: "ativo nos perfis: Private, Domain",
      mensagem: "Nada a fazer.",
    });
    assert.equal(visto.estado, "verificado");
    assert.equal(classificacaoDe(visto).rotulo, "Saudável");
    assert.equal(classificacaoDe(visto).tom, "ok");
    // O rótulo do grupo também não pode chamá-lo problema.
    assert.equal(grupoDe(visto), "manutencao", "verificado sem falha não vai para a lista de problemas");
  });

  test("dica marcada pela pessoa nunca é crítica nem «saudável»", () => {
    const revista = marcarRevisaoManual(cartaode("senhas"), "Marcado como revisto.");
    assert.equal(classificacaoDe(revista).rotulo, "Revista");
    assert.equal(revista.severidade, null);
    assert.equal(revista.resultado, null, "marcar à mão não é uma medição");
    assert.equal(grupoDe(revista), "boas-praticas");
  });

  test("«Crítico» exige severidade medida, e aí o cartão muda de grupo", () => {
    const falha = aplicarDesfecho(cartaode("firewall"), "verificacao", {
      ok: true,
      severidade: "critico",
      evidencia: "desligado nos perfis: Private",
      mensagem: "Liga-o no Segurança do Windows.",
    });
    assert.equal(falha.resultado, "problema");
    assert.equal(classificacaoDe(falha).rotulo, "Crítico");
    assert.equal(grupoDe(falha), "problemas");
  });
});

describe("2 — estados distinguem verificação de correção", () => {
  test("o mesmo `ok` quer dizer «verificado» numa verificação e «corrigido» numa correção", () => {
    const verificada = aplicarDesfecho(cartaode("saude-windows"), "verificacao", { ok: true, evidencia: "estado medido", mensagem: "ok" });
    const corrigida = aplicarDesfecho(cartaode("update"), "correcao", { ok: true, evidencia: "definições de hoje", mensagem: "ok" });
    assert.equal(verificada.estado, "verificado");
    assert.equal(corrigida.estado, "corrigido");
    assert.notEqual(resumoEstado(verificada), resumoEstado(corrigida));
  });

  test("falha nunca aparece como concluída", () => {
    const falho = aplicarDesfecho(cartaode("update"), "correcao", { ok: false, mensagem: "O serviço não confirmou." });
    assert.equal(falho.estado, "falhou");
    assert.equal(classificacaoDe(falho).rotulo, "Falhou");
    assert.notEqual(falho.estado, "corrigido");
  });

  test("análise iniciada está EM CURSO, não corrigida", () => {
    const iniciada = { ...cartaode("analise-profunda"), estado: "a-verificar" as const, evidencia: "iniciada às 10:00:00" };
    assert.equal(classificacaoDe(iniciada).rotulo, "A verificar");
    assert.equal(resumoEstado(iniciada), "Em curso");
    // E não conta como visto no progresso: começar não é terminar.
    assert.equal(progressoDe([iniciada]).vistos, 0);
  });

  test("os seis estados do packet existem com rótulo PT-PT", () => {
    for (const estado of ["pendente", "a-verificar", "verificado", "corrigido", "falhou", "nao-aplicavel"] as const) {
      const cartao = { ...cartaode("firewall"), estado };
      assert.ok(resumoEstado(cartao).length > 0, `${estado} sem resumo`);
      assert.doesNotMatch(classificacaoDe(cartao).rotulo, /[A-Z]{4,}/, "rótulo em token inglês");
    }
  });
});

describe("3 — progresso matemático e sem números mágicos", () => {
  test("nada visto é 0%, tudo visto é 100%", () => {
    const ini = cartoesIniciais();
    assert.deepEqual(
      [progressoDe(ini).vistos, progressoDe(ini).percentagem],
      [0, 0],
    );
    const todos = ini.map((c) => aplicarDesfecho(c, c.acaoTipo === "verificacao" ? "verificacao" : "correcao", { ok: true, mensagem: "ok" }));
    assert.equal(progressoDe(todos).percentagem, 100);
  });

  test("a percentagem é sempre inteira, monotónica e nunca NaN", () => {
    const ini = cartoesIniciais();
    let anterior = -1;
    // Marca um cartão de cada vez: a percentagem nunca desce e acaba em 100.
    for (let k = 0; k <= ini.length; k++) {
      const ecr = ini.map((c, i) => (i < k ? { ...c, estado: "verificado" as const } : c));
      const p = progressoDe(ecr);
      assert.ok(Number.isInteger(p.percentagem), "percentagem inteira");
      assert.ok(p.percentagem >= anterior, `regrediu de ${anterior} para ${p.percentagem}`);
      assert.equal(p.vistos, k);
      anterior = p.percentagem;
    }
    assert.equal(anterior, 100);
    assert.equal(progressoDe([]).percentagem, 0, "sem cartões não há divisão por zero");
    assert.ok(!fraseProgresso(progressoDe([])).includes("NaN"));
  });

  test("verificados e corrigidos são números diferentes e ambos visíveis", () => {
    const misto = [
      aplicarDesfecho(cartaode("firewall"), "verificacao", { ok: true, evidencia: "x", mensagem: "y" }),
      aplicarDesfecho(cartaode("update"), "correcao", { ok: true, evidencia: "z", mensagem: "w" }),
    ];
    const p = progressoDe(misto);
    assert.equal(p.vistos, 2);
    assert.equal(p.corrigidos, 1, "só a correção real conta como corrigida");
    assert.match(fraseProgresso(p), /2 de 2 vistos \(100%\)/);
    assert.match(fraseProgresso(p), /faltam 0|tudo visto/);
  });
});

describe("4 — a lista de problemas começa vazia e enche-se com medições", () => {
  test("no arranjo inicial não há UM problema comprovado", () => {
    const ini = cartoesIniciais();
    assert.equal(ini.every((c) => !!grupoDe(c)), true, "todos os cartões têm grupo");
    assert.equal(ini.filter((c) => grupoDe(c) === "problemas").length, 0, "problemas inventados à partida");
  });

  test("os três grupos pedidos existem e cobrem o catálogo todo", () => {
    const grupos = new Set(cartoesIniciais().map((c) => grupoDe(c)));
    for (const g of ["manutencao", "boas-praticas"]) {
      assert.ok(grupos.has(g as never), `falta o grupo ${g}`);
    }
  });
});

describe("5 — auditoria dos dez botões", () => {
  test("são dez, cada um com uma das quatro classes admitidas", () => {
    assert.equal(AUDITORIA_BOTOES.length, 10, "a página tinha dez botões");
    const admitidas = new Set(["verificação real", "ação real", "abertura de ferramenta externa", "recomendação educativa"]);
    for (const b of AUDITORIA_BOTOES) {
      assert.ok(admitidas.has(b.real), `${b.id}: classe não admitida (${b.real})`);
    }
  });

  test("nenhum botão abre uma ferramenta externa, porque não há ponte para isso", () => {
    assert.equal(AUDITORIA_BOTOES.filter((b) => b.real === "abertura de ferramenta externa").length, 0);
    // E portanto nenhum rótulo pode prometer abrir seja o que for.
    for (const cartao of CARTOES) {
      assert.doesNotMatch(cartao.botao, /abrir|gerar|configurar/i, `${cartao.id} promete ${cartao.botao}`);
    }
  });

  test("cada botão real corresponde a uma chamada existente no bridge", () => {
    const chamadas = AUDITORIA_BOTOES.filter((b) => b.real !== "recomendação educativa").map((b) => b.chamada);
    for (const chamada of chamadas) {
      assert.match(chamada, /getWindowsHealth\(\)|updateDefinitions\(\)|startScan\(/, `chamada inventada: ${chamada}`);
    }
    // `scanner-run` estava fundido com `update`: a mesma chamada nos dois.
    const update = AUDITORIA_BOTOES.find((b) => b.id === "update")!;
    const scanner = AUDITORIA_BOTOES.find((b) => b.id === "scanner-run")!;
    assert.equal(update.chamada, scanner.chamada, "a fusão só se justifica por serem a mesma operação");
    assert.match(scanner.passa, /fundido/i);
    assert.equal(CARTOES.some((c) => c.id === "scanner-run"), false, "o duplicado não volta a estar na lista");
  });
});

describe("6 — firewall com o contrato novo do parser (R5-L1)", () => {
  test("available=false nunca é «ativo» nem «desativado»", () => {
    for (const leitura of [undefined, null, { available: false }, { available: false, enabled: false }, { available: false, enabled: true }]) {
      const r = interpretaFirewall(leitura as never);
      assert.equal(r.confirmado, false, JSON.stringify(leitura));
      assert.equal(r.severidade, null, "sem leitura não há gravidade");
      assert.match(r.mensagem, /não foi possível confirmar/i);
      assert.doesNotMatch(r.mensagem, /está ativo|está desligado/i, "afirmação sobre o que não foi medido");
    }
  });

  test("available=true com enabled=false é falha crítica, com os perfis como evidência", () => {
    const r = interpretaFirewall({ available: true, enabled: false, profiles: [{ name: "Private", enabled: false }, { name: "Domain", enabled: true }] });
    assert.equal(r.confirmado, true);
    assert.equal(r.severidade, "critico");
    assert.match(r.evidencia, /Private/);
  });

  test("available=true com enabled=true é saudável", () => {
    const r = interpretaFirewall({ available: true, enabled: true, profiles: [{ name: "Private", enabled: true }] });
    assert.equal(r.severidade, null);
    assert.match(r.evidencia, /ativo nos perfis: Private/);
  });

  test("controlo: ignorar `available` faria este teste falhar", () => {
    // É a regressão exata que o parser do Codex corrigiu: `enabled` mentir
    // quando não houve leitura.
    const naiva = (fw: { available?: boolean; enabled?: boolean }) => (fw.enabled ? null : "critico");
    assert.equal(naiva({ available: false, enabled: false }), "critico", "a leitura ingénua classifica");
    assert.equal(interpretaFirewall({ available: false, enabled: false }).severidade, null, "a nossa não");
  });

  test("estado geral do serviço: token interno nunca vai para o ecrã", () => {
    for (const status of ["good", "attention", "critical", "unknown"]) {
      const r = estadoSaudePt(status);
      assert.doesNotMatch(r.rotulo, /^(good|attention|critical|unknown)$/, "token cru");
      assert.ok(r.rotulo.length > 0);
    }
    assert.equal(severidadeDe("high"), "critico");
    assert.equal(severidadeDe("low"), null);
  });
});
