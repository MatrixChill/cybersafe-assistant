import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { WindowsFirewallState } from "@cybersafe/shared-types";
import {
  copyEstadoLeituraFirewall,
  criarLeitorFirewall,
} from "../src/lib/firewallReadState";

/**
 * SESSION14-P0 — o ciclo de vida real da leitura do Windows Firewall.
 *
 * O defeito humano: abrir os detalhes mostrava «NÃO VERIFICADO» e, um momento
 * depois, «ATIVO». Não era o estado a mudar — era a UI não ter lifecycle:
 * cada abertura partia de `null`, repedia, e a primeira pintura era a ausência
 * enquanto a resposta vinha a caminho. Estas testes provam o ciclo COM
 * promises adiadas de verdade: pedido, in-flight, resposta, resposta tardia,
 * erro, e o caso em que a janela não tem bridge.
 *
 * Nada aqui escreve no Windows: o leitor só chama o `obterEstado` injetado.
 */

function adiada<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promessa = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promessa, resolve, reject };
}

const leituraAtiva: WindowsFirewallState = {
  available: true,
  enabled: true,
  profiles: [
    { name: "Domain", enabled: true },
    { name: "Private", enabled: true },
    { name: "Public", enabled: true },
  ],
};

const leituraDesligada: WindowsFirewallState = {
  available: true,
  enabled: false,
  profiles: [
    { name: "Domain", enabled: false },
    { name: "Private", enabled: false },
    { name: "Public", enabled: false },
  ],
};

/** Uma volta de event loop: resolve todas as cadeias `.then` do leitor. */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

