/**
 * Gate de fixture para a sessão controlada do Scanner (TP-CONTINUOUS-RUNTIME Q1).
 *
 * Escopo: bootstrap do serviço. Não altera `engine.ts`, não altera `scan-manager.ts`,
 * não altera a UI. Este módulo FECHA pedidos e APERTA garantias; nunca abre uma
 * superfície nova. Sem `CYBERSAFE_REALDEV_FIXTURE_SCAN=1` nada é tocado e o serviço
 * comporta-se exactamente como hoje.
 *
 * Garantias efectivas (lidas no código do serviço, não assumidas):
 *  1. `scan.start` só passa com `type === "custom"` e `targetPath` contido no root,
 *    provado DUAS vezes: por prefixo léxico/resolvido e por `realpath`. O `realpath`
 *    é o que fecha a porta das junctions/symlinks que o prefixo léxico não contém.
 *  2. A contenção é feita com `path.relative`, nunca com `startsWith` cru — que
 *    trataria `C:\T\FIXTURE` como dentro de `C:\T\FIX` (mesma regra já usada em
 *    `scan-manager.estaContidoNaRaiz`).
 *  3. O root tem de ser um diretório DEDICADO deste run: strict descendant da base
 *    temporária, nunca o diretório pessoal, nunca a própria base, nunca dentro do
 *    diretório de perfil fora do Temp.
 *  4. Nenhum ancestral do root pode ser um ponto de reparse: cada segmento é verificado
 *    com `lstat` e o `realpath` do root tem de coincidir com o caminho lexical.
 *  5. Read-only EFECTIVO: whilst o gate está montado, TODA a scan iniciada recebe
 *    `readOnly: true` nas opções do `ScanManager`. Isso não é decoração — no motor,
 *    `readOnly === true` torna inalcançável o ramo de auto-quarentena
 *    (`engine.ts:2736`) e o ramo de enriquecimento VirusTotal (`engine.ts:2669`).
 *    Se o `readOnly` não puder ser forçado, `scan.start` é recusado.
 *  6. Qualquer falha de configuração é um lançamento no arranque: zero sessão.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const FIXTURE_SCAN_FLAG = "CYBERSAFE_REALDEV_FIXTURE_SCAN";
export const FIXTURE_ROOT_ENV = "CYBERSAFE_REALDEV_FIXTURE_ROOT";

/** Prefixo estável para que o chamador distinga a recusa do gate de uma falha do motor. */
export const GATE_CODE = "realdev_fixture_gate";

/**
 * Métodos que a sessão de fixture pode usar. A lista usa os nomes REAIS do dispatch
 * do serviço (`engine.ts`: scan.start / scan.cancel / scan.getActive / scan.getLast /
 * scan.history). Tudo o resto — monitor.*, usb.*, quarantine.*, process.*,
 * definitions.update — é recusado enquanto o gate estiver montado.
 */
const PERMITIDOS = new Set<string>([
  "scan.start",
  "scan.cancel",
  "scan.getActive",
  "scan.getLast",
  "scan.history",
]);

const semFim = (p: string) => p.replace(/[\\/]+$/, "");
const mesmaCoisa = (a: string, b: string) =>
  process.platform === "win32"
    ? semFim(a).toLowerCase() === semFim(b).toLowerCase()
    : semFim(a) === semFim(b);

/** Contenção por `path.relative`: cobre case do Windows, raiz de unidade e sufixos parecidos. */
export function estaContido(raiz: string, alvo: string): boolean {
  if (!raiz || !alvo) return false;
  const relativo = path.relative(path.resolve(raiz), path.resolve(alvo));
  return relativo === "" || (!relativo.startsWith("..") && !path.isAbsolute(relativo));
}

/** Caminhos que nunca podem ser root de fixture: o próprio perfil e as suas bases. */
function raizProibida(resolvido: string): string | null {
  const home = path.resolve(os.homedir());
  const tmp = path.resolve(os.tmpdir());
  if (mesmaCoisa(resolvido, home)) return "o root é o diretório pessoal";
  if (mesmaCoisa(resolvido, tmp)) return "o root é a base temporária em geral, não um diretório dedicado deste run";
  if (path.parse(resolvido).root.toLowerCase() === resolvido.toLowerCase()) return "o root é a raiz de um volume";
  const dentroDeHome = estaContido(home, resolvido);
  if (dentroDeHome && !estaContido(tmp, resolvido)) {
    return "o root está dentro do diretório pessoal mas fora da base temporária — dados do utilizador";
  }
  if (!estaContido(tmp, resolvido)) return "o root tem de estar sob a base temporária (dedicado a este run)";
  return null;
}

/** Nenhum ancestral pode ser symlink/junction/ponto de reparse. */
function ancestraisSemReparse(resolvido: string): string | null {
  const partes = path.parse(resolvido).root;
  let atual = partes;
  for (const seg of path.relative(partes, resolvido).split(/[\\/]+/).filter(Boolean)) {
    atual = path.join(atual, seg);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(atual);
    } catch {
      return `ancestral inexistente ou ilegível: ${atual}`;
    }
    if (st.isSymbolicLink()) return `ancestral é um ponto de reparse (symlink/junction): ${atual}`;
    if (!st.isDirectory()) return `ancestral não é diretório: ${atual}`;
  }
  return null;
}

