import * as fs from "node:fs";
import * as path from "node:path";

/**
 * FILHO DO WATCHER — vigilância de ficheiros em processo separado.
 *
 * 15/10 (P0 GUI-TEST-18): a primitiva passou de chokidar para `fs.watch(recursive)`.
 * Motivo MEDIDO, não preferência: o chokidar no Windows abre um handle por
 * diretório e descobre esses diretórios com um `readdir` recursivo ANTES de emitir
 * `ready`. Nas 6 raízes default deste perfil isso são 487 404 entradas / 122 982
 * diretórios e 11,4 s (quente) a 32,1 s (frio) de enumeração — sempre acima do
 * orçamento de 10 000 ms do pai, que por isso rebentava com
 * "Watcher startup timed out" e deixava a proteção OFF num Windows real.
 * `fs.watch(recursive)` no Windows usa UMA vigilância de subárea por raiz e não
 * enumera nada para começar a vigiar: o `ready` passa a significar "o sistema
 * operacional já vigia estas raízes", que é exatamente a garantia de que a
 * ativação precisa.
 *
 * O que NÃO mudou: o protocolo de mensagens (`started`/`ready`/`add`/`change`/
 * `unlink`/`error`), os filtros de ignorados (mesmos padrões, incluindo as
 * extensões de transferência parcial D4) e a janela de quietude de 3000 ms — o
 * mesmo `stabilityThreshold` que o chokidar tinha, para não passar a analisar
 * ficheiros a meio da escrita.
 *
 * Ganho lateral honesto: com o modelo antigo, `ignoreInitial: true` fazia um
 * ficheiro criado dentro de uma pasta AINDA NÃO VARREDA ser tratado como inicial
 * e NUNCA emitir `add` (era o buraco que `recovery-watcher-readiness.test.js`
 * pinta). Aqui não há varredura inicial: o kernel vigia a subárea, incluindo
 * pastas criadas depois do arranque.
 */

/** Mesmos padrões do `ignored` do chokidar (D4 incluído de propósito: não é allowlist por extensão). */
const IGNORADOS: readonly RegExp[] = [
  /(^|[\/\\])\../,
  /node_modules/,
  /\.log$/i,
  /cybersafe-assistant[\/\\]logs/,
  /cybersafe-(zip|scanner|temp|probe)/i,
  /\.(part|crdownload|partial|tmp)$/i,
];

/** Quieta durante este tempo antes de emitir — equivalência ao stabilityThreshold anterior. */
const QUIETUDE_MS = 3000;

/** Teto do registo de "já visto": um serviço de longa vida não pode crescer sem limite. */
const MAX_VISTOS = 50_000;

const vigias = new Map<string, fs.FSWatcher>();
const quietos = new Map<string, NodeJS.Timeout>();
const vistos = new Set<string>();
/** Última verificação de existência por raiz — no máximo 1 stat/raiz/segundo. */
const ultimaChecagemRaiz = new Map<string, number>();
/**
 * Perda POR RAIZ: `{total, avisados, ultimoAviso}`. O contador era um só global,
 * por isso a segunda raiz a transbordar ficava calada atrás do throttle da
 * primeira; e o valor enviado era sempre o total acumulado, que o motor somava a
 * cada notificação (medido na C5: 17 notificações a inflar um número só).
 */
const perdasPorRaiz = new Map<string, { total: number; avisados: number; ultimoAviso: number }>();
let stopping = false;

function send(message: object): void {
  if (process.connected) process.send?.(message, () => undefined);
}

/**
 * Lacuna de cobertura POSSÍVEL, sempre dita ao pai — com `novos` (delta desde o
 * último aviso desta raiz) e `total`.
 *
 * O que o sinal é e o que não é (revisão de arquitetura, 15/10): o Node não
 * garante `filename` mesmo em Windows, por isso um callback sem nome é uma
 * LACUNA DE COBERTURA POSSÍVEL — não prova de transbordo da fila do
 * ReadDirectoryChangesW, cuja prova é `lpBytesReturned` a zero e não é exposta
 * aqui pelo Node. Conta-se NOTIFICAÇÕES SEM NOME; a quantidade de ficheiros
 * afetados é DESCONHECIDA e diz-se que é desconhecida. O valor legível
 * `motivo: "overflow"` mantém-se por compatibilidade de contrato, mas é uma
 * INFERÊNCIA, não uma medição.
 */
function reportarPerda(motivo: "overflow" | "raiz-desaparecida", raiz: string, mensagem: string): void {
  const estado = perdasPorRaiz.get(raiz) ?? { total: 0, avisados: 0, ultimoAviso: 0 };
  const agora = Date.now();
  const novos = Math.max(0, estado.total - estado.avisados);
  if (motivo === "overflow") {
    // Throttle POR RAIZ: uma raiz a arder não tapa outra.
    if (agora - estado.ultimoAviso < 5000) {
      perdasPorRaiz.set(raiz, estado);
      return;
    }
  }
  if (novos === 0 && motivo === "overflow") {
    perdasPorRaiz.set(raiz, estado);
    return;
  }
  perdasPorRaiz.set(raiz, {
    ...estado,
    avisados: estado.total,
    ultimoAviso: agora,
  });
  send({ type: "gap", motivo, path: raiz, novos: motivo === "overflow" ? novos : 0, total: estado.total, message: mensagem });
}

