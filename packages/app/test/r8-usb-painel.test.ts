import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ScanState, UsbDeviceState, UsbProtectionSnapshot } from "@cybersafe/shared-types";
import type { ModeloUsb, OrquestradorUsb } from "../src/lib/usbProtection";

/**
 * R8-USB-UI — o painel do observador USB, dentro de "Análise de Segurança".
 *
 * Dono: qoder (Frontend Lead). Contrato: `UsbProtectionSnapshot` /
 * `UsbDeviceState` / `UsbProtectionConfig` publicados pelo Kilo em
 * `@cybersafe/shared-types` (src e dist verificados em disco a 12/10, 21:15).
 * Não há tipos duplicados nem na UI nem aqui: as fixtures são `unknown` que
 * entram pelo `normalizarSnapshot`, exatamente como entram do IPC.
 *
 * O que é provado COMO. O package não tem DOM nem jsdom, por isso a ordem de
 * grandeza deste ficheiro é: (a) **funções puras** com fixtures do contrato;
 * (b) **orquestração assíncrona real** — promises adiadas e um agendador
 * emprestado a exercitar `criarOrquestradorUsb`, que é onde os três defeitos
 * apontados em revisão vivem; (c) `renderToStaticMarkup` só para o estado
 * INICIAL, que não tem efeitos; (d) estrutura de fonte apenas para o que é
 * estrutural por natureza (montagem aditiva, bridge, tipos). Um grep nunca é
 * apresentado como prova de comportamento.
 */

(globalThis as Record<string, unknown>).React = React;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (...parts: string[]) => fs.readFileSync(path.join(HERE, "..", ...parts), "utf8");
const lf = (texto: string) => texto.replace(/\r\n/g, "\n");

const lib = read("src", "lib", "usbProtection.ts");
const painel = read("src", "components", "UsbProtectionPanel.tsx");
const scanner = lf(read("src", "pages", "FileScannerPage.tsx"));
const electronDts = read("src", "electron.d.ts");
const sharedTypes = read("..", "shared-types", "src", "index.ts");
const decls = read("src", "index.css").replace(/\/\*[\s\S]*?\*\//g, "");

const {
  INTERVALO_CONSULTA_MS,
  PRAZO_CONSULTA_MS,
  TEXTO_ESPERA_PROLONGADA,
  TEXTO_PRAZO_CONSULTA,
  chipsDoTom,
  criarOrquestradorUsb,
  decidirRefreshUsb,
  descreverMonitor,
  horaDe,
  linhaDoResultado,
  limitacaoDoDispositivo,
  notaDeConfirmacao,
  normalizarDispositivo,
  normalizarSnapshot,
  optInDoSnapshot,
  progressoDoDispositivo,
  rotuloDoEstado,
  tomDoEstado,
  unidadeDe,
  vistaDoPainel,
} = await import("../src/lib/usbProtection");
const { UsbProtectionPanel } = await import("../src/components/UsbProtectionPanel");

/** O texto visível do painel: sem comentários (citam as palavras proibidas). */
const textoVisivel = painel
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "")
  .replace(/className="[^"]*"/g, "");

/** O lib sem comentários: a regra de documentação cita «sem limitações» para a proibir. */
const libVisivel = lib.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ── fixtures (contrato real, nunca shape inventado) ──────────────────────────

const dispositivo = (extra: Partial<UsbDeviceState> = {}): UsbDeviceState => ({
  id: "usb-insert-7c1",
  rootPath: "E:\\",
  present: true,
  status: "detected",
  ...extra,
});

const snapshot = (extra: Partial<UsbProtectionSnapshot> = {}): UsbProtectionSnapshot => ({
  enabled: false,
  monitorStatus: "operational",
  updatedAt: "2026-10-12T19:40:00.000Z",
  devices: [],
  ...extra,
});

/** Um `ScanState` de uma análise custom de unidade, com os contadores do R7. */
const scan = (extra: Partial<ScanState> = {}): ScanState =>
  ({
    id: "scan-usb-1",
    type: "custom",
    status: "running",
    progress: 0,
    filesScanned: 0,
    threatsFound: 0,
    phase: "scanning",
    filesTotal: 100,
    filesAnalyzed: 0,
    filesExcluded: 0,
    filesFailed: 0,
    ...extra,
  }) as ScanState;

/** Promise controlada: o teste decide QUANDO a bridge responde. */
function deferida<T>() {
  let resolver!: (valor: T) => void;
  let rejeitar!: (razao: unknown) => void;
  const promessa = new Promise<T>((resolve, reject) => {
    resolver = resolve;
    rejeitar = reject;
  });
  return { promessa, resolver, rejeitar };
}

/** Agendador emprestado: prova o tick sem depender do relógio real. */
function agendadorFalso() {
  const agendadas: Array<() => void> = [];
  let cancelamentos = 0;
  return {
    agendar(funcao: () => void, ms: number) {
      assert.ok(
        ms === INTERVALO_CONSULTA_MS || ms === PRAZO_CONSULTA_MS,
        `temporizador com prazo fora do contrato: ${ms} ms`,
      );
      agendadas.push(funcao);
      return () => {
        cancelamentos += 1;
        const indice = agendadas.indexOf(funcao);
        if (indice >= 0) agendadas.splice(indice, 1);
      };
    },
    disparar() {
      const funcao = agendadas.shift();
      if (!funcao) throw new Error("não havia tick agendado");
      funcao();
    },
    get pendentes() {
      return agendadas.length;
    },
    get cancelamentos() {
      return cancelamentos;
    },
  };
}

async function escorrer(microtarefas = 16): Promise<void> {
  for (let i = 0; i < microtarefas; i += 1) await Promise.resolve();
}