/**
 * Valida o root indicado pelo ambiente. Lança em qualquer incumprimento — o arranque
 * falha e não há sessão (fail-closed pedido pelo OpenCode).
 */
export function fixtureRootFromEnv(env: NodeJS.ProcessEnv = process.env): { root: string; real: string } {
  const raw = env[FIXTURE_ROOT_ENV]?.trim();
  if (!raw) throw new Error(`${GATE_CODE}: ${FIXTURE_ROOT_ENV} é obrigatório com ${FIXTURE_SCAN_FLAG}=1`);
  if (!path.isAbsolute(raw)) throw new Error(`${GATE_CODE}: ${FIXTURE_ROOT_ENV} tem de ser absoluto: ${raw}`);
  if (raw.startsWith("\\\\") || raw.startsWith("//") || raw.startsWith("\\??\\")) {
    throw new Error(`${GATE_CODE}: ${FIXTURE_ROOT_ENV} não pode ser UNC/device namespace: ${raw}`);
  }
  const resolvido = path.resolve(raw);
  let st: fs.Stats;
  try {
    st = fs.lstatSync(resolvido);
  } catch {
    throw new Error(`${GATE_CODE}: ${FIXTURE_ROOT_ENV} não existe: ${resolvido}`);
  }
  if (st.isSymbolicLink()) throw new Error(`${GATE_CODE}: o próprio root é um ponto de reparse: ${resolvido}`);
  if (!st.isDirectory()) throw new Error(`${GATE_CODE}: o root não é um diretório: ${resolvido}`);

  const proibida = raizProibida(resolvido);
  if (proibida) throw new Error(`${GATE_CODE}: root não dedicado a este run — ${proibida}`);

  const reparseEmAncestral = ancestraisSemReparse(resolvido);
  if (reparseEmAncestral) throw new Error(`${GATE_CODE}: ${reparseEmAncestral}`);

  const real = fs.realpathSync.native ? fs.realpathSync.native(resolvido) : fs.realpathSync(resolvido);
  if (!mesmaCoisa(real, resolvido)) {
    throw new Error(`${GATE_CODE}: realpath do root difere do caminho lexical (junction/symlink em algum nível): ${resolvido} -> ${real}`);
  }
  return { root: resolvido, real };
}

/** Decisão pura e testável: este payload é uma varredura custom contida no root real? */
export function scanCustomContido(
  payload: unknown,
  raiz: { root: string; real: string },
): { ok: boolean; motivo: string } {
  const p = payload as { type?: unknown; targetPath?: unknown } | null | undefined;
  if (!p || typeof p !== "object") return { ok: false, motivo: "payload ausente ou não-objeto" };
  if (p.type !== "custom") return { ok: false, motivo: `type tem de ser "custom" (recebido: ${String(p.type)})` };
  const alvo = typeof p.targetPath === "string" ? p.targetPath.trim() : "";
  if (!alvo) return { ok: false, motivo: "targetPath ausente ou vazio" };
  if (!path.isAbsolute(alvo)) return { ok: false, motivo: `targetPath tem de ser absoluto: ${alvo}` };

  const resolvido = path.resolve(alvo);
  if (!estaContido(raiz.root, resolvido)) {
    return { ok: false, motivo: `targetPath fora do FIXTURE_ROOT (léxico): ${resolvido}` };
  }
  let real: string;
  try {
    real = fs.realpathSync.native ? fs.realpathSync.native(resolvido) : fs.realpathSync(resolvido);
  } catch {
    return { ok: false, motivo: `targetPath não existe/não é legível: ${resolvido}` };
  }
  if (!estaContido(raiz.real, real)) {
    return { ok: false, motivo: `realpath do target escapa do FIXTURE_ROOT: ${resolvido} -> ${real}` };
  }
  return { ok: true, motivo: `custom contido por léxico e realpath: ${real}` };
}

type Pedido = { id?: string; method: string; payload?: unknown };
type Resposta = { id: string; type: "response"; ok: boolean; result?: unknown; error?: string };
type ServicoAlvo = {
  handleRequest?: (r: Pedido) => Promise<Resposta>;
  quarantinePolicy?: string;
  scanManager?: { startScan?: (t: string, p?: string, o?: { readOnly?: boolean }) => Promise<string | null> };
};

/**
 * REGISTRO PRIVADO das instalações reais deste módulo.
 *
 * Porque existe: a prova anterior lia `String(startScan)` e procurava lá `readOnly`. Isso
 * media o TEXTO de uma função, não a sua origem — um wrapper escrito à mão por outro processo
 * (ou o wrapper do gate de um run diferente) satisfy a palavra e o `readOnly` deixava de ser
 * garantia. Aqui só conta a IDENTIDADE: a função que este módulo instalou, para a raiz que este
 * módulo validou. `WeakMap` porque o registo nunca pode sobreviver à instância nem servir de
 * canal entre runs.
 */
