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
 *  7. IDENTIDADE EFECTIVA, ligada ao INSTANTE DO USO (TP-TOCTOU): a validação
 *    captura, para o alvo e para cada nó da sua subárvore, o par (dev, ino) lido
 *    por HANDLE (`open` + `fstat`, não só pelo caminho) e recusa nós sem
 *    identidade (`ino === 0n`) — nessa plataforma não há prova e o acesso
 *    dirigido fica bloqueado. O `ScanManager` re-verifica essa prova antes de
 *    cada entrega aos motores; divergência ⇒ falha fechada. O ScanManager
 *    mantém ainda uma lease Windows (fixture-pin.ts): GENERIC_READ com apenas
 *    FILE_SHARE_READ para os objectos e cadeia de ancestrais. A identidade é
 *    confirmada no handle já bloqueado e a lease só termina depois dos awaits
 *    dos motores; substituição, redirecionamento e escrita são recusados pelo SO.
 *    Sem suporte para locks, a análise de fixture falha fechada.
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
 *
 * Allowlist de LEITURAS (delta TP-PAP-SCANNER 28/10): além dos scan.*, a sessão de
 * fixture aceita também as leituras PURAS que a UI/Electron precisa para telemetria
 * e motores. Lista EXPLÍCITA e FECHADA (não um alias de qualquer módulo exportado):
 * protection.getState, protectionIntent.get, events.list, threats.list,
 * processes.list, connections.list, quarantine.list, pcstate.get, hardware.snapshot,
 * windows.healthSnapshot, usb.getState e exclusions.get. Um futuro método novo da
 * fila/do serviço NÃO amplia este perfil automaticamente. Nenhuma MUTAÇÃO entra
 * aqui: monitor.*, quarantine.restore/delete, process.killTree, trust.*,
 * exclusions.update, definitions.update, events.clear, usb.configure/scan/cancel,
 * scan.fullSystem, scan.artifact, analysis.restricted, process.analyze e
 * protectionIntent.setOptIn continuam recusados (negativos preservados).
 */
const PERMITIDOS = new Set<string>([
  "scan.start",
  "scan.cancel",
  "scan.getActive",
  "scan.getLast",
  "scan.history",
]);

/** Leituras puras da sessão de fixture: lista literal fechada (sem mutações). */
const LEITURAS = new Set<string>([
  "protection.getState",
  "protectionIntent.get",
  "events.list",
  "threats.list",
  "processes.list",
  "connections.list",
  "quarantine.list",
  "pcstate.get",
  "hardware.snapshot",
  "windows.healthSnapshot",
  "usb.getState",
  "exclusions.get",
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

// ── Identidade efectiva (TP-TOCTOU) ─────────────────────────────────────────

/** Chave de caminho normalizada (Windows não distingue maiúsculas). */
const chaveDe = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);

/**
 * Identidade EFECTIVA de um nó. `dev`+`ino` são o par (volume, file index) que
 * distingue "o mesmo objecto" de "outro objecto no mesmo caminho" depois de um
 * rename, de um junction ou de uma recriação.
 *
 * Em Windows a identidade é lida por HANDLE (`open` + `fstat`): mede-se o
 * objecto que a abertura efectivou, não o caminho. `ino === 0n` significa que a
 * plataforma não deu identidade — nesse caso devolve `null` e o alvo é
 * recusado (fail-closed): sem prova, não há sessão.
 */
export interface IdentidadeNo {
  dev: bigint;
  ino: bigint;
  tipo: "dir" | "file";
  nlink: bigint;
  size: bigint;
  mtimeMs: bigint;
}

export function identidadeDeNo(absoluto: string): IdentidadeNo | null {
  let l: fs.Stats;
  try {
    l = fs.lstatSync(absoluto);
  } catch {
    return null;
  }
  if (l.isSymbolicLink()) return null; // reparse point não é identidade de conteúdo
  if (!l.isDirectory() && !l.isFile()) return null;

  let st: fs.BigIntStats;
  if (process.platform === "win32") {
    let fd: number | null = null;
    try {
      fd = fs.openSync(absoluto, "r");
      st = fs.fstatSync(fd, { bigint: true });
    } catch {
      return null;
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // fechar o handle nunca pode transformar uma medição válida em inválida
        }
      }
    }
  } else {
    try {
      st = fs.lstatSync(absoluto, { bigint: true });
    } catch {
      return null;
    }
  }
  if (st.ino === 0n) return null;
  return {
    dev: st.dev,
    ino: st.ino,
    tipo: st.isDirectory() ? "dir" : "file",
    nlink: st.nlink,
    size: st.size,
    mtimeMs: st.mtimeMs,
  };
}

/**
 * Prova de identidade do alvo validado: a raiz, o alvo e TODOS os nós da sua
 * subárvore, com a identidade efectiva de cada um no instante da validação.
 */
export interface SnapshotFixture {
  raizReal: string;
  alvo: string;
  nos: Map<string, IdentidadeNo>;
}

/**
 * Captura a prova. Recusa qualquer reparse/hardlink, nó sem identidade efectiva
 * ou ancestral que não seja diretório — a mesma postura fail-closed da validação.
 */