describe("R8-USB 1 — o contrato é consumido, não copiado", () => {
  test("os tipos e a bridge existem com a forma publicada pelo Kilo", () => {
    assert.match(sharedTypes, /export type UsbMonitorStatus = "starting" \| "operational" \| "unavailable"/);
    assert.match(
      sharedTypes,
      /export type UsbDeviceStatus =[\s\S]*?"detected"[\s\S]*?"queued"[\s\S]*?"scanning"[\s\S]*?"completed"[\s\S]*?"cancelled"[\s\S]*?"failed"[\s\S]*?"removed"[\s\S]*?"incomplete"/,
    );
    assert.match(sharedTypes, /export interface UsbProtectionConfig \{\s*version: 1;/);
    assert.match(
      sharedTypes,
      /export interface UsbDeviceState \{[\s\S]*?id: string;[\s\S]*?rootPath: string;[\s\S]*?present: boolean;[\s\S]*?status: UsbDeviceStatus;[\s\S]*?scanId\?: string;[\s\S]*?result\?: ScanState;[\s\S]*?limitation\?: string;/,
    );
    assert.match(
      sharedTypes,
      /export interface UsbProtectionSnapshot \{[\s\S]*?enabled: boolean;[\s\S]*?monitorStatus: UsbMonitorStatus;[\s\S]*?devices: UsbDeviceState\[\];/,
    );
    assert.match(electronDts, /getUsbProtection: \(\) => Promise<UsbProtectionSnapshot>;/);
    assert.match(
      electronDts,
      /configureUsbProtection: \(config: \{ enabled: boolean \}\) => Promise<UsbProtectionSnapshot>;/,
    );
    assert.match(electronDts, /import type \{[^}]*UsbProtectionSnapshot[^}]*\} from "@cybersafe\/shared-types"/);
  });

  test("nem o lib nem o painel declaram tipos do contrato em local", () => {
    for (const fonte of [lib, painel]) {
      assert.equal(/interface UsbDeviceState|type UsbDeviceState =/.test(fonte), false, "UsbDeviceState duplicado");
      assert.equal(
        /interface UsbProtectionSnapshot|type UsbProtectionSnapshot =/.test(fonte),
        false,
        "snapshot duplicado",
      );
      assert.equal(/interface UsbProtectionConfig|type UsbProtectionConfig =/.test(fonte), false, "config duplicada");
      assert.match(fonte, /from "@cybersafe\/shared-types"/, "não importa do contrato");
    }
  });

  test("o progresso vem do onScanProgress existente, sem tópico novo", () => {
    assert.match(painel, /window\.electronAPI\?\.onScanProgress/);
    assert.match(painel, /subscrever\(\(estado\) => orquestrador\.receberProgresso\(estado\)\)/);
    assert.match(painel, /unsubscribe\?\.\(\);\n\s*orquestrador\.parar\(\);/);
    assert.equal(/onUsb[A-Za-z]*|usb\.progress/.test(painel + lib), false, "a UI pediu um canal que o contrato não publica");
  });

  test("o painel não escreve nem executa nada na unidade: só pede estado e configura", () => {
    assert.equal(/startScan|cancelScan|openFolderDialog|getPathForFile|shell|writeFile|exec/.test(painel), false, "a UI toca em ações de escrita/execução");
    assert.match(lib, /usb\.getState/);
    assert.match(lib, /usb\.configure/);
  });
});

describe("R8-USB 2 — normalizar recusa o que não reconhece, em vez de adivinhar", () => {
  test("envelope válido passa; cada campo obrigatório em falta deita o snapshot fora", () => {
    const bom = snapshot({ devices: [dispositivo()] });
    const normalizado = normalizarSnapshot(bom);
    assert.ok(normalizado, "o envelope do contrato foi recusado");
    assert.equal(normalizado.snapshot.monitorStatus, "operational");
    assert.equal(normalizado.snapshot.devices.length, 1);

    for (const partido of [
      {},
      null,
      "x",
      { ...snapshot(), enabled: "true" },
      { ...snapshot(), monitorStatus: "ready" },
      { ...snapshot(), updatedAt: 123 },
      { ...snapshot(), devices: undefined },
      { ...snapshot(), devices: {} },
    ]) {
      assert.equal(normalizarSnapshot(partido), null, `aceitou um envelope inválido: ${JSON.stringify(partido)}`);
    }
  });

  test("«starting» não é «operational» por omissão, e «unavailable» mostra o erro devolvido", () => {
    const a = normalizarSnapshot(snapshot({ monitorStatus: "starting" }));
    assert.ok(a);
    // Copy re-pinada a 13/10 (claim exclusivo): o produto diz «Monitorização
    // USB», não «Opt-in»/«Observador». A asserção continua a testar o mesmo:
    // `starting` não é `operational` por omissão.
    assert.equal(descreverMonitor(a.snapshot).titulo, "Monitorização USB a arrancar");
    assert.equal(descreverMonitor(a.snapshot).tom, "proc");

    const u = normalizarSnapshot(snapshot({ monitorStatus: "unavailable", error: "Enuminação falhou (CIM)." }));
    assert.ok(u);
    assert.equal(descreverMonitor(u.snapshot).tom, "warn");
    assert.match(descreverMonitor(u.snapshot).detalhe, /Enuminação falhou \(CIM\)\./, "a mensagem do serviço foi substituída");

    // Sem motivo devolvido diz-se que não houve motivo — não se inventa causa.
    const s = normalizarSnapshot(snapshot({ monitorStatus: "unavailable" }));
    assert.ok(s);
    assert.match(descreverMonitor(s.snapshot).detalhe, /não indicou o motivo/);
  });

  test("dispositivo sem identidade estável ou com estado desconhecido é CONTADO, não escondido", () => {
    const misto = snapshot({
      devices: [
        dispositivo(),
        { rootPath: "F:\\", present: true, status: "detected" },
        { id: "  ", rootPath: "G:\\", present: true, status: "detected" },
        { id: "x3", rootPath: "H:\\", present: true, status: "formatting" },
        null,
      ] as unknown as UsbDeviceState[],
    });
    const normalizado = normalizarSnapshot(misto);
    assert.ok(normalizado);
    assert.equal(normalizado.snapshot.devices.length, 1, "linhas inválidas passaram");
    assert.equal(normalizado.ignorados, 4, "os registos ignorados não foram contados");
  });

  test("campos opcionais só ficam quando existem; ausentes não viram vazio nem zero", () => {
    const limpo = normalizarDispositivo({ id: "d1", rootPath: "E:\\", present: true, status: "detected" });
    assert.ok(limpo);
    assert.equal("label" in limpo, false, "label ausente virou string vazia");
    assert.equal("scanId" in limpo, false, "scanId ausente virou string vazia");
    assert.equal("result" in limpo, false, "result ausente virou objeto");
    assert.equal(limitacaoDoDispositivo(limpo), null);
    assert.equal(limitacaoDoDispositivo(dispositivo({ limitation: "  " })), null);
    assert.equal(limitacaoDoDispositivo(dispositivo({ limitation: "read-only não provado" })), "read-only não provado");
  });

  test("um resultado sem id não é aceite como ScanState", () => {
    const limpo = normalizarDispositivo({
      id: "d1",
      rootPath: "E:\\",
      present: true,
      status: "completed",
      result: { status: "completed" },
    });
    assert.ok(limpo);
    assert.equal("result" in limpo, false, "resultado ilegível foi aceite");
  });
});

describe("R8-USB 3 — os oito estados dizem o que são, e nada de proteção", () => {
  test("rótulo e tom de cada estado do contrato", () => {
    const esperado: Record<string, [string, string]> = {
      detected: ["Deteção confirmada", "na"],
      queued: ["Em fila para análise", "proc"],
      scanning: ["A analisar", "proc"],
      completed: ["Análise concluída", "ok"],
      cancelled: ["Análise cancelada", "na"],
      failed: ["Análise falhou", "crit"],
      removed: ["Unidade removida", "na"],
      incomplete: ["Análise incompleta", "warn"],
    };
    for (const [estado, [rotulo, tom]] of Object.entries(esperado)) {
      assert.equal(rotuloDoEstado(estado as never), rotulo, `rótulo errado em ${estado}`);
      assert.equal(tomDoEstado(estado as never), tom, `tom errado em ${estado}`);
    }
  });

  test("removida/incompleta nunca se escrevem como concluída, e o painel não conhece «protegido»", () => {
    for (const estado of ["removed", "incomplete", "cancelled", "failed"]) {
      assert.equal(rotuloDoEstado(estado as never).includes("concluída"), false, `${estado} chamado de concluída`);
    }
    for (const proibido of [
      "sucesso",
      "Sucesso",
      "protegido",
      "Protegido",
      "seguro",
      "Seguro",
      "bloqueado automaticamente",
    ]) {
      assert.equal(textoVisivel.includes(proibido), false, `o painel usa a palavra ${proibido}`);
    }
    // «tempo real» só pode existir a negar — é a linha do cabeçalho que diz que
    // este painel NÃO é proteção em tempo real. Mais do que uma ocorrência era
    // a afirmação que proibimos.
    assert.equal((textoVisivel.match(/tempo real/g) ?? []).length, 1, "«tempo real» entrou mais do que a negação");
    assert.match(textoVisivel, /não é proteção em tempo real/);
    assert.equal(/sem limitaç/i.test(textoVisivel + libVisivel), false, "afirmação de ausência de limitação");
  });

  test("operational com zero unidades não é lista vazia silenciosa nem garantia", () => {
    const vista = descreverMonitor(snapshot({ monitorStatus: "operational", devices: [] }));
    assert.match(vista.titulo, /Nenhuma unidade de armazenamento USB confirmada/);
    assert.match(vista.detalhe, /não é uma garantia de proteção/);
  });

  test("hora ilegível diz isso, não «Invalid Date»", () => {
    assert.match(horaDe("não é ISO"), /hora ilegível no registo/);
    assert.equal(horaDe("2026-10-12T19:40:00.000Z").includes("Invalid"), false);
  });

  test("a unidade chama-se pelo volume, senão pela raiz — nunca por um caminho de ficheiro", () => {
    assert.equal(unidadeDe(dispositivo({ label: "PENKAUSA" })), "PENKAUSA");
    assert.equal(unidadeDe(dispositivo({ rootPath: "E:\\" })), "Unidade E:\\");
    assert.equal(unidadeDe(dispositivo({ rootPath: "" })), "Unidade sem nome");
    assert.equal(unidadeDe(dispositivo({ label: "   ", rootPath: "F:\\" })), "Unidade F:\\");
  });

  test("o opt-in lê-se do snapshot, nunca do pedido", () => {
    assert.equal(optInDoSnapshot(null), "desconhecido");
    assert.equal(optInDoSnapshot(snapshot({ enabled: false })), "desligado");
    assert.equal(optInDoSnapshot(snapshot({ enabled: true })), "ligado");
  });
});

describe("R8-USB 4 — contadores e progresso: só o que o serviço sabe, quando o sabe", () => {
  test("progresso só na linha scanning cujo scanId bate certo com a sessão ao vivo", () => {
    const d = dispositivo({ status: "scanning", scanId: "scan-usb-1" });
    assert.equal(progressoDoDispositivo(d, null), null, "havia progresso sem sessão");
    assert.equal(progressoDoDispositivo(dispositivo({ status: "scanning" }), scan({ filesScanned: 50 })), null, "sem scanId não há progresso");
    assert.equal(progressoDoDispositivo(d, scan({ id: "OUTRA-SESSAO", filesScanned: 50 })), null, "progresso emprestado de outra sessão");
    assert.equal(progressoDoDispositivo(d, scan({ filesScanned: 25 })), 25);
    // Gathering sem denominador: o scanner já diz «sem leitura», o painel não inventa.
    assert.equal(progressoDoDispositivo(d, scan({ phase: "gathering", filesTotal: undefined })), null);
  });

  test("REVISOES — dispositivo terminal não mostra progresso velho da mesma sessão", () => {
    const concluido = dispositivo({
      status: "completed",
      scanId: "scan-usb-1",
      result: scan({ status: "completed", filesScanned: 100, revision: 6 }),
    });
    const atrasado = scan({ status: "running", filesScanned: 71, revision: 5 });
    assert.equal(progressoDoDispositivo(concluido, atrasado), null, "o painel voltou a 71 depois de concluir");
    assert.equal(progressoDoDispositivo(concluido, scan({ status: "running", filesScanned: 71, revision: 7 })), null,
      "nem com revisão maior um dispositivo terminal pinta progresso");
    const linha = linhaDoResultado(concluido);
    assert.ok(linha);
    assert.match(linha, /considerados 100/);
    assert.equal(linha.includes("71"), false, "o resultado passou a ler-se do evento atrasado");
  });

  test("terminal do motor com snapshot a dizer «scanning» pede confirmação, nunca conclui por conta", () => {
    const d = dispositivo({ status: "scanning", scanId: "scan-usb-1" });
    assert.match(notaDeConfirmacao(d, scan({ status: "completed" })), /a confirmar com o serviço/);
    assert.equal(rotuloDoEstado(d.status), "A analisar", "o chip mudou por inferência da UI");
    assert.equal(notaDeConfirmacao(d, scan({ status: "running" })), null);
    assert.equal(
      notaDeConfirmacao(dispositivo({ status: "completed", scanId: "scan-usb-1" }), scan({ status: "completed" })),
      null,
    );
    assert.equal(notaDeConfirmacao(d, scan({ id: "OUTRA", status: "completed" })), null);
  });

  test("os contadores do resultado são os do scanner, não uma versão USB deles", () => {
    const d = dispositivo({
      status: "completed",
      scanId: "scan-usb-1",
      result: scan({ status: "completed", filesScanned: 90, filesTotal: 100, filesAnalyzed: 70, filesExcluded: 20, filesFailed: 0, threatsFound: 2 }),
    });
    const linha = linhaDoResultado(d);
    assert.ok(linha);
    assert.match(linha, /considerados 100/);
    assert.match(linha, /analisados 70/);
    assert.match(linha, /excluídos 20/);
    assert.match(linha, /falhados 0/);
    assert.match(linha, /ameaças 2/);
    assert.match(lib, /scanResultBreakdown\(estado\)/, "o lib não reusa o breakdown do scanner");
    assert.match(lib, /scanResultBreakdownNote\(detalhe, estado\.status\)/, "a reconciliação do scanner não é reaproveitada");
    assert.match(lib, /shouldAcceptScanState\(aoVivo, estado\)/, "a monotonicidade do scanner não é reaproveitada");
  });

  test("não-terminais, sem result e sem contadores têm cada um a sua frase honesta", () => {
    assert.equal(linhaDoResultado(dispositivo({ status: "scanning", scanId: "scan-usb-1" })), null);
    assert.match(linhaDoResultado(dispositivo({ status: "completed" })) as string, /não devolveu contadores/);
    assert.match(
      linhaDoResultado(dispositivo({ status: "completed", result: scan({ status: "completed", filesTotal: 0, filesScanned: 0 }) })) as string,
      /sem contadores no resultado/,
    );
  });

  test("coalescing puro: montagem/manual/tick deitam fora em voo, terminal/config marcam UM pendente", () => {
    assert.equal(decidirRefreshUsb("montagem", false), "pedir");
    assert.equal(decidirRefreshUsb("manual", false), "pedir");
    assert.equal(decidirRefreshUsb("tick", false), "pedir");
    assert.equal(decidirRefreshUsb("terminal", false), "pedir");
    assert.equal(decidirRefreshUsb("montagem", true), "ignorar");
    assert.equal(decidirRefreshUsb("manual", true), "ignorar");
    assert.equal(decidirRefreshUsb("tick", true), "ignorar", "tick encadeado seria a tempestade de pedidos");
    assert.equal(decidirRefreshUsb("terminal", true), "marcar_pendente");
    assert.equal(decidirRefreshUsb("config", true), "marcar_pendente");
    assert.equal(decidirRefreshUsb("pendente", false), "pedir");
    assert.equal(decidirRefreshUsb("pendente", true), "ignorar", "o pendente encadeou outro pendente");
    assert.equal(INTERVALO_CONSULTA_MS, 5000, "o intervalo do tick mudou sem decisão registada");
  });
});

describe("R8-USB 5 — orquestração assíncrona real (os três defeitos da revisão)", () => {
  test("defeito 1: pen ligada DEPOIS da montagem aparece, e o progresso chega antes do terminal", async () => {
    const agendador = agendadorFalso();
    const primeira = deferida<unknown>();
    const segunda = deferida<unknown>();
    const modelos: ModeloUsb[] = [];
    let pedidos = 0;
    const orquestrador: OrquestradorUsb = criarOrquestradorUsb({
      obterEstado: () => {
        pedidos += 1;
        return pedidos === 1 ? primeira.promessa : segunda.promessa;
      },
      aoModelo: (m) => modelos.push(m),
      agendar: agendador.agendar,
    });

    orquestrador.iniciar();
    await escorrer();
    assert.equal(pedidos, 1, "a montagem não pediu o estado");
    assert.equal(modelos.at(-1)?.vista.tipo, "a_consultar", "a UI mostrou alguma coisa antes da resposta");

    primeira.resolver(snapshot({ devices: [] }));
    await escorrer();
    const depoisDoPrimeiro = modelos.at(-1);
    assert.equal(depoisDoPrimeiro?.vista.tipo, "snapshot");
    if (depoisDoPrimeiro?.vista.tipo === "snapshot") {
      assert.equal(depoisDoPrimeiro.vista.dispositivos.length, 0, "havia unidades antes de haver unidade ligada");
    }
    assert.equal(agendador.pendentes, 1, "montado sem tick agendado — a pen nunca apareceria");

    // O utilizador liga a pen com o opt-in DESLIGADO: o serviço passa a dizer `queued`.
    agendador.disparar();
    await escorrer();
    assert.equal(pedidos, 2, "o tick não consultou o estado");
    const pen = dispositivo({ status: "scanning", scanId: "scan-usb-1", label: "PENKAUSA" });
    segunda.resolver(snapshot({ enabled: false, devices: [pen] }));
    await escorrer();
    const agora = modelos.at(-1);
    assert.equal(agora?.vista.tipo, "snapshot");
    if (agora?.vista.tipo === "snapshot") {
      assert.equal(agora.vista.dispositivos.length, 1, "a unidade ligada depois da montagem não apareceu");
      assert.equal(rotuloDoEstado(agora.vista.dispositivos[0].status), "A analisar");
    }

    // Progresso real, correlacionado pelo scanId que só o snapshot trouxe.
    orquestrador.receberProgresso(scan({ id: "scan-usb-1", filesScanned: 30, revision: 1 }));
    await escorrer();
    const comProgresso = modelos.at(-1);
    assert.equal(comProgresso?.aoVivo?.filesScanned, 30);
    if (comProgresso?.vista.tipo === "snapshot") {
      assert.equal(progressoDoDispositivo(comProgresso.vista.dispositivos[0], comProgresso.aoVivo), 30);
    }
    // Um terminal é o único evento que vale um re-pedido — e um só.
    orquestrador.receberProgresso(scan({ id: "scan-usb-1", status: "completed", filesScanned: 100, revision: 2 }));
    await escorrer();
    assert.equal(pedidos, 3, "o terminal não pediu a confirmação do serviço");
    orquestrador.receberProgresso(scan({ id: "scan-usb-1", status: "completed", filesScanned: 100, revision: 3 }));
    await escorrer();
    assert.equal(pedidos, 3, "progresso a mais virou pedidos a mais");
    orquestrador.parar();
    assert.equal(agendador.cancelamentos >= 1, true, "desmontado, o tick ficou a correr");
  });

  test("defeito 1b: a cadeia de ticks é bounded — um tick em cada momento, um só re-pedido", async () => {
    const agendador = agendadorFalso();
    const atrasadas = [deferida<unknown>(), deferida<unknown>()];
    const modelos: ModeloUsb[] = [];
    let pedidos = 0;
    const orquestrador = criarOrquestradorUsb({
      obterEstado: () => {
        pedidos += 1;
        return atrasadas[pedidos - 1].promessa;
      },
      aoModelo: (m) => modelos.push(m),
      agendar: agendador.agendar,
    });

    orquestrador.iniciar();
    await escorrer();
    assert.equal(pedidos, 1, "a montagem não pediu o estado");
    assert.equal(agendador.pendentes, 2, "dois temporizadores em voo: a espera de apresentação e o prazo do pedido — nunca um segundo pedido");

    atrasadas[0].resolver(snapshot({ devices: [] }));
    await escorrer();
    assert.equal(agendador.pendentes, 1, "montado e com resposta, há exatamente um tick agendado");

    agendador.disparar();
    await escorrer();
    assert.equal(pedidos, 2, "o tick não consultou o estado");

    // O que está agendado agora é a espera do pedido 2. Dispará-la NÃO pode
    // gerar pedido: é mitigação de apresentação. O prazo do IPC (pacote A)
    // continua armado e é o único temporizador que sobre voo.
    assert.equal(modelos.at(-1)?.esperaProlongada, false, "a espera foi declarada antes do limiar");
    agendador.disparar();
    await escorrer();
    assert.equal(pedidos, 2, "a espera prolongada gerou um pedido extra");
    assert.equal(modelos.at(-1)?.esperaProlongada, true, "aos 5 s o painel não passou a espera explícita");
    assert.equal(agendador.pendentes, 1, "sobrou temporizador além do prazo do pedido em voo");

    // Com o segundo pedido em voo: dois terminais de sessões diferentes não
    // empilham — o coalescing deixa UM pendente, não uma fila.
    orquestrador.receberProgresso(scan({ id: "sessao-a", status: "completed", revision: 1 }));
    orquestrador.receberProgresso(scan({ id: "sessao-b", status: "failed", revision: 1 }));
    await escorrer();
    assert.equal(pedidos, 2, "empilhou pedidos enquanto havia um em voo");

    atrasadas[1].resolver(snapshot({ devices: [dispositivo()] }));
    await escorrer();
    assert.equal(pedidos, 3, "o coalescing não se reduziu a UM re-pedido");
    assert.equal(modelos.at(-1)?.esperaProlongada, false, "a resposta tardia não limpou a espera");
    orquestrador.parar();
    assert.equal(agendador.cancelamentos >= 1, true, "desmontado, o tick ficou a correr");
  });

  test("espera prolongada: resposta que nunca chega, relógio injetado, e nada emite depois de desmontar", async () => {
    const agendador = agendadorFalso();
    const pendenteParaSempre = deferida<unknown>();
    const modelos: ModeloUsb[] = [];
    let pedidos = 0;
    const orquestrador = criarOrquestradorUsb({
      obterEstado: () => {
        pedidos += 1;
        return pendenteParaSempre.promessa;
      },
      aoModelo: (m) => modelos.push(m),
      agendar: agendador.agendar,
    });

    orquestrador.iniciar();
    await escorrer();
    assert.equal(pedidos, 1);
    assert.equal(modelos.at(-1)?.esperaProlongada, false, "a espera explícita apareceu antes do limiar");
    assert.equal(modelos.at(-1)?.vista.tipo, "a_consultar");

    agendador.disparar();
    await escorrer();
    const emEspera = modelos.at(-1);
    assert.equal(emEspera?.esperaProlongada, true);
    assert.equal(emEspera?.vista.tipo, "a_consultar", "a espera inventou um estado que o serviço não devolveu");
    assert.equal(pedidos, 1, "a espera prolongada multiplicou pedidos");

    // Desmontar durante a espera: nem o temporizador nem a resposta tardia emitem.
    const emissoesAntesDeParar = modelos.length;
    orquestrador.parar();
    pendenteParaSempre.resolver(snapshot({ devices: [dispositivo()] }));
    await escorrer();
    assert.equal(modelos.length, emissoesAntesDeParar, "a resposta tardia emitiu depois de desmontar");
    assert.equal(agendador.pendentes, 0, "ficou temporizador vivo depois do unmount");
  });

  test("a espera prolongada continua mitigação de apresentação; o prazo real do IPC é PRAZO_CONSULTA_MS", () => {
    // A espera aos 5 s NÃO declara falha nem timeout — isso passou a ser papel
    // do prazo (pacote A, testado em recovery-usb-ui.test.ts). Aqui prova-se o
    // que ela ainda é: só apresentação, sem palavras que afirmem o contrário.
    for (const proibido of ["tempo esgotado", "timeout", "expirou", "falhou", "erro", "sem ligação"]) {
      assert.equal(TEXTO_ESPERA_PROLONGADA.toLowerCase().includes(proibido), false, `a espera diz ${proibido}`);
    }
    assert.match(TEXTO_ESPERA_PROLONGADA, /ainda não respondeu/);
    assert.match(TEXTO_ESPERA_PROLONGADA, /não está confirmado/);
    assert.match(TEXTO_ESPERA_PROLONGADA, /não repete o pedido/);
    assert.equal(/pt-BR/.test(TEXTO_ESPERA_PROLONGADA), false);
    // O prazo REAL existe, é maior que a espera, e a sua frase declara apenas
    // "não confirmado" — nunca sucesso nem falha do serviço.
    assert.ok(PRAZO_CONSULTA_MS > INTERVALO_CONSULTA_MS, "o prazo de IPC não pode ser menor que a espera");
    assert.equal(PRAZO_CONSULTA_MS, 15000, "o prazo da UI diverge do timeout CIM de 15 s por lote do serviço");
    assert.match(TEXTO_PRAZO_CONSULTA, /tempo limite/);
    assert.match(TEXTO_PRAZO_CONSULTA, /não foi confirmada/);
    assert.doesNotMatch(TEXTO_PRAZO_CONSULTA, /o serviço falhou|está em baixo|seguro|protegido/i);
    assert.match(lib, /cancelarEspera = agendar\(\(\) => \{[\s\S]*?\}, INTERVALO_CONSULTA_MS\);/);
    assert.match(painel, /\{modelo\.esperaProlongada \? TEXTO_ESPERA_PROLONGADA : "A consultar a monitorização USB ao serviço…"\}/);
  });

  test("defeito 2: GET antigo em voo não sobrescreve o configure; a confirmação mantém-se", async () => {
    const agendador = agendadorFalso();
    const atrasada = deferida<unknown>();
    const confirmada = deferida<unknown>();
    const modelos: ModeloUsb[] = [];
    let pedidos = 0;
    let configuracoes = 0;
    const orquestrador = criarOrquestradorUsb({
      obterEstado: () => {
        pedidos += 1;
        return atrasada.promessa;
      },
      configurar: (config) => {
        configuracoes += 1;
        assert.deepEqual(config, { enabled: true }, "o pedido não foi o clicado");
        return confirmada.promessa;
      },
      aoModelo: (m) => modelos.push(m),
      agendar: agendador.agendar,
    });

    orquestrador.iniciar();
    await escorrer();
    assert.equal(pedidos, 1, "GET em voo para a experiência de atraso");

    void orquestrador.alternarOptIn(true);
    await escorrer();
    assert.equal(configuracoes, 1);
    assert.equal(modelos.at(-1)?.aConfigurar, true, "sem indicação de gravação em curso");

    confirmada.resolver(snapshot({ enabled: true, devices: [dispositivo()] }));
    await escorrer();
    const confirmado = modelos.at(-1);
    assert.equal(confirmado?.enabled, true, "o opt-in confirmado não ficou refletido");
    assert.equal(confirmado?.feedback.tipo, "ok");
    if (confirmado?.feedback.tipo === "ok") {
      assert.match(confirmado.feedback.mensagem, /Monitorização confirmada ligada pelo serviço/);
    }

    // Agora resolve o GET que saiu ANTES do clique: traz `enabled: false` velho.
    atrasada.resolver(snapshot({ enabled: false, devices: [] }));
    await escorrer();
    const depois = modelos.at(-1);
    assert.equal(depois?.enabled, true, "a resposta atrasada sobrescreveu a confirmação do configure");
    assert.equal(depois?.feedback.tipo, "ok", "a confirmação foi substituída por outro feedback");
    if (depois?.feedback.tipo === "ok") {
      assert.match(depois.feedback.mensagem, /Monitorização confirmada ligada pelo serviço/);
    }
    if (depois?.vista.tipo === "snapshot") {
      assert.equal(depois.vista.dispositivos.length, 1, "a resposta atrasada limpou as unidades confirmadas");
    }
    assert.equal(pedidos, 1, "a resposta anulada pela geração voltou a ser pedida");
    orquestrador.parar();
  });

  test("defeito 2b: nada escreve no estado depois de desmontar, nem o configure", async () => {
    const agendador = agendadorFalso();
    const pendente = deferida<unknown>();
    const modelos: ModeloUsb[] = [];
    const orquestrador = criarOrquestradorUsb({
      obterEstado: () => pendente.promessa,
      configurar: () => Promise.resolve(snapshot({ enabled: true })),
      aoModelo: (m) => modelos.push(m),
      agendar: agendador.agendar,
    });
    orquestrador.iniciar();
    await escorrer();
    const antesDeParar = modelos.length;
    orquestrador.parar();
    const depoisDeParar = modelos.length;
    pendente.resolver(snapshot({ devices: [dispositivo()] }));
    await escorrer();
    assert.equal(modelos.length, depoisDeParar, "um GET resolveu e emitiu depois de desmontado");
    assert.equal(antesDeParar >= 1, true, "a montagem nem sequer emitiu");
    orquestrador.receberProgresso(scan({ status: "completed", revision: 1 }));
    await escorrer();
    assert.equal(modelos.length, depoisDeParar, "progresso escreveu depois de desmontado");
  });

  test("defeito 3: evento atrasado da mesma sessão não faz os contadores recuar", async () => {
    const modelos: ModeloUsb[] = [];
    const orquestrador = criarOrquestradorUsb({
      obterEstado: () => Promise.resolve(snapshot({ devices: [dispositivo({ status: "scanning", scanId: "scan-usb-1" })] })),
      aoModelo: (m) => modelos.push(m),
      agendar: agendadorFalso().agendar,
    });
    orquestrador.iniciar();
    await escorrer();
    orquestrador.receberProgresso(scan({ id: "scan-usb-1", status: "completed", filesScanned: 100, revision: 6 }));
    await escorrer();
    orquestrador.receberProgresso(scan({ id: "scan-usb-1", status: "running", filesScanned: 71, revision: 5 }));
    await escorrer();
    assert.equal(modelos.at(-1)?.aoVivo?.status, "completed", "o evento atrasado reabriu a sessão");
    assert.equal(modelos.at(-1)?.aoVivo?.filesScanned, 100, "os contadores recuaram para 71");
    // Duplicado exato também não emite nada novo.
    const emissoes = modelos.length;
    orquestrador.receberProgresso(scan({ id: "scan-usb-1", status: "running", filesScanned: 71, revision: 5 }));
    await escorrer();
    assert.equal(modelos.length, emissoes, "um evento rejeitado ainda emitiu");
    orquestrador.parar();
  });

  test("sem bridge: o painel diz que não consultou, e não abre nada", async () => {
    const modelos: ModeloUsb[] = [];
    const orquestrador = criarOrquestradorUsb({ obterEstado: null, aoModelo: (m) => modelos.push(m) });
    orquestrador.iniciar();
    assert.equal(modelos.at(-1)?.vista.tipo, "sem_ligacao");
    await escorrer();
    assert.equal(modelos.length, 1, "sem bridge houve novo pedido ou tick");
  });

  test("erro do serviço é mostrado como veio, e sem bridge de configurar não há sucesso fingido", async () => {
    const modelos: ModeloUsb[] = [];
    const orquestrador = criarOrquestradorUsb({
      obterEstado: () => Promise.reject(new Error("Pipe fechado (2)")),
      configurar: null,
      aoModelo: (m) => modelos.push(m),
      agendar: agendadorFalso().agendar,
    });
    orquestrador.iniciar();
    await escorrer();
    const erro = modelos.at(-1)?.vista;
    assert.equal(erro?.tipo, "erro");
    if (erro?.tipo === "erro") assert.match(erro.mensagem, /Pipe fechado \(2\)/, "a mensagem do serviço foi reescrita");
    await orquestrador.alternarOptIn(true);
    const feedback = modelos.at(-1)?.feedback;
    assert.equal(feedback?.tipo, "erro");
    if (feedback?.tipo === "erro") assert.match(feedback.mensagem, /não tem o bridge de configuração USB/);
    orquestrador.parar();
  });
});

describe("R8-USB 6 — a vista, o render inicial e a montagem aditiva", () => {
  test("as quatro ramificações da vista, cada uma presa ao estado que a justifica", () => {
    assert.equal(vistaDoPainel("a_consultar", null, 0, null).tipo, "a_consultar");
    assert.equal(vistaDoPainel("sem_ligacao", null, 0, null).tipo, "sem_ligacao");
    assert.match((vistaDoPainel("erro", null, 0, null) as { mensagem: string }).mensagem, /não devolveu o estado USB/);
    assert.match((vistaDoPainel("erro", null, 0, "Pipe fechado") as { mensagem: string }).mensagem, /Pipe fechado/);
    // Fase «snapshot» sem snapshot reconhecível é erro, NÃO uma lista vazia.
    assert.match((vistaDoPainel("snapshot", null, 0, null) as { mensagem: string }).mensagem, /sem estado USB reconhecível/);
    const comCoisas = vistaDoPainel("snapshot", snapshot({ devices: [dispositivo()] }), 2, null);
    assert.equal(comCoisas.tipo, "snapshot");
    if (comCoisas.tipo === "snapshot") {
      assert.equal(comCoisas.ignorados, 2);
      assert.equal(comCoisas.dispositivos.length, 1);
      assert.equal(comCoisas.enabled, false);
    }
  });

  test("o estado inicial renderizado é «a consultar» — sem linhas, sem opt-in pintado como ligado", () => {
    (globalThis as Record<string, unknown>).window = { location: { hostname: "" } };
    const h = renderToStaticMarkup(createElement(UsbProtectionPanel, {}));
    assert.match(h, /A consultar a monitorização USB ao serviço…/);
    assert.equal(/row-item|state-chip/.test(h), false, "linhas ou chips antes de haver resposta");
    assert.equal(h.includes("Nenhuma unidade de armazenamento USB confirmada"), false, "o vazio mostrado antes da primeira leitura");
    assert.equal(h.includes("%"), false, "percentagem desenhada antes de haver leitura");
    assert.match(h, /Monitorização USB: <b class="font-semibold">desconhecida<\/b>/);
    assert.match(h, /aria-pressed="false"/);
  });

  test("a UI pinta o que o lib decidiu: chip por tom e ausência de leitura assumida", () => {
    assert.match(painel, /const chip = chipsDoTom\(tomDoEstado\(d\.status\)\);/);
    assert.match(painel, /\{rotuloDoEstado\(d\.status\)\}/);
    assert.match(painel, /sem leitura de progresso desta sessão/);
    assert.match(painel, /Limitação: \{limitacao\}/);
    assert.match(painel, /não está presente na última enumeração/);
    assert.match(painel, /progresso \{percentagem\} de 100/);
    assert.equal(/progresso 100|100%/.test(textoVisivel), false, "percentagem fixa no painel");
    // Funcional, não por literais: o lib constrói os nomes por interpolação, e
    // o que se exige é o par que sai e a regra que existe na folha.
    for (const par of ["ok", "warn", "crit", "proc", "na"]) {
      const pares = chipsDoTom(par as never);
      assert.equal(pares.chip, `state-chip state-chip--${par}`, `chip errado em ${par}`);
      assert.equal(pares.tile, par === "na" ? "icon-tile" : `icon-tile icon-tile--${par}`, `mosaico errado em ${par}`);
      for (const classe of pares.chip.split(" ").concat(pares.tile.split(" "))) {
        assert.ok(decls.includes(`.${classe}`), `.${classe} não tem regra na folha`);
      }
    }
  });

  test("o único temporizador do lib é o agendador injetável; o painel não cria nenhum", () => {
    assert.equal(/setInterval/.test(painel + lib), false, "polling por setInterval");
    assert.equal(/setTimeout|setInterval/.test(painel), false, "o painel cria temporizadores");
    const agendadores = lib.match(/setTimeout/g) ?? [];
    assert.equal(agendadores.length, 1, "mais do que um temporizador no lib");
    assert.match(lib, /const id = setTimeout\(funcao, ms\);\n\s*return \(\) => clearTimeout\(id\);/, "o temporizador não é cancelável");
  });

  test("a montagem na página do scanner é aditiva e nada duplica", () => {
    assert.match(scanner, /import \{ UsbProtectionPanel \} from "\.\.\/components\/UsbProtectionPanel"/);
    const lugarUsb = scanner.indexOf("<UsbProtectionPanel />");
    const lugarHistorico = scanner.indexOf("<ScanHistoryPanel sessaoTerminada={sessaoTerminada} />");
    assert.ok(lugarUsb > 0 && lugarHistorico > lugarUsb, "ordem USB → histórico por baixo");
    assert.ok(lugarUsb > scanner.indexOf("Análise em Segundo Plano"), "o painel USB subiu acima do que já existia");
    assert.equal((scanner.match(/UsbProtectionPanel/g) ?? []).length, 3, "integração do USB não é mínima");
    // As âncoras L1/L2 com HUMAN PASS R7 têm de estar exatamente como estavam.
    assert.equal((scanner.match(/\bdecideScanEvent\(/g) ?? []).length, 1, "a decisão de evento foi duplicada");
    assert.equal((scanner.match(/earlyEventsRef\.current/g) ?? []).length, 7, "o amortecedor de eventos precoces mudou de forma");
    assert.equal((scanner.match(/ScanHistoryPanel/g) ?? []).length, 3, "a montagem do histórico mexeu");
    assert.ok(scanner.includes("api.onScanProgress((raw: unknown)"), "a subscrição global a scan.progress partiu");
    assert.ok(scanner.includes("expectedScanIdRef.current = null"), "a adopção/rejeição de sessão partiu");
  });

  test("sem CSS novo: as primitivas usadas pelo painel já têm regra na folha", () => {
    const usadas = new Set<string>();
    for (const m of painel.matchAll(/"([^"\r\n]{2,})"/g)) {
      for (const token of m[1].split(/\s+/)) {
        if (/^(state-chip|icon-tile|row-|eyebrow-label|evidence-line|stat-card|cyber-border)/.test(token)) usadas.add(token);
      }
    }
    const lista = [...usadas];
    assert.ok(lista.length >= 8, `esperava as primitivas todas, vi ${lista.length}`);
    const semRegra = lista.filter((c) => !decls.includes(`.${c}`));
    assert.equal(semRegra.length, 0, `classes sem regra em index.css: ${semRegra.join(", ")}`);
  });
});
