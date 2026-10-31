/**
 * Isolamento do arranque do api — falha fechada, sem I/O.
 *
 * Ameaça (secpriv): um api em DEV, só por importar `db.ts`, criava
 * `%USERPROFILE%\.cybersafe-service\` e abria a base de dados REAL; `index.ts` escrevia logo o
 * registo de `startup` no log de ciclo de vida ao lado dessa base; e a porta por omissão é 4000,
 * a da instalação. A entrada não é dados do utilizador — é a AUSÊNCIA de configuração. O raio de
 * impacto é a conta real do utilizador e o serviço instalado.
 *
 * Invariantes (revisões Codex de 2026-10-20, 1ª e 2ª passagem):
 * 1. PRODUÇÃO É DITA: só `NODE_ENV=production` declara produção — nunca inferida de `.js`/`dist`
 *    nem de ambiente ausente. É literalmente o que o instalador faz
 *    (`desktop/src/api-lifecycle.ts:177-184`, que apaga `CYBERSAFE_DB_PATH`, pone `NODE_ENV` e dá
 *    porta e DB próprias). Qualquer outro estado recusa.
 * 2. O MARCADOR DEV NÃO PODE SER DESLIGADO por `NODE_ENV=production`: `CYBERSAFE_DEV_ISOLATION=1`
 *    tem precedência, e os dois juntos são CONFLITO → recusa. Um env que desativasse o isolamento
 *    com uma linha seria o mesmo bug com outra roupa.
 * 3. A RAIZ DEV tem de ser DEDICADA e dentro do TEMP real: `TEMP` inteiro, `HOME`, uma drive ou
 *    qualquer caminho fora de TEMP não são "raiz de teste" — eram o jeito fácil de a guarda
 *    aprovar o perfil do utilizador sem o nomear.
 * 4. A cadeia validada vai até ao FICHEIRO da DB (uma junction em `raiz/api` escapava), e um
 *    `lstat` que falha só conta como "não existe" se for ENOENT/ENOTDIR. `EACCES`/`EPERM`/erro
 *    desconhecido recusa: incógnito não é seguro.
 *
 * Módulo puro: apenas leituras (`lstat`/`realpath`/`exists`). Não cria pastas, não abre bases de
 * dados, não escreve logs, não faz listen — quem chama é que o faz, depois disto devolver.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PRODUCTION_API_PORT = 4000;
export const DEV_API_PORT_FLOOR = 4100;
export const ERRO_ISOLAMENTO = "CYBERSAFE_ISOLAMENTO_RECUSADO";

export type ModoApi = "producao" | "dev" | "conflito" | "nao_declarado";

export interface PerfilModo {
  modo: ModoApi;
  motivo: string;
}

/** Caminho da base de dados pessoal — o que uma corrida DEV nunca pode abrir. */
export function dbPessoalApi(): string {
  return path.join(os.homedir(), ".cybersafe-service", "cybersafe.db");
}

export function identificarModo(opts: { entrypoint: string; env: NodeJS.ProcessEnv }): PerfilModo {
  const env = opts.env ?? {};
  const entrada = String(opts.entrypoint ?? "");
  const noEnv = String(env.NODE_ENV ?? "").trim().toLowerCase();
  const marcadoDev = env.CYBERSAFE_DEV_ISOLATION === "1";
  const ditoProducao = noEnv === "production";

  if (marcadoDev && ditoProducao)
    return { modo: "conflito", motivo: "CYBERSAFE_DEV_ISOLATION=1 e NODE_ENV=production ao mesmo tempo" };
  if (marcadoDev) return { modo: "dev", motivo: "CYBERSAFE_DEV_ISOLATION=1" };
  if (ditoProducao) return { modo: "producao", motivo: 'NODE_ENV="production" explícito' };
  if (noEnv === "development") return { modo: "dev", motivo: 'NODE_ENV="development"' };
  // Entrada em código-fonte é o caso perigoso do `npm run dev` (tsx), e não tem qualquer var.
  if (/\.ts$/i.test(entrada)) return { modo: "dev", motivo: "executado a partir do código-fonte (tsx)" };
  return { modo: "nao_declarado", motivo: noEnv ? `NODE_ENV="${noEnv}" não declara modo` : "sem NODE_ENV nem marcador de isolamento" };
}