function criarSnapshot(raiz: string, alvo: string): { snapshot: SnapshotFixture | null; motivo: string | null } {
  const nos = new Map<string, IdentidadeNo>();
  try {
    let atual = raiz;
    const cadeia = [raiz];
    for (const parte of path.relative(raiz, alvo).split(/[\\/]+/).filter(Boolean)) {
      atual = path.join(atual, parte);
      cadeia.push(atual);
    }
    for (const no of cadeia) {
      const id = identidadeDeNo(no);
      if (!id) return { snapshot: null, motivo: `target contém link/junction ou nó sem identidade efectiva: ${no}` };
      if (no !== alvo && id.tipo !== "dir") return { snapshot: null, motivo: `ancestral não é diretório: ${no}` };
      if (id.tipo === "file" && id.nlink !== 1n) return { snapshot: null, motivo: `fixture contém link ou hardlink: ${no}` };
      nos.set(chaveDe(path.resolve(no)), id);
    }
    const pendentes = [alvo];
    while (pendentes.length) {
      const item = pendentes.pop()!;
      const id = identidadeDeNo(item);
      if (!id) return { snapshot: null, motivo: `fixture contém link/junction ou nó sem identidade efectiva: ${item}` };
      if (id.tipo === "file" && id.nlink !== 1n) return { snapshot: null, motivo: `fixture contém link ou hardlink: ${item}` };
      nos.set(chaveDe(path.resolve(item)), id);
      if (id.tipo === "dir") for (const nome of fs.readdirSync(item)) pendentes.push(path.join(item, nome));
    }
  } catch {
    return { snapshot: null, motivo: "fixture não pôde ser verificada sem links" };
  }
  return { snapshot: { raizReal: raiz, alvo, nos }, motivo: null };
}

// ── Registo da prova e re-verificação no momento do uso ─────────────────────

const snapshotsValidados = new Map<string, SnapshotFixture>();

/** Único escritor: o wrapper do gate, depois de `scanCustomContido` aceitar. */
export function registarSnapshotValidado(snapshot: SnapshotFixture): void {
  snapshotsValidados.set(chaveDe(path.resolve(snapshot.alvo)), snapshot);
}

/**
 * Prova registada para este alvo, ou `null`. Isto NÃO valida nada por si: quem
 * a usa tem de a re-verificar (`identidadeAindaBate` / `alvoAindaIntacto`) no
 * instante do uso — é essa re-verificação que fecha a substituição pós-validação.
 */
export function obterSnapshotValidado(alvo: string): SnapshotFixture | null {
  return snapshotsValidados.get(chaveDe(path.resolve(alvo))) ?? null;
}

/**
 * O caminho ainda é, com identidade efectiva, o nó capturado na validação?
 * `null` = sim; caso contrário, o motivo (NUNCA com caminhos — vai para estado).
 */
export function identidadeAindaBate(snapshot: SnapshotFixture, caminho: string): string | null {
  const esperado = snapshot.nos.get(chaveDe(path.resolve(caminho)));
  if (!esperado) return "caminho que não faz parte do corpus validado";
  const atual = identidadeDeNo(caminho);
  if (!atual) return "nó com reparse ou sem identidade efectiva";
  if (atual.tipo !== esperado.tipo || atual.dev !== esperado.dev || atual.ino !== esperado.ino) {
    return "objecto diferente do validado no mesmo caminho";
  }
  if (esperado.tipo === "file") {
    if (atual.nlink !== 1n) return "ficheiro passou a ter hardlink";
    if (atual.size !== esperado.size || atual.mtimeMs !== esperado.mtimeMs) {
      return "conteúdo mudou desde a validação";
    }
  }
  return null;
}

/** A cadeia raiz→alvo continua exactamente a que foi validada? */
export function alvoAindaIntacto(snapshot: SnapshotFixture): string | null {
  let atual = snapshot.raizReal;
  const cadeia = [atual];
  for (const parte of path.relative(snapshot.raizReal, snapshot.alvo).split(/[\\/]+/).filter(Boolean)) {
    atual = path.join(atual, parte);
    cadeia.push(atual);
  }
  for (const no of cadeia) {
    const motivo = identidadeAindaBate(snapshot, no);
    if (motivo) return `o alvo deixou de ser o corpus validado (${motivo})`;
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
): { ok: boolean; motivo: string; snapshot?: SnapshotFixture } {
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
  // A verificação por realpath não recusa links que apontam de volta para a
  // própria raiz. Na sessão de fixture recusam-se links/hardlinks — e captura-se,
  // na mesma passagem, a identidade EFECTIVA de cada nó (a prova do TP-TOCTOU).
  const captura = criarSnapshot(raiz.root, resolvido);
  if (captura.snapshot === null) {
    return { ok: false, motivo: captura.motivo ?? "snapshot de identidade impossível" };
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
  return { ok: true, motivo: `custom contido por léxico e realpath: ${real}`, snapshot: captura.snapshot };
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
    `[Service] Gate de fixture MONTADO: só scan.start custom dentro de ${raiz.real} ` +
      `+ leituras puras da UI (${[...LEITURAS].sort().join(", ")}); ` +
      `readOnly FORÇADO no ScanManager; política de quarentena lida neste instante = ${politica} ` +
      `(a EFECTIVA é a que o bootstrap reporta depois de init())`,
  );

  const handleRequestOriginal = alvo.handleRequest.bind(alvo) as (r: Pedido) => Promise<Resposta>;
  alvo.handleRequest = async (request: Pedido): Promise<Resposta> => {
    const metodo = String(request?.method ?? "");
    if (!PERMITIDOS.has(metodo) && !LEITURAS.has(metodo)) {
      return recusa(request, `"${metodo}" não faz parte da sessão de fixture (sem proteção, sem efeitos no sistema)`, log);
    }
    if (metodo === "scan.start") {
      const decisao = scanCustomContido(request.payload, raiz);
      if (!decisao.ok) return recusa(request, `scan.start: ${decisao.motivo}`, log);
      // Prova de identidade registada PARA ESTE alvo: é ela que o ScanManager
      // re-verifica antes de entregar seja o que for aos motores.
      if (decisao.snapshot) registarSnapshotValidado(decisao.snapshot);
      log(`[Service] gate aceitou scan.start — ${decisao.motivo}`);
    }
    return handleRequestOriginal(request);
  };
  return true;
}
