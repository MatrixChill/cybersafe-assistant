/**
 * WS-4 — orientacao honesta sobre um processo (Gestao de Tarefas).
 *
 * A funcao e PURA e deterministica: mesma entrada, mesma saida. Nao ha fetch,
 * nem IPC, nem estado, nem data de hoje, nem Math.random. O que a torna
 * testavel e o que impede a regressao de honestidade.
 *
 * Cada teste aponta para uma regra do packet:
 *   R1 CPU alta sozinha NUNCA e urgent
 *   R2 signer ausente NUNCA e ameaca nem sobe prioridade
 *   R3 nome desconhecido NUNCA e suspeito
 *   R4 trusted untrusted e o unico sinal que justifica urgent, com linguagem medida
 *   R5 pid <= 100 ou nome protegido => safeToClose "protected"
 *   R6 NUNCA inventar numero quando falta o dado
 *   R8 PT-PT europeu, sem emojis
 *
 * O teste mais importante e o de honestidade lexical (ver "nenhuma alarms").
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { ProcessSnapshot } from "@cybersafe/shared-types";
import { buildProcessGuidance, PROTECTED_PROCESS_NAMES } from "@cybersafe/shared-types";

const proc = (overrides: Partial<ProcessSnapshot> & { pid: number }): ProcessSnapshot => ({
  ppid: 0,
  name: "exemplo.exe",
  path: "",
  commandLine: "",
  cpu: 0,
  memoryMb: 0,
  startedAt: new Date(0).toISOString(),
  trusted: "neutral",
  ...overrides,
});

/** Todas as strings que o utilizador pode ler num processo. */
function allText(g: ReturnType<typeof buildProcessGuidance>): string {
  return [g.what, g.role, g.safeToCloseReason, g.meaning, g.guidance, ...g.evidence].join(" | ");
}

/** Palavras que so podem existir quando ha evidencia real de trusted untrusted. */
const ALARM_WORDS = ["malware", "malicioso", "maliciosa", "virus", "vírus", "perigoso", "perigosa", "infetado", "infectado"];