/** Seam de leitura: é assim que um teste prova que nada foi escrito antes da recusa. */
export interface FsLeitura {
  existsSync(p: string): boolean;
  lstatSync(p: string): { isSymbolicLink(): boolean };
  realpathSync(p: string): string;
}

export interface ResultadoArranque {
  modo: "producao" | "dev";
  dbPath: string;
  porta: number;
  raizDev?: string;
}

function recusar(de: string): never {
  const e = new Error(`ISOLAMENTO RECUSADO: ${de}. Nada foi criado, aberto, escrito ou escutado.`);
  (e as Error & { code?: string }).code = ERRO_ISOLAMENTO;
  throw e;
}

/** Todos os níveis de um caminho absoluto, do fundo para o topo (incluindo o próprio alvo). */
function ancestraisAlvo(alvo: string): string[] {
  const raiz = path.parse(alvo).root;
  const partes = path.relative(raiz, alvo).split(path.sep).filter(Boolean);
  const niveis = [raiz];
  for (const parte of partes) niveis.push(path.join(niveis[niveis.length - 1], parte));
  return niveis;
}

/** Só estes códigos significam "o nível ainda não existe". O resto é incógnito, e incógnito recusa. */
function efectivamenteInexistente(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Lê cada nível da cadeia rejeitando link/reparse, e exige que o `realpath` do ancestral
 * existente mais fundo continue dentro da raiz real. Os níveis por baixo ainda não existem à hora
 * da validação (quem os cria é o `mkdir` posterior) e um nível inexistente não pode ser junction.
 */
function cadeiaSegura(alvo: string, f: FsLeitura, raizReal: string, rotulo: string, ateFile: boolean): void {
  const niveis = ancestraisAlvo(alvo);
  const considerados = ateFile ? niveis : niveis.slice(0, -1);
  for (const nivel of considerados) {
    let st: { isSymbolicLink(): boolean } | null;
    try {
      st = f.lstatSync(nivel);
    } catch (e) {
      if (!efectivamenteInexistente(e))
        recusar(`${rotulo}: lstat(${nivel}) falhou com ${(e as { code?: string })?.code ?? "erro desconhecido"} — ilegível não é seguro`);
      st = null;
    }
    if (st && st.isSymbolicLink()) recusar(`${rotulo} tem um ancestral link/junction em ${nivel}`);
  }
  const dirAlvo = path.resolve(ateFile ? path.dirname(alvo) : alvo);
  let existente = dirAlvo;
  while (!f.existsSync(existente)) {
    const acima = path.dirname(existente);
    if (acima === existente) break;
    existente = acima;
  }
  const dirReal = path.resolve(f.realpathSync(existente));
  const dentro = path.relative(raizReal, dirReal);
  if (dentro.startsWith("..") || path.isAbsolute(dentro))
    recusar(`${rotulo} resolve para fora da raiz DEV (${dirReal})`);
}

function portaValida(bruto: string | undefined): number {
  const texto = String(bruto ?? "").trim();
  if (!/^\d+$/.test(texto)) recusar(`CYBERSAFE_API_PORT="${bruto ?? ""}" não é um número de porta`);
  const porta = Number(texto);
  if (porta < 1 || porta > 65535) recusar(`porta ${porta} fora do intervalo válido`);
  return porta;
}

/**
 * Valida o arranque ANTES do primeiro `mkdir`, `new Database`, escrita de lifecycle ou `listen`.
 * Produção explícita devolve exatamente o que devolve hoje; DEV exige raiz dedicada dentro do
 * TEMP real, DB contida nessa raiz ao longo de toda a cadeia, e porta isolada.
 */
export function validarArranqueApi(opts: {
  entrypoint: string;
  env: NodeJS.ProcessEnv;
  fsLike?: FsLeitura;
}): ResultadoArranque {
  const env = opts.env ?? {};
  const f: FsLeitura = (opts.fsLike ?? fs) as FsLeitura;
  const perfil = identificarModo({ entrypoint: opts.entrypoint, env });

  if (perfil.modo === "conflito") recusar(perfil.motivo);
  if (perfil.modo === "nao_declarado")
    recusar(`modo não declarado (${perfil.motivo}) — diz NODE_ENV="production" ou CYBERSAFE_DEV_ISOLATION=1`);

  if (perfil.modo === "producao") {
    const explicita = String(env.CYBERSAFE_DB_PATH ?? "").trim();
    return {
      modo: "producao",
      dbPath: explicita ? path.resolve(explicita) : dbPessoalApi(),
      porta: env.CYBERSAFE_API_PORT ? portaValida(env.CYBERSAFE_API_PORT) : PRODUCTION_API_PORT,
    };
  }

  // ---------------- DEV: peça em falta ou discordante = recusa, sem I/O ----------------
  const brutoRaiz = String(env.CYBERSAFE_DEV_ROOT ?? "").trim();
  if (!brutoRaiz) recusar("DEV sem CYBERSAFE_DEV_ROOT (a raiz isolada tem de ser declarada)");
  if (!path.isAbsolute(brutoRaiz)) recusar(`CYBERSAFE_DEV_ROOT="${brutoRaiz}" não é absoluta`);
  const raiz = path.resolve(brutoRaiz);
  if (!f.existsSync(raiz)) recusar(`CYBERSAFE_DEV_ROOT não existe: ${raiz}`);
  const raizReal = path.resolve(f.realpathSync(raiz));
  if (raizReal !== raiz) recusar(`realpath(CYBERSAFE_DEV_ROOT) ≠ caminho léxico (${raiz})`);
  cadeiaSegura(raiz, f, raizReal, "raiz DEV", false);

  // Raiz DEDICADA: dentro do TEMP real e não é o TEMP inteiro. Isto fecha o atalho de usar
  // HOME, uma drive ou o próprio TEMP como "raiz de teste", que reaparecia como I/O pessoal.
  const tempReal = path.resolve(f.realpathSync(os.tmpdir()));
  const doLadoTemp = path.relative(tempReal, raizReal);
  if (!doLadoTemp) recusar(`raiz DEV é o TEMP inteiro (${raizReal}); tem de ser um diretório dedicado`);
  if (doLadoTemp.startsWith("..") || path.isAbsolute(doLadoTemp))
    recusar(`raiz DEV fora do TEMP real (${raizReal}, TEMP=${tempReal}) — HOME/drive/qualquer caminho não são raiz aprovada`);
  if (path.parse(raizReal).root === raizReal) recusar(`raiz DEV é uma drive inteira (${raizReal})`);

  const brutoDb = String(env.CYBERSAFE_DB_PATH ?? "").trim();
  if (!brutoDb) recusar("DEV sem CYBERSAFE_DB_PATH (a base de dados por omissão é a pessoal)");
  if (!path.isAbsolute(brutoDb)) recusar(`CYBERSAFE_DB_PATH="${brutoDb}" não é absoluta`);
  const dbPath = path.resolve(brutoDb);
  if (dbPath === dbPessoalApi()) recusar("DEV a apontar para a DB pessoal do utilizador");
  const relativo = path.relative(raizReal, dbPath);
  if (!relativo || relativo.startsWith("..") || path.isAbsolute(relativo))
    recusar(`CYBERSAFE_DB_PATH fora da raiz DEV ${raizReal} (recebido ${dbPath})`);
  // A cadeia até ao FICHEIRO, não só até à raiz: é o que fecha a junction interior e o próprio
  // ficheiro ser um link para fora.
  cadeiaSegura(dbPath, f, raizReal, "CYBERSAFE_DB_PATH", true);

  if (!String(env.CYBERSAFE_API_PORT ?? "").trim())
    recusar("DEV sem CYBERSAFE_API_PORT (sem ela o api cairia na porta 4000 da instalação)");
  const porta = portaValida(env.CYBERSAFE_API_PORT);
  if (porta === PRODUCTION_API_PORT) recusar("DEV a pedir a porta 4000, que pertence à instalação");
  if (porta < DEV_API_PORT_FLOOR) recusar(`porta ${porta} abaixo do piso DEV ${DEV_API_PORT_FLOOR}`);

  return { modo: "dev", dbPath, porta, raizDev: raizReal };
}
