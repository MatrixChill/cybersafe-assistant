import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  cartoesIniciais,
  elegivelParaVerificacaoRapida,
  LINHAS_SO_WINDOWS,
  linhasDaPlataforma,
  notaDaPlataforma,
  progressoDe,
  faseProgresso,
  type OptimizeCartao,
} from "../src/lib/optimizeModel";
import {
  camadaDeRedeLinux,
  plataformaPublicada,
  protecaoLinux,
} from "../src/lib/platformTruth";

/**
 * Linux Lite — estados e textos pela plataforma PUBLICADA.
 *
 * Os defeitos que isto trava foram medidos no pacote `.deb` (sha256
 * 7846b356…): a página Otimizar mostrava «Firewall do Windows» e «Saúde geral
 * do Windows» numa máquina onde nenhuma dessas leituras existe, e o botão
 * chamava `getWindowsHealth()` na mesma; o Monitor chamava «Camada de Contenção
 * de Rede» a uma lista de ligações observadas; e o onboarding prometia
 * «Proteção em tempo real» onde o mecanismo é uma consulta periódica. É a mesma
 * classe de «Análise em Tempo Real» que já foi renomeada: um título que promete
 * o que o motor não faz.
 *
 * Nada aqui é preferência estética e nada muda o Windows: a régua é
 * `hardware.system.platform` publicado pelo serviço — o mesmo ponto que
 * `diskDisplay.ts` usa para decidir o que se pode analisar — e sem publicação
 * nada é reescrito.
 */

const todos = cartoesIniciais();

describe("LP-20261102 — a plataforma vem do serviço, não de um palpite", () => {
  test("as formas publicadas pelo systeminformation são reconhecidas", () => {
    assert.equal(plataformaPublicada("Windows"), "windows");
    assert.equal(plataformaPublicada("linux"), "linux");
    assert.equal(plataformaPublicada("  Linux "), "linux");
  });

  test("sem publicação, ou com outra plataforma, não se adivinha", () => {
    for (const valor of [undefined, null, "", "darwin", "freebsd"]) {
      assert.notEqual(plataformaPublicada(valor as string | null | undefined), "linux", String(valor));
    }
    assert.equal(plataformaPublicada("darwin"), "desconhecida");
  });
});

describe("LP-20261102 — o Windows recebe de volta exatamente o que tinha", () => {
  test("em Windows as dez linhas ficam intactas", () => {
    assert.deepEqual(linhasDaPlataforma(todos, "Windows"), todos);
  });

  test("sem leitura de plataforma nada é escondido nem afirmado", () => {
    assert.deepEqual(linhasDaPlataforma(todos, undefined), todos);
    assert.deepEqual(linhasDaPlataforma(todos, null), todos);
  });

  test("a função não toca no catálogo de origem", () => {
    linhasDaPlataforma(todos, "linux");
    assert.deepEqual(todos, cartoesIniciais());
  });

  test("as reescritas de frase ficam caladas fora do Linux", () => {
    for (const plataforma of ["Windows", undefined, null, "darwin"]) {
      assert.equal(camadaDeRedeLinux(plataforma as string | null | undefined), null);
      assert.equal(protecaoLinux(plataforma as string | null | undefined), null);
      assert.equal(notaDaPlataforma(plataforma as string | null | undefined), null);
    }
  });
});

describe("LP-20261102 — em Linux não se oferece uma funcionalidade do Windows", () => {
  const linux = linhasDaPlataforma(todos, "linux");

  test("as duas linhas cuja fonte é o Windows caem", () => {
    for (const cartao of linux) {
      assert.ok(!LINHAS_SO_WINDOWS.has(cartao.id), `sobreviveu ${cartao.id}`);
    }
    assert.equal(linux.length, todos.length - 2);
  });

  test("o trabalho que tem leitura real fica", () => {
    const ids = linux.map((c) => c.id);
    for (const esperado of ["disco", "update", "analise-profunda"]) {
      assert.ok(ids.includes(esperado), `faltou ${esperado}`);
    }
  });

  test("nenhuma linha escreve «Windows» em Linux", () => {
    for (const cartao of linux) {
      const texto = [cartao.titulo, cartao.motivo, cartao.botao, cartao.instrucao ?? "", cartao.confirmar ?? ""]
        .join(" · ");
      assert.ok(!/windows/i.test(texto), `${cartao.id}: ${texto}`);
    }
  });

  test("a medição já feita sobrevive à projeção", () => {
    const medidos: OptimizeCartao[] = todos.map((c) =>
      c.id === "disco"
        ? { ...c, estado: "verificado", resultado: "sem-problema", evidencia: "123 GB livres · lido às 20:31" }
        : c,
    );
    const obtido = linhasDaPlataforma(medidos, "linux").find((c) => c.id === "disco");
    assert.equal(obtido?.estado, "verificado");
    assert.equal(obtido?.evidencia, "123 GB livres · lido às 20:31");
  });

  test("o progresso não conta o que não existe: abre em «Por começar»", () => {
    const p = progressoDe(linux);
    assert.equal(p.total, 8);
    assert.equal(p.vistos, 0);
    assert.equal(p.percentagem, 0);
    assert.equal(faseProgresso(p), "Por começar");
  });

  test("«Verificar tudo agora» fica só com o que há para medir em Linux", () => {
    const alvo = linux.filter(elegivelParaVerificacaoRapida);
    for (const cartao of alvo) {
      assert.ok(!LINHAS_SO_WINDOWS.has(cartao.id), `${cartao.id} não tem leitura aqui`);
    }
    // As duas verificações que caíram eram metade desta secção: fica o disco, e
    // o botão diz «1» em vez de prometer quatro leituras que não aconteceriam.
    assert.deepEqual(alvo.map((c) => c.id), ["disco"]);
  });
});

describe("LP-20261102 — as frases que nomeiam mecanismos dizem a verdade em Linux", () => {
  test("a firewall que não é lida declara-se, sem dizer «desligada»", () => {
    const nota = notaDaPlataforma("linux") ?? "";
    for (const nome of ["UFW", "firewalld", "nftables"]) {
      assert.ok(nota.includes(nome), `faltou ${nome}`);
    }
    assert.match(nota, /ausência de leitura não é firewall desligada/);
  });

  test("o bloco de rede passa a dizer o que é: observação", () => {
    const rede = camadaDeRedeLinux("linux");
    assert.ok(rede);
    assert.match(rede.titulo, /observad/i);
    assert.ok(!/contenção/i.test(rede.titulo), "sem contenção não se chama contenção");
    assert.match(rede.nota, /não bloqueia ligações/);
  });

  test("o onboarding troca «tempo real» pelo mecanismo que existe", () => {
    const passo = protecaoLinux("linux");
    assert.ok(passo);
    assert.ok(!/tempo real/i.test(passo.title), "não se promete tempo real sem mecanismo");
    assert.match(passo.title, /segundo plano/i);
    assert.ok(!/vigia/i.test(passo.description));
    assert.match(passo.description, /não bloqueia ficheiros nem ligações/i);
  });
});