type InstalacaoGate = { wrapper: (...args: never[]) => unknown; raizReal: string };
const instalacoes = new WeakMap<object, InstalacaoGate>();

export interface ProvaGateFixture {
  montado: boolean;
  /** Símbolo, nunca caminho: as recusas do A4/D2 ecoam este texto para o log. */
  motivo: string;
}

/**
 * ÚNICA porta do «gate montado» — A4 (corpus de teste) e D2 (registo do cancelamento) chamam
 * este verificador; nenhum dos dois pode manter uma prova própria.
 */
export function gateDeFixtureMontadoPara(
  scanManager: unknown,
  env: NodeJS.ProcessEnv = process.env,
): ProvaGateFixture {
  if (!scanManager || (typeof scanManager !== "object" && typeof scanManager !== "function")) {
    return { montado: false, motivo: "sem scanManager" };
  }
  const registro = instalacoes.get(scanManager as object);
  if (!registro) return { montado: false, motivo: "nenhuma instalacao registada por este modulo" };
  const atual = (scanManager as { startScan?: unknown }).startScan;
  if (atual !== registro.wrapper) {
    return { montado: false, motivo: "startScan nao e o wrapper registado (removido, falso ou trocado)" };
  }
  let raiz: { root: string; real: string };
  try {
    raiz = fixtureRootFromEnv(env);
  } catch {
    return { montado: false, motivo: "a raiz de fixture do ambiente ja nao e valida" };
  }
  if (!mesmaCoisa(raiz.real, registro.raizReal)) {
    return { montado: false, motivo: "a raiz do ambiente nao e a raiz registada na instalacao" };
  }
  return { montado: true, motivo: "wrapper instalado por este modulo, para esta raiz, com readOnly forcado" };
}

const recusa = (pedido: Pedido | undefined, motivo: string, log: (l: string) => void): Resposta => {
  log(`[Service] gate recusou ${String(pedido?.method)}: ${motivo}`);
  return {
    id: String(pedido?.id ?? ""),
    type: "response",
    ok: false,
    error: `${GATE_CODE}: ${motivo}`,
  };
};

/**
 * Instala o gate no serviço acabado de construir. Devolve `false` quando a flag não
 * está ligada — nesse caso nada foi tocado.
 */
export function installDevFixtureGate(
  service: object,
  env: NodeJS.ProcessEnv = process.env,
  log: (linha: string) => void = (l) => console.log(l),
): boolean {
  if (env[FIXTURE_SCAN_FLAG] !== "1") return false;

  const raiz = fixtureRootFromEnv(env);
  const alvo = service as unknown as ServicoAlvo;

  if (typeof alvo.handleRequest !== "function") {
    throw new Error(`${GATE_CODE}: serviço sem handleRequest — o gate não pode ser provado, abortando o arranque`);
  }

  // readOnly EFECTIVO: forçado no ScanManager, não apenas declarado pelo driver.
  const sm = alvo.scanManager;
  const startScanOriginal = sm?.startScan?.bind(sm);
  if (typeof startScanOriginal !== "function") {
    throw new Error(`${GATE_CODE}: serviço sem scanManager.startScan — impossível forçar readOnly, abortando o arranque`);
  }
  sm!.startScan = ((type: string, target?: string, options?: { readOnly?: boolean }) =>
    startScanOriginal(type, target, { ...(options ?? {}), readOnly: true })) as never;
  // O registo é feito AQUI, por este módulo, com a função que acabámos de instalar e a raiz
  // que `fixtureRootFromEnv` validou. É a única fonte do `gateDeFixtureMontadoPara`.
  instalacoes.set(sm as unknown as object, {
    wrapper: sm!.startScan as unknown as (...args: never[]) => unknown,
    raizReal: raiz.real,
  });

  const politica = String(alvo.quarantinePolicy ?? "warn");
  log(
    `[Service] Gate de fixture MONTADO: só scan.start custom dentro de ${raiz.real}; ` +
      `readOnly FORÇADO no ScanManager; política de quarentena lida neste instante = ${politica} ` +
      `(a EFECTIVA é a que o bootstrap reporta depois de init())`,
  );

  const handleRequestOriginal = alvo.handleRequest.bind(alvo) as (r: Pedido) => Promise<Resposta>;
  alvo.handleRequest = async (request: Pedido): Promise<Resposta> => {
    const metodo = String(request?.method ?? "");
    if (!PERMITIDOS.has(metodo)) {
      return recusa(request, `"${metodo}" não faz parte da sessão de fixture (sem proteção, sem efeitos no sistema)`, log);
    }
    if (metodo === "scan.start") {
      const decisao = scanCustomContido(request.payload, raiz);
      if (!decisao.ok) return recusa(request, `scan.start: ${decisao.motivo}`, log);
      log(`[Service] gate aceitou scan.start — ${decisao.motivo}`);
    }
    return handleRequestOriginal(request);
  };
  return true;
}