/** Callback sem nome de ficheiro: contar por raiz, avisar, nunca calar — sem prometer o que ele não diz. */
function receberEvento(raiz: string, filename: string | Buffer | null): void {
  if (stopping) return;
  if (filename === null || filename === undefined || filename === "") {
    const estado = perdasPorRaiz.get(raiz) ?? { total: 0, avisados: 0, ultimoAviso: 0 };
    estado.total += 1;
    perdasPorRaiz.set(raiz, estado);
    reportarPerda(
      "overflow",
      raiz,
      `chegaram ${estado.total} notificações de vigilância sem nome de ficheiro em ${raiz}; pode haver ficheiros por ver e o Windows não indica quantos`,
    );
    return;
  }
  const absoluto = path.resolve(raiz, filename.toString());
  if (ignorado(absoluto)) return;
  garantirRaizViva(raiz);
  agendar(absoluto);
}

/**
 * Uma raiz apagada em runtime não emite `close` nem `error` — medido: só uma
 * inundação de `rename` dos caminhos que eram dela. Sem verificação, o pai fica
 * com um `ready` a dizer que vigia uma pasta que já não existe. O verificador é
 * disparado pelos próprios eventos e limitado a 1 `stat` por raiz por segundo.
 */
function garantirRaizViva(raiz: string): void {
  const agora = Date.now();
  if (agora - (ultimaChecagemRaiz.get(raiz) ?? 0) < 1000) return;
  ultimaChecagemRaiz.set(raiz, agora);
  fs.stat(raiz, (erro) => {
    if (stopping || !erro) return;
    const w = vigias.get(raiz);
    if (!w) return;
    vigias.delete(raiz);
    try {
      w.close();
    } catch {
      /* já fechada */
    }
    reportarPerda(
      "raiz-desaparecida",
      raiz,
      `${raiz} deixou de existir — essa pasta já não está vigiada; a proteção continua ativa nas restantes`,
    );
  });
}

function ignorado(absoluto: string): boolean {
  for (const padrao of IGNORADOS) if (padrao.test(absoluto)) return true;
  return false;
}

function classificar(absoluto: string): void {
  if (stopping) return;
  fs.stat(absoluto, (erro: NodeJS.ErrnoException | null, estatus: fs.Stats | undefined) => {
    if (stopping) return;
    if (estatus?.isFile()) {
      const tipo = vistos.has(absoluto) ? "change" : "add";
      if (vistos.size >= MAX_VISTOS) vistos.clear();
      vistos.add(absoluto);
      send({ type: tipo, path: absoluto });
      return;
    }
    if (erro || !estatus?.isDirectory()) {
      // Desapareceu (unlink/renomeado para fora): só interessa se o tínhamos visto.
      if (vistos.delete(absoluto)) send({ type: "unlink", path: absoluto });
    }
    // Pastas não são emitidas: o que se analisa são ficheiros.
  });
}

function agendar(absoluto: string): void {
  const marcado = quietos.get(absoluto);
  if (marcado) clearTimeout(marcado);
  quietos.set(
    absoluto,
    setTimeout(() => {
      quietos.delete(absoluto);
      classificar(absoluto);
    }, QUIETUDE_MS),
  );
}

function parar(): void {
  if (stopping) return;
  stopping = true;
  for (const t of quietos.values()) clearTimeout(t);
  quietos.clear();
  for (const w of vigias.values()) {
    try {
      w.close();
    } catch {
      /* já fechado */
    }
  }
  vigias.clear();
  process.exit(0);
}

function vigiar(raizes: string[]): void {
  const falhas: { path: string; message: string }[] = [];
  for (const raiz of raizes) {
    try {
      const w = fs.watch(raiz, { recursive: true }, (_evento: string, filename: string | Buffer | null) => {
        receberEvento(raiz, filename);
      });
      w.on("error", (erro: NodeJS.ErrnoException) => {
        send({ type: "error", message: erro.message, code: erro.code, path: raiz });
      });
      w.on("close", () => {
        if (vigias.get(raiz) === w) vigias.delete(raiz);
      });
      vigias.set(raiz, w);
    } catch (erro) {
      falhas.push({ path: raiz, message: (erro as Error).message });
    }
  }

  if (vigias.size === 0) {
    // Nada attachado = proteção não existe. O pai trata isto como falha fatal.
    send({
      type: "error",
      message: `nenhuma raiz ficou vigiada — ${falhas.map((f) => `${f.path}: ${f.message}`).join(" | ") || "sem raizes pedidas"}`,
      code: "ENOVIGILAR",
    });
    return;
  }

  send({ type: "started", raizes: vigias.size });
  // `ready` = o SO já vigia as raízes. Com esta primitiva não há enumeração
  // pendente atrás deste sinal: o que se vê a seguir é o que acontece.
  //
  // `falhas` viaja DENTRO do `ready`, não como mensagem à parte: foi assim que o
  // OpenCode apanhou a mentira. O pai não subscreve `ready` por fora, então um
  // aviso solto morria no evento, e `getMonitoredPaths()` continuava a devolver
  // as raízes que nunca attacharam — a UI afirmava vigiar caminhos inexistentes.
  // Ao vir no mesmo payload, o pai regista a degradação ANTES de resolver.
  send({
    type: "ready",
    raizes: vigias.size,
    falhas,
    ...(falhas.length
      ? { aviso: `${falhas.length} raízes não ficaram vigiadas: ${falhas.map((f) => f.path).join(", ")}` }
      : {}),
  });
}

process.on("disconnect", () => {
  void parar();
});
process.on("SIGTERM", () => {
  void parar();
});
process.on("message", (raw: unknown) => {
  const message = raw as { type?: string; paths?: string[] };
  if (message.type === "stop") {
    void parar();
    return;
  }
  if (message.type !== "start" || stopping || vigias.size > 0 || !Array.isArray(message.paths)) return;
  vigiar(message.paths);
});