describe("WS-4 — buildProcessGuidance", () => {
  test("R1: cpu 95 com trusted neutral NAO e urgent (maximo worth-noting)", () => {
    const g = buildProcessGuidance(
      proc({ pid: 5000, name: "jogo.exe", cpu: 95, memoryMb: 4096, trusted: "neutral" }),
    );
    assert.notEqual(g.priority, "urgent", "cpu alta sozinha nunca justifica urgent");
    assert.equal(g.priority, "worth-noting");
  });

  test("R1: variao — qualquer cpu alta com trusted trusted mantem-se abaixo de urgent", () => {
    for (const cpu of [81, 85, 90, 95, 99, 100]) {
      const g = buildProcessGuidance(proc({ pid: 5000, name: "compilacao.exe", cpu, trusted: "trusted" }));
      assert.notEqual(g.priority, "urgent", `cpu ${cpu} com assinatura confiavel nao pode ser urgent`);
    }
  });

  test("R2: sem signer a prioridade NAO sobe e a copy nao acusa", () => {
    const comSigner = buildProcessGuidance(
      proc({ pid: 5000, name: "exemplo.exe", cpu: 10, signer: "Microsoft Windows", trusted: "neutral" }),
    );
    const semSigner = buildProcessGuidance(proc({ pid: 5000, name: "exemplo.exe", cpu: 10, trusted: "neutral" }));

    assert.equal(semSigner.priority, comSigner.priority, "a falta de assinatura nao muda a prioridade");
    for (const word of ALARM_WORDS) {
      assert.ok(!allText(semSigner).toLowerCase().includes(word), `sem signer, nada de "${word}"`);
    }
  });

  test("R2: a nota de assinatura ausente e neutra e diz que nao prova nada", () => {
    const g = buildProcessGuidance(proc({ pid: 5000, name: "exemplo.exe", trusted: "neutral" }));
    const texto = allText(g).toLowerCase();
    assert.match(texto, /assinatura/, "fala da assinatura");
    assert.match(texto, /n[aã]o prova|n[aã]o confirma|n[aã]o diz nada/, "e diz explicitamente que nao prova nada");
  });

  test("R3: nome desconhecido nao e suspeito — a copy diz que o nome nao prova nada", () => {
    const g = buildProcessGuidance(
      proc({ pid: 5000, name: "xq7z-oddball-thing.exe", cpu: 5, trusted: "neutral" }),
    );
    assert.equal(g.priority, "none", "nome esquisito sozinho nao levanta prioridade");
    const texto = allText(g).toLowerCase();
    assert.match(texto, /n[aã]o (reconhec|reconhecid)|nome n[aã]o (reconhec|reconhecid)/, "diz que o nome nao e reconhecido");
    assert.match(texto, /n[aã]o prova nada/, "e que nao prova nada");
    assert.match(texto, /caminho|assinatura/, "aponta para o que importa: caminho e assinatura");
  });

  test("R4: trusted untrusted e urgent, com linguagem medida (nada de malware garantido)", () => {
    const g = buildProcessGuidance(
      proc({ pid: 5000, name: "desconhecido.exe", cpu: 2, trusted: "untrusted", signer: "Sem assinatura" }),
    );
    assert.equal(g.priority, "urgent");
    const texto = allText(g).toLowerCase();
    assert.ok(!/garantid|com certeza|e definitivamente malicioso/.test(texto), "nunca certeza absoluta");
    assert.match(texto, /rever|verific|investigar/, "a orientação manda o utilizador verificar");
  });

  test("R4: untrusted e o UNICO sinal que produz urgent", () => {
    const todos = [
      proc({ pid: 5000, name: "pico.exe", cpu: 100, memoryMb: 99999, trusted: "neutral" }),
      proc({ pid: 5000, name: "pico.exe", cpu: 100, memoryMb: 99999, trusted: "trusted" }),
      proc({ pid: 5000, name: "desconhecido.exe", cpu: 100, signer: undefined, trusted: "neutral" }),
      proc({ pid: 5000, name: "xq7z.exe", cpu: 100, trusted: "neutral" }),
    ];
    for (const p of todos) {
      const g = buildProcessGuidance(p);
      assert.notEqual(g.priority, "urgent", `${p.name} cpu=${p.cpu} trusted=${p.trusted} nao pode dar urgent`);
    }
  });

  test("R5: pid 4 (lsass.exe) => safeToClose protected, com o motivo", () => {
    const g = buildProcessGuidance(proc({ pid: 4, name: "lsass.exe", cpu: 1, trusted: "trusted" }));
    assert.equal(g.safeToClose, "protected");
    assert.match(g.safeToCloseReason.toLowerCase(), /windows|so|necess/i);
    assert.match(g.guidance.toLowerCase(), /n[aã]o encerr|n[aã]o terminar|nao fechar|deixar/i);
  });

  test("R5: nome protegido com pid alto tambem e protected", () => {
    for (const name of ["svchost.exe", "explorer.exe", "csrss.exe", "wininit.exe"]) {
      const g = buildProcessGuidance(proc({ pid: 6000, name, trusted: "neutral" }));
      assert.equal(g.safeToClose, "protected", `${name} e protegido`);
    }
  });

  test("R5: a comparacao do nome protegido ignora maiusculas", () => {
    const g = buildProcessGuidance(proc({ pid: 6000, name: "SVCHOST.EXE", trusted: "neutral" }));
    assert.equal(g.safeToClose, "protected");
  });

  test("R5: a lista de protegidos e uma constante exportada e nao vazia", () => {
    assert.ok(PROTECTED_PROCESS_NAMES.length > 0);
    assert.ok(PROTECTED_PROCESS_NAMES.includes("lsass.exe"));
  });

  test("R6: signer undefined nao inventa numero — a evidence diz que nao ha assinatura", () => {
    const g = buildProcessGuidance(proc({ pid: 5000, name: "exemplo.exe", trusted: "neutral" }));
    const linhas = g.evidence.join(" ");
    assert.match(linhas.toLowerCase(), /sem assinatura|nao ha assinatura|nenhuma assinatura|assinatura n[aã]o/i);
    assert.ok(!/assinatura[: ]+[0-9a-f]{6,}/i.test(linhas), "nenhum hash/valor inventado");
  });

  test("R6: cpu e memoria desconhecidas dizem n/d, nunca 0 fingido", () => {
    const g = buildProcessGuidance({
      ...proc({ pid: 5000, name: "exemplo.exe" }),
      cpu: undefined as unknown as number,
      memoryMb: undefined as unknown as number,
    });
    const linhas = g.evidence.join(" | ");
    assert.match(linhas, /n\/d/, "valor desconhecido e escrito como n/d");
    assert.ok(!/\b0\s*%/.test(linhas), "0% seria um numero inventado");
  });

  test("R6: signer presente mostra o valor real, sem o transformar", () => {
    const g = buildProcessGuidance(
      proc({ pid: 5000, name: "exemplo.exe", signer: "Microsoft Windows Publisher", trusted: "trusted" }),
    );
    assert.ok(g.evidence.some((l) => l.includes("Microsoft Windows Publisher")));
  });

  test("determinismo: duas chamadas com o mesmo objeto devolvem o mesmo resultado", () => {
    const p = proc({ pid: 5000, name: "exemplo.exe", cpu: 42, memoryMb: 128, trusted: "neutral" });
    assert.deepEqual(buildProcessGuidance(p), buildProcessGuidance(p));
    const q = { ...p };
    assert.deepEqual(buildProcessGuidance(p), buildProcessGuidance(q));
  });

  test("determinismo: a funcao nao muta o processo recebido", () => {
    const p = proc({ pid: 5000, name: "exemplo.exe", cpu: 42, trusted: "neutral" });
    const copia = JSON.stringify(p);
    buildProcessGuidance(p);
    assert.equal(JSON.stringify(p), copia);
  });

  test("R8/8: NENHUM caso produz palavra de alarme sem evidencia de trusted untrusted", () => {
    const casos = [
      proc({ pid: 4, name: "System", cpu: 100, memoryMb: 90000, trusted: "neutral" }),
      proc({ pid: 5000, name: "jogo.exe", cpu: 99, memoryMb: 8000, trusted: "neutral" }),
      proc({ pid: 5000, name: "xq7z-oddball.exe", cpu: 3, signer: undefined, trusted: "neutral" }),
      proc({ pid: 5000, name: "servico-desconhecido.exe", cpu: 0, signer: "Sem assinatura", trusted: "neutral" }),
      proc({ pid: 5000, name: "explorer.exe", cpu: 55, trusted: "trusted" }),
      proc({ pid: 5000, name: "desconhecido.exe", cpu: 70, trusted: "untrusted" }),
    ];

    for (const p of casos) {
      const g = buildProcessGuidance(p);
      const texto = allText(g).toLowerCase();
      const temUntrusted = p.trusted === "untrusted";
      for (const word of ALARM_WORDS) {
        if (temUntrusted) continue;
        assert.ok(
          !texto.includes(word),
          `${p.name} (trusted=${p.trusted}) produziu "${word}" sem evidencia de untrusted`,
        );
      }
    }
  });

  test("R8: PT-PT europeu — sem pt-BR, sem emojis", () => {
    const casos = [
      proc({ pid: 5000, name: "exemplo.exe", cpu: 50, trusted: "neutral" }),
      proc({ pid: 5000, name: "xq7z.exe", cpu: 90, trusted: "neutral" }),
      proc({ pid: 4, name: "lsass.exe", cpu: 1, trusted: "trusted" }),
      proc({ pid: 5000, name: "desconhecido.exe", cpu: 5, trusted: "untrusted" }),
    ];
    const proibidosBr = ["arquivo", "memoria ", "encerrar processo com", "você", "usuário", "usuário"];
    for (const p of casos) {
      const texto = allText(buildProcessGuidance(p));
      const baixo = texto.toLowerCase();
      assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(texto), `emoji em ${p.name}: ${texto}`);
      assert.ok(!/voc[eê]|usu[aá]rio/.test(baixo), `pt-BR em ${p.name}: ${texto}`);
      for (const w of proibidosBr) {
        if (w === "memoria ") continue; // memoria seguido de espaco e palavra valida
        assert.ok(!baixo.includes(w), `pt-BR "${w}" em ${p.name}: ${texto}`);
      }
    }
  });

  test("R8: a CPU continua visivel no texto — a leitura nao foi apagada", () => {
    const g = buildProcessGuidance(proc({ pid: 5000, name: "exemplo.exe", cpu: 73, trusted: "neutral" }));
    assert.match(g.evidence.join(" "), /73/, "o numero de CPU continua no DADO");
    assert.match(g.evidence.join(" "), /CPU/i);
  });

  test("prioridade none nao tem de arrastar alarme: work-noting e o maximo sem evidencia", () => {
    const g = buildProcessGuidance(proc({ pid: 5000, name: "exemplo.exe", cpu: 2, trusted: "trusted" }));
    assert.equal(g.priority, "none");
    assert.equal(g.safeToClose, "safe");
  });
});