describe("SESSION14 — ciclo de vida da leitura do firewall", () => {
  test("sem qualquer pedido: não-consultado, nunca «desligado»", () => {
    const copy = copyEstadoLeituraFirewall(null);
    assert.equal(copy.status, "desconhecido");
    assert.equal(copy.texto, "Não verificado");
    assert.doesNotMatch(copy.texto + copy.detalhe, /desligad|desativad/i);
  });

  test("abrir marca o pedido em voo ANTES de qualquer resposta (sem flicker p/ «Não verificado»)", async () => {
    const d = adiada<unknown>();
    const vistos: string[] = [];
    const leitor = criarLeitorFirewall({
      obterEstado: () => d.promessa,
      aoEstado: (e) => vistos.push(copyEstadoLeituraFirewall(e).texto),
    });
    leitor.garantirLeitura();
    assert.equal(leitor.estado()?.fase, "a_consultar");
    assert.equal(vistos[0], "A verificar…", "o primeiro estado emitido não é «Não verificado»");

    // reabrir enquanto há pedido em voo: NUNCA é um segundo pedido
    let chamadas = 0;
    const leitor2d = adiada<unknown>();
    const leitorComContagem = criarLeitorFirewall({
      obterEstado: () => {
        chamadas += 1;
        return leitor2d.promessa;
      },
      aoEstado: () => {},
    });
    leitorComContagem.garantirLeitura();
    leitorComContagem.garantirLeitura(); // reopen, ainda no mesmo tick
    await flush(); // o pedido parte de um microtask; a contagem é depois dele
    assert.equal(chamadas, 1, "reopen durante in-flight disparou um segundo pedido");

    leitor2d.resolve({ firewall: leituraAtiva });
    d.resolve({ firewall: leituraAtiva });
    await Promise.all([d.promessa, leitor2d.promessa]);
    await flush();
    assert.equal(leitor.estado()?.fase, "lido");
    assert.equal(copyEstadoLeituraFirewall(leitor.estado()).texto, "ATIVO");
  });

  test("reabertura REVALIDA: um pedido novo, coalescido se já houver in-flight, sem regressão visual", async () => {
    const pedidos: Array<{ promessa: Promise<unknown>; resolve: (v: unknown) => void }> = [];
    const leitor = criarLeitorFirewall({
      obterEstado: () => {
        const d = adiada<unknown>();
        pedidos.push(d);
        return d.promessa;
      },
      aoEstado: () => {},
    });
    leitor.garantirLeitura();
    await Promise.resolve(); // deixa partir o microtask do pedido
    assert.equal(pedidos.length, 1);
    // reaberturas enquanto o mesmo pedido está em voo: coalescem, não somam
    leitor.garantirLeitura();
    leitor.garantirLeitura();
    assert.equal(pedidos.length, 1, "reopen durante in-flight disparou segundo pedido");
    pedidos[0].resolve({ firewall: leituraAtiva });
    await flush();
    assert.equal(copyEstadoLeituraFirewall(leitor.estado()).texto, "ATIVO");
    // abrir de novo, com o pedido anterior já resolvido: revalida
    leitor.garantirLeitura();
    await Promise.resolve();
    assert.equal(pedidos.length, 2, "reabertura após leitura confirmada não revalidou");
    // durante a renovação (2.º pedido ainda em voo) a leitura anterior
    // continua VISÍVEL, explícita como última leitura, não como presente
    const durante = copyEstadoLeituraFirewall(leitor.estado());
    assert.equal(durante.texto, "ATIVO");
    assert.equal(durante.status, "active");
    assert.match(durante.detalhe, /última leitura conhecida, a atualizar/);
    assert.doesNotMatch(durante.detalhe, /não o estado atual confirmado/, "em renovação ainda não há afirmação do presente");
    // e a renovação não pode regredir para «Não verificado» a meio
    assert.notEqual(durante.texto, "Não verificado");
    pedidos[1].resolve({ firewall: leituraDesligada });
    await flush();
    assert.equal(copyEstadoLeituraFirewall(leitor.estado()).texto, "DESATIVADO");
  });

  test("falha a renovar conserva a última leitura com erro ACTUAL explícito — nunca ATIVO liso", async () => {
    const d2 = adiada<unknown>();
    let n = 0;
    const leitorR = criarLeitorFirewall({
      obterEstado: () => {
        n += 1;
        return n === 1 ? Promise.resolve({ firewall: leituraAtiva }) : d2.promessa;
      },
      aoEstado: () => {},
    });
    leitorR.garantirLeitura();
    await flush();
    assert.equal(leitorR.estado()?.fase, "lido");
    leitorR.garantirLeitura(); // renovação
    d2.reject(new Error("pipe closed"));
    await flush();
    assert.equal(leitorR.estado()?.fase, "erro");
    assert.equal(leitorR.estado()?.leitura?.enabled, true, "a falha apagou a última leitura real");
    const copy = copyEstadoLeituraFirewall(leitorR.estado());
    assert.equal(copy.texto, "ATIVO");
    assert.match(copy.detalhe, /a tentativa de atualização não respondeu/);
    assert.match(copy.detalhe, /não o estado atual confirmado/);
  });

  test("envelope ilegível na renovação também conserva a leitura anterior com ressalva", async () => {
    let n = 0;
    const leitor = criarLeitorFirewall({
      obterEstado: async () => {
        n += 1;
        return n === 1 ? { firewall: leituraAtiva } : { firewall: { available: true } };
      },
      aoEstado: () => {},
    });
    leitor.garantirLeitura();
    await flush();
    leitor.garantirLeitura();
    await flush();
    assert.equal(leitor.estado()?.fase, "erro");
    assert.equal(leitor.estado()?.motivo, "resposta_ilegivel");
    assert.equal(leitor.estado()?.leitura?.enabled, true, "resposta ilegível deitou fora a leitura boa");
    const copy = copyEstadoLeituraFirewall(leitor.estado());
    assert.match(copy.detalhe, /envelope que a app não sabe ler/);
    assert.match(copy.detalhe, /última conhecida/);
  });

  test("resposta tardia depois de fechar continua a valer (a vista não ficou cega)", async () => {
    const d = adiada<unknown>();
    const emitidos: string[] = [];
    const leitor = criarLeitorFirewall({
      obterEstado: () => d.promessa,
      aoEstado: (e) => emitidos.push(e.fase),
    });
    leitor.garantirLeitura();
    d.resolve({ firewall: leituraDesligada });
    await flush();
    assert.equal(leitor.estado()?.fase, "lido");
    assert.equal(copyEstadoLeituraFirewall(leitor.estado()).texto, "DESATIVADO");
    assert.equal(copyEstadoLeituraFirewall(leitor.estado()).status, "inactive");
  });

  test("desmontar corta a escrita, não a verdade: resposta após desmontar não pinta", async () => {
    const d = adiada<unknown>();
    let escritas = 0;
    const leitor = criarLeitorFirewall({
      obterEstado: () => d.promessa,
      aoEstado: () => {
        escritas += 1;
      },
    });
    leitor.garantirLeitura();
    const antes = escritas;
    leitor.desmontar();
    d.resolve({ firewall: leituraAtiva });
    await flush();
    assert.equal(escritas, antes, "houve escrita depois de desmontar");
  });

  test("falha sem leitura anterior: «Não verificado» com frase de falha, nunca «desligado»", async () => {
    const leitor = criarLeitorFirewall({
      obterEstado: async () => {
        throw new Error("pipe closed");
      },
      aoEstado: () => {},
    });
    leitor.garantirLeitura();
    await flush();
    assert.equal(leitor.estado()?.fase, "erro");
    const copy = copyEstadoLeituraFirewall(leitor.estado());
    assert.equal(copy.texto, "Não foi possível verificar");
    assert.match(copy.detalhe, /Não foi possível verificar o estado/);
    assert.doesNotMatch(copy.texto + copy.detalhe, /desativado/i);
  });

  test("resposta sem firewall reconhecível é «resposta ilegível», nunca presença pintada", async () => {
    const leitor = criarLeitorFirewall({
      obterEstado: async () => ({ firewall: { available: true } }),
      aoEstado: () => {},
    });
    leitor.garantirLeitura();
    await flush();
    assert.equal(leitor.estado()?.fase, "erro");
    assert.equal(leitor.estado()?.motivo, "resposta_ilegivel");
    const copy = copyEstadoLeituraFirewall(leitor.estado());
    assert.equal(copy.status, "desconhecido");
    assert.match(copy.detalhe, /sem um estado reconhecível/);
  });

  test("janela sem bridge: frase própria de ausência de ponte, não falha de consulta", () => {
    const leitor = criarLeitorFirewall({ obterEstado: null, aoEstado: () => {} });
    leitor.garantirLeitura();
    assert.equal(leitor.estado()?.fase, "erro");
    assert.equal(leitor.estado()?.motivo, "sem_bridge");
    const copy = copyEstadoLeituraFirewall(leitor.estado());
    assert.equal(copy.texto, "Não verificado");
    assert.match(copy.detalhe, /não tem acesso/);
  });

  test("ciclo StrictMode (setup→cleanup→setup na MESMA instância): desmontar não é morte permanente", async () => {
    const d1 = adiada<unknown>();
    const d2 = adiada<unknown>();
    const fila = [d1.promessa, d2.promessa];
    let n = 0;
    const escritas: string[] = [];
    const leitor = criarLeitorFirewall({
      obterEstado: () => fila[n++],
      aoEstado: (e) => escritas.push(e.fase),
    });
    leitor.garantirLeitura(); // setup 1
    leitor.desmontar(); // cleanup
    leitor.reativar(); // setup 2 — o ref é o mesmo, o leitor tem de reviver
    const antes = escritas.length;
    d1.resolve({ firewall: leituraAtiva }); // resposta da montagem anterior
    await flush();
    assert.equal(escritas.length, antes, "a resposta da geração morta escreveu depois do reativar");
    leitor.garantirLeitura(); // a vista voltou a abrir
    d2.resolve({ firewall: leituraDesligada });
    await flush();
    assert.equal(leitor.estado()?.fase, "lido", "reativar deixou o leitor para sempre mudo ou preso em emVoo");
    assert.equal(copyEstadoLeituraFirewall(leitor.estado()).texto, "DESATIVADO");
  });

  test("nenhum texto do leitor inventa estado do Windows", () => {
    const casos = [
      null,
      { fase: "a_consultar", leitura: null, motivo: null },
      { fase: "erro", leitura: null, motivo: "falha_consulta" },
      { fase: "erro", leitura: null, motivo: "sem_bridge" },
      { fase: "erro", leitura: null, motivo: "resposta_ilegivel" },
    ] as const;
    for (const c of casos) {
      const copy = copyEstadoLeituraFirewall(c);
      const texto = (copy.texto + " " + copy.detalhe).toLowerCase();
      assert.equal(texto.includes("desativado"), false, `ramo ${JSON.stringify(c)} afirma desligado sem leitura`);
    }
  });
});