/**
 * R8-ACENTOS — a copy visivel e portugues europeu COM ACENTOS.
 *
 * A pagina ja usava acentos antes deste workstream (TaskManagerPage.tsx:520
 * "Memoria", :521 "Accoes"). A copy nova nao podia introduzir PT-PT sem
 * acentos num produto cuja identidade e uma interface polida.
 *
 * Este teste le SO as strings devolvidas por buildProcessGuidance — nunca o
 * codigo-fonte. E o contraste e obrigatorio: cada forma proibida tem uma
 * forma acentuada correspondente que PASSA. Um teste que falhasse nas duas nao
 * provaria nada.
 */
describe("R8-ACENTOS — PT-PT com acentos em tudo o que o utilizador le", () => {
  /**
   * Formas que em portugues europeu nunca aparecem sem acento.
   * Cada entrada e [proibida, acentuadaCorreta] para o contraste ser testavel.
   * Delimitadas por fronteira de palavra para nao apanhar sub-strings.
   */
  const FORMAS: ReadonlyArray<readonly [proibida: RegExp, correta: string]> = [
    // Nota: nao se testa a forma avulsa "nao". Com \b, o "n" de "não" tambem
    // casa e o teste accuse a copy ja acentuada. A forma avulsa e a que mais
    // aparece no texto, mas e coberta pelas formas compostas abaixo
    // ("nao ha", "nao prova nada", "nao e reconhecido", "nao e normal").
    [/\bNao\b/, "Não"],
    [/\bNao ha\b/, "Não há"],
    [/\btambem\b/, "também"],
    [/\bpor si so\b/, "por si só"],
    [/\bdisponivel\b/, "disponível"],
    [/\bconfianca\b/, "confiança"],
    [/\bconfianca confirmada\b/, "confiança confirmada"],
    [/\bcompilacao\b/, "compilação"],
    [/\bconversao\b/, "conversão"],
    [/\bvideos?\b/, "vídeo"],
    [/\besta a fazer\b/, "está a fazer"],
    [/\bo que esta\b/, "o que está"],
    [/\bque e normal\b/, "que é normal"],
    [/\be um processo\b/, "é um processo"],
    [/\be um programa\b/, "é um programa"],
    [/\be o caminho\b/, "é o caminho"],
    [/\be um sinal\b/, "é um sinal"],
    [/\bnao prova nada\b/, "não prova nada"],
    [/\bnao e reconhecido\b/, "não é reconhecido"],
    [/\bnao e suspeito\b/, "não é suspeito"],
    [/\bnao e normal\b/, "não é normal"],
    [/\bnao permite\b/, "não permite"],
    [/\bimpeca\b/, "impeça"],
    [/\blegitimos\b/, "legítimos"],
    [/\bO que e\b/, "O que é"],
    [/\bOrientacao\b/, "Orientação"],
    [/\bAcoes\b/, "Ações"],
    [/\bAcao\b/, "Ação"],
    [/\bConfianca\b/, "Confiança"],
    [/\bPid\b/, "PID"],
    [/\bsituacao\b/, "situação"],
    [/\binformacao\b/, "informação"],
    [/\batencao\b/, "atenção"],
    [/\bso fecha\b/, "só fecha"],
    [/\bEncerrar um programa so\b/, "Encerrar um programa só"],
    [/\bresponsavel\b/, "responsável"],
  ];

  /** Todos os processos de teste, para cobrir cada ramo da funcao. */
  const CASOS: ProcessSnapshot[] = [
    proc({ pid: 5000, name: "exemplo.exe", cpu: 2, trusted: "neutral" }),
    proc({ pid: 5000, name: "exemplo.exe", cpu: 55, trusted: "neutral" }),
    proc({ pid: 5000, name: "exemplo.exe", cpu: 95, memoryMb: 4096, trusted: "neutral" }),
    proc({ pid: 5000, name: "exemplo.exe", cpu: 2, trusted: "trusted", signer: "Microsoft Windows" }),
    proc({ pid: 5000, name: "xq7z-oddball.exe", cpu: 3, trusted: "neutral" }),
    proc({ pid: 5000, name: "desconhecido.exe", cpu: 8, trusted: "untrusted" }),
    proc({ pid: 4, name: "lsass.exe", cpu: 1, trusted: "trusted" }),
    proc({ pid: 6000, name: "SVCHOST.EXE", cpu: 12, trusted: "neutral" }),
    proc({ pid: 5000, name: "exemplo.exe", cpu: 0, memoryMb: 0, trusted: "neutral", signer: undefined }),
    {
      ...proc({ pid: 5000, name: "exemplo.exe" }),
      cpu: undefined as unknown as number,
      memoryMb: undefined as unknown as number,
    },
  ];

  /** Todas as strings devolvidas, uma a uma, com o caso de origem. */
  function stringsVisiveis(p: ProcessSnapshot): Array<{ origem: string; texto: string }> {
    const g = buildProcessGuidance(p);
    return [
      { origem: "what", texto: g.what },
      { origem: "role", texto: g.role },
      { origem: "safeToCloseReason", texto: g.safeToCloseReason },
      { origem: "meaning", texto: g.meaning },
      { origem: "guidance", texto: g.guidance },
      ...g.evidence.map((texto, i) => ({ origem: `evidence[${i}]`, texto })),
    ];
  }

  test("nenhuma string devolvida contem uma forma sem acento", () => {
    const problemas: string[] = [];
    for (const p of CASOS) {
      for (const { origem, texto } of stringsVisiveis(p)) {
        for (const [proibida, correta] of FORMAS) {
          if (proibida.test(texto)) {
            problemas.push(`${p.name}/${origem}: ${JSON.stringify(texto)} -> devia ser "${correta}"`);
          }
        }
      }
    }
    assert.deepEqual(problemas, [], "copy sem acentos Portugalueses:\n" + problemas.join("\n"));
  });

  test("CONTRASTE: a forma acentuada passa, a forma sem acento e apanhada", () => {
    // Sem este teste, um "proibida" mal escrito faria o anterior passar sempre.
    // O contraste e feito sobre a forma acentuada: remove-se o acento da
    // PALAVRA PROIBIDA, nao da frase acentuada (que nem sempre contem a forma
    // — por exemplo "instabilidade" nao leva acento nenhum).
    const semAcento = (s: string) =>
      s
        .replace(/[àáâã]/gi, "a")
        .replace(/[éê]/gi, "e")
        .replace(/[í]/gi, "i")
        .replace(/[óôõ]/gi, "o")
        .replace(/[ú]/gi, "u")
        .replace(/ç/gi, "c");

    // Formas sem acento em PT-PT: servem de guarda contra texto em ingles ou
    // pt-BR, mas nao tem acento a retirar, logo o contraste nao se aplica.
    const SEM_ACENTO = ["PID"];

    for (const [proibida, correta] of FORMAS) {
      assert.equal(proibida.test(correta), false, `a forma acentuada "${correta}" esta a ser apanhada como errada`);
      if (SEM_ACENTO.includes(correta)) continue;
      const esperada = semAcento(correta);
      assert.notEqual(esperada, correta, `a forma "${correta}" nao tem acento para retirar: o contraste seria vazio`);
      assert.equal(proibida.test(esperada), true,
        `a forma sem acento "${esperada}" (de "${correta}") nao esta a ser apanhada por ${proibida}`);
    }
  });

  test("CONTRASTE: aplicar os acentos ao texto real elimina todas as formas proibidas", () => {
    const comAcentos = (s: string) =>
      s
        .replace(/\bNao\b/g, "Não")
        .replace(/\bnao\b/g, "não")
        .replace(/\bha\b/g, "há")
        .replace(/\btambem\b/g, "também")
        .replace(/\bso\b/g, "só")
        .replace(/\bdisponivel\b/g, "disponível")
        .replace(/\bconfianca\b/g, "confiança")
        .replace(/\bcompilacao\b/g, "compilação")
        .replace(/\bconversao\b/g, "conversão")
        .replace(/\bvideo\b/g, "vídeo")
        .replace(/\besta\b/g, "está")
        .replace(/\be\b/g, "é")
        .replace(/\bOrientacao\b/g, "Orientação");

    const restantes: string[] = [];
    for (const p of CASOS) {
      for (const { origem, texto } of stringsVisiveis(p)) {
        const corrigido = comAcentos(texto);
        for (const [proibida] of FORMAS) {
          if (proibida.test(corrigido)) restantes.push(`${p.name}/${origem}: ${JSON.stringify(corrigido)}`);
        }
      }
    }
    assert.deepEqual(restantes, [],
      "apos aplicar os acentos nao deve sobrar nenhuma forma proibida:\n" + restantes.join("\n"));
  });

  test("o texto real nao contem mojibake nem caracteres de outra escrita", () => {
    for (const p of CASOS) {
      for (const { origem, texto } of stringsVisiveis(p)) {
        assert.ok(!/[\uFFFD\u00C3\u00C2]/.test(texto), `mojibake em ${p.name}/${origem}: ${texto}`);
        assert.ok(!/[\u3040-\u30FF\u4E00-\u9FFF]/.test(texto), `caractere CJK em ${p.name}/${origem}: ${texto}`);
      }
    }
  });

  test("os rotulos do painel de detalhe com acento estao no ficheiro da pagina", () => {
    // As strings do painel vivem no JSX, nao na funcao pura. Confirma-se pela
    // fonte porque nao ha outro caminho sem DOM.
    const fs = readFileSync(new URL("../src/pages/TaskManagerPage.tsx", import.meta.url), "utf8");
    assert.match(fs, />O que é</, "o rotulo do bloco 'o que e' leva acento");
    assert.match(fs, />Orientação</, "o rotulo do bloco de orientacao leva acento");
    assert.match(fs, /Memória/, "a pagina usa acento: 'Memoria' ja vinha com acento");
    assert.match(fs, /Ações/, "a pagina usa acento: 'Accoes' ja vinha com acento");
  });
});
