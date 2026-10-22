/**
 * TP-A4-FINAL-20261020 — corpus YARA de TESTE para a sessão controlada do Scanner.
 *
 * AMEAÇA QUE ISTO FECHA (uma frase): um valor de ambiente escrito por engano, ou por um
 * processo com acesso ao utilizador, faz o motor de deteção carregar regras que não são as
 * de produção — e a app continua a dizer «protegido» com um corpus inventado. Em alternativa,
 * um teste «positivo» pode ser satisfeito por um ficheiro que o motor nunca viu.
 *
 * Por isso este módulo NÃO é um `if (env)`. Produzir um corpus diferente exige, em conjunto:
 *   1. `NODE_ENV=development` explícito — `production` recusa mesmo com todas as outras flags,
 *      porque uma imagem empacotada não tem nada a procura um corpus de ferramenta.
 *   2. `CYBERSAFE_DEV_ISOLATION=1` e a raiz de DEV VERIFICADA (absoluta, existe, sem reparse em
 *      nenhum ancestral, `realpath` igual ao caminho léxico, strict descendant da base temporária,
 *      nunca o TEMP genérico / perfil / volume). Não se aceita a *declaração* de isolamento.
 *   3. Perfis do run (service dir e userData) CONTIDOS nessa raiz, e pipe do run isolado.
 *   4. A sessão de fixture montada com a validação REAL do produto — `installDevFixtureGate` /
 *      `fixtureRootFromEnv` / `estaContido`, que já provam contenção por `path.relative`,
 *      `realpath` e proibição de reparse. A prova de que o `readOnly` está EFETIVAMENTE forçado
 *      é a IDENTIDADE do wrapper: só a função que `dev-fixture-gate` instalou, registada por ele
 *      próprio para a raiz que validou, conta (`gateDeFixtureMontadoPara`). Ler o texto da função
 *      à procura de «readOnly» não provaria nada — um wrapper escrito à mão satisivia a palavra.
 *      O A4 e o D2 usam exatamente este verificador; nenhum mantém prova própria.
 *   5. O caminho do corpus validado ANTES de qualquer load: absoluto, dentro da raiz de DEV,
 *      FORA do diretório de definições de produção, ficheiro regular sem reparse, tamanho
 *      limitado, a ler-se; e o CONTEÚDO é o canónico, byte a byte e por digest (forma certa —
 *      uma regra, nome revirado, sem `include` — não é identidade, e não fecharia uma segunda
 *      regra escondida). A sonda de YARA real incide sobre esses mesmos bytes e faz-se 1
 *      positivo e 0 falsos, com o caminho re-verificado depois da sonda.
 *
 * Sem o ambiente: o comportamento é byte a byte o de hoje e este módulo não acede ao disco.
 * Com o ambiente inválido: recusa com código estável, e o `engine.ts` propaga — a mesma regra
 * do gate de fixture («config inválida ⇒ zero sessão»), porque uma deteção silenciosamente
 * trocada é pior do que não arrancar.
 *
 * O que este módulo NÃO faz: não altera o corpus de produção, não instala regras, não toca em
 * antivírus nem em exclusões, não promove cobertura (o motor continua a reportar a assinatura
 * de teste como o que é), e não adiciona dependências.
 */
import * as realFs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { estaContido, fixtureRootFromEnv, gateDeFixtureMontadoPara, FIXTURE_SCAN_FLAG } from "./dev-fixture-gate.js";

/** Nome da variável. Não há valor default: a ausência É o modo de produção. */
export const DEV_TEST_YARA_ENV = "CYBERSAFE_DEV_TEST_YARA_PATH";
export const DEV_TEST_YARA_CODE = "dev_test_yara";
/** Único nome de regra aceite — o corpus de ferramenta é revirado, não escolhido ao acaso. */
export const DEV_TEST_YARA_REGRA = "CyberSafe_DevTest_Canary";
/** Literal inofensivo já usado nos testes do serviço; não é malware nem EICAR. */
export const DEV_TEST_YARA_MARCA = "CYBERSAFE-E2E-TEST-SIGNATURE-v1";
/** Um ficheiro de uma regra não é uma base de assinaturas: 8 KiB chega e limita o abuse. */
export const DEV_TEST_YARA_MAX_BYTES = 8192;

/**
 * O corpus CANÓNICO, byte a byte (LF, com nova linha final).
 *
 * Porque existe: «uma regra, o nome certo, sem include» é uma forma, não uma identidade. Com
 * essa validação sozinha, um ficheiro que mantivesse a forma e alterasse o literal — ou que
 * acrescentasse uma segunda regra escondida num bloco de comentário que o parser ainda lê —
 * seria aceite e o «positivo» do teste passaria a significar outra coisa. Daí o pin: os bytes
 * têm de coincidir exatamente com esta constante, que é a única regra de teste aprovada, sem
 * `cybersafe_evidence = "strong"` (ou seja: o motor reporta a deteção como `high`/`generic`,
 * nunca como evidência forte de produção).
 */
export const DEV_TEST_YARA_CANONICO =
  "rule CyberSafe_DevTest_Canary\n" +
  "{\n" +
  "  meta:\n" +
  '    cybersafe_scope = "dev-fixture-session-only"\n' +
  '    cybersafe_test_only = "true"\n' +
  "\n" +
  "  strings:\n" +
  `    $canary = "${DEV_TEST_YARA_MARCA}" ascii\n` +
  "\n" +
  "  condition:\n" +
  "    $canary\n" +
  "}\n";

/** Digest do canónico, derivado da constante acima (uma fonte de verdade, dois controlos). */
export const DEV_TEST_YARA_CANONICO_SHA256 = crypto
  .createHash("sha256")
  .update(Buffer.from(DEV_TEST_YARA_CANONICO, "utf8"))
  .digest("hex");

const PREFIXO_PIPE_DEV = "\\\\.\\pipe\\cybersafe-dev-";

export interface CorpusDecisao {
  path: string;
  origem: "producao" | "dev-test";
  motivo: string;
}

export interface ResolverOpcoes {
  env: NodeJS.ProcessEnv;
  definitionsDir: string;
  scanManager: unknown;
  baseDir?: string;
  fsLike?: any;
  maxBytes?: number;
  regraEsperada?: string;
}

/** Códigos de recusa estáveis: o chamador distingue WHY sem parsear prosa. */
export const RECUSA = {
  MODO: "modo_nao_declarado",
  PRODUCAO: "producao_recusada",
  ISOLAMENTO: "isolamento_nao_verificado",
  PERFIS: "perfis_fora_da_raiz",
  PIPE: "pipe_nao_isolado",
  GATE: "gate_nao_montado",
  FIXTURE: "fixture_invalida",
  CAMINHO: "caminho_recusado",
  CORPUS_PRODUCAO: "corpus_producao_protegido",
  REPARSE: "reparse_recusado",
  TAMANHO: "tamanho_recusado",
  CONTEUDO: "corpus_invalido",
} as const;

class RecusaCorpus extends Error {
  constructor(codigo: string, detalhe: string) {
    // O detalhe nunca pode ecoar caminhos do perfil: é só o CÓDIGO que o chamador lê.
    super(`${DEV_TEST_YARA_CODE}:${codigo} ${detalhe}`);
    this.name = "RecusaCorpus";
  }
}

const mesmaCoisa = (a: string, b: string) =>
  process.platform === "win32"
    ? a.replace(/[\\/]+$/, "").toLowerCase() === b.replace(/[\\/]+$/, "").toLowerCase()
    : a.replace(/\/+$/, "") === b.replace(/\/+$/, "");

/** `realpath` tem de coincidir com o caminho léxico — é isto que fecha junctions/symlinks. */
function realpathIgualLexico(p: string, fs_: any): boolean {
  try {
    const real = fs_.realpathSync.native ? fs_.realpathSync.native(p) : fs_.realpathSync(p);
    return mesmaCoisa(real, p);
  } catch {
    return false;
  }
}

/** Nenhum ancestral pode ser ponto de reparse (a mesma regra do gate de fixture). */
function ancestraisSemReparse(p: string, fs_: any): boolean {
  let atual = path.parse(path.resolve(p)).root;
  for (const seg of path.relative(atual, path.resolve(p)).split(/[\\/]+/).filter(Boolean)) {
    atual = path.join(atual, seg);
    try {
      const s = fs_.lstatSync(atual);
      if (s.isSymbolicLink()) return false;
    } catch (e: any) {
      if (e && (e.code === "ENOENT" || e.code === "ENOTDIR")) return true;
      return false;
    }
  }
  return true;
}

/** Estrutura mínima: exatamente uma regra, o nome canário, sem `include`. */
function revisarConteudo(texto: string, regraEsperada: string): string | null {
  if (/^\s*include\b/m.test(texto)) return "contem include";
  const regras = texto.match(/^\s*(?:private\s+|global\s+)?rule\s+([A-Za-z_][A-Za-z0-9_]*)/gm) || [];
  if (regras.length !== 1) return `regras=${regras.length}, esperava 1`;
  const nome = regras[0].match(/([A-Za-z_][A-Za-z0-9_]*)\s*$/);
  if (!nome || nome[1] !== regraEsperada) return "nome de regra nao e o canario revirado";
  if (!texto.includes("{") || !texto.includes("}")) return "regra sem corpo";
  if (!/condition\s*:/.test(texto)) return "regra sem condition";
  return null;
}

/**
 * Compilação REAL, por sonda comportamental, num cópia temporária.
 *
 * Porque não usar `YaraEngine.load(caminhoOriginal)` direto: se o ficheiro não for aceite,
 * o motor repõe o fallback ESCREVENDO nesse caminho. Apontado ao corpus de ferramenta, isso
 * trocaria silenciosamente a regra canário pela regra EICAR — e o teste passaria a falhar
 * pelo motivo errado. A cópia isola o efeito; a produção não é tocada por definição.
 *
 * Porque recebe `bytes` já validados e não re-lê o ficheiro: a sonda tem de incidir sobre os
 * MESMOS bytes que foram comparados ao canónico. Re-ler aqui faria a sonda provar uns bytes
 * e a decisão apontar para outros. O digest da cópia escrita é verificado contra o dos bytes
 * recebidos — é essa comparação que apanha uma sonda a compilar outra coisa (escrita parcial,
 * ou uma re-leitura do caminho).
 */
async function compilarESondar(bytes: Buffer, digestBytes: string): Promise<string | null> {
  let diretorio = "";
  try {
    const { YaraEngine } = await import("@cybersafe/core");
    diretorio = realFs.mkdtempSync(path.join(realFs.realpathSync(os.tmpdir()), "cs-a4-sonda-"));
    const copia = path.join(diretorio, "corpus.yar");
    realFs.writeFileSync(copia, bytes);
    const escrita = realFs.readFileSync(copia);
    if (!escrita.equals(bytes) || crypto.createHash("sha256").update(escrita).digest("hex") !== digestBytes) {
      return "os bytes sondados nao sao os bytes validados";
    }
    const positivo = path.join(diretorio, "positivo.txt");
    const benigno = path.join(diretorio, "benigno.txt");
    realFs.writeFileSync(positivo, `a\n${DEV_TEST_YARA_MARCA}\nb\n`);
    realFs.writeFileSync(benigno, "nada que ver\n");

    const motor = new YaraEngine();
    await motor.load(copia);
    if (!motor.isAvailable) return "motor indisponivel";
    const falsos = await motor.scanFile(benigno);
    if (falsos.length !== 0) return "falso positivo no benigno";
    const detecoes = await motor.scanFile(positivo);
    if (detecoes.length !== 1) return `sonda deu ${detecoes.length} detecoes, esperava 1`;
    if (String(detecoes[0].ruleId) !== DEV_TEST_YARA_REGRA) return "regra detetada nao e a canario";
    return null;
  } catch (e: any) {
    return `sonda falhou (${String(e && e.code ? e.code : "").slice(0, 16)})`;
  } finally {
    if (diretorio) { try { realFs.rmSync(diretorio, { recursive: true, force: true }); } catch {} }
  }
}

export async function resolverCorpusYara(opts: ResolverOpcoes): Promise<CorpusDecisao> {
  const env = opts.env || {};
  const fs_ = opts.fsLike || realFs;
  const producao = path.join(opts.definitionsDir, "yara", "default.yar");

  const cru = String(env[DEV_TEST_YARA_ENV] ?? "").trim();
  if (!cru) {
    // Caminho de produção: sem uma vírgula de I/O novo, exatamente como hoje.
    return { path: producao, origem: "producao", motivo: "ambiente ausente: corpus de producao inalterado" };
  }

  if (String(env.NODE_ENV ?? "").toLowerCase() === "production") throw new RecusaCorpus(RECUSA.PRODUCAO, "empacotado/producao nunca troca de corpus");
  if (String(env.NODE_ENV ?? "") !== "development") throw new RecusaCorpus(RECUSA.MODO, "exige NODE_ENV=development explicito");
  if (String(env.CYBERSAFE_DEV_ISOLATION ?? "") !== "1") throw new RecusaCorpus(RECUSA.ISOLAMENTO, "falta CYBERSAFE_DEV_ISOLATION=1");

  const devRoot = String(env.CYBERSAFE_DEV_ROOT ?? "").trim();
  if (!devRoot || !path.isAbsolute(devRoot)) throw new RecusaCorpus(RECUSA.ISOLAMENTO, "raiz de DEV ausente ou relativa");
  if (!fs_.existsSync(devRoot)) throw new RecusaCorpus(RECUSA.ISOLAMENTO, "raiz de DEV nao existe");
  if (!ancestraisSemReparse(devRoot, fs_)) throw new RecusaCorpus(RECUSA.REPARSE, "ancestral da raiz de DEV e reparse");
  if (!realpathIgualLexico(devRoot, fs_)) throw new RecusaCorpus(RECUSA.REPARSE, "realpath da raiz difere do lexico");
  const tmp = realFs.realpathSync(os.tmpdir());
  if (mesmaCoisa(devRoot, tmp)) throw new RecusaCorpus(RECUSA.ISOLAMENTO, "raiz de DEV e a base temporaria, nao um run dedicado");
  if (!estaContido(tmp, path.resolve(devRoot))) throw new RecusaCorpus(RECUSA.ISOLAMENTO, "raiz de DEV fora da base temporaria");

  for (const chave of ["CYBERSAFE_DEV_SERVICE_DIR", "CYBERSAFE_DEV_USER_DATA_DIR"]) {
    const valor = String(env[chave] ?? "").trim();
    if (!valor || !estaContido(path.resolve(devRoot), path.resolve(valor))) throw new RecusaCorpus(RECUSA.PERFIS, `${chave} nao contido na raiz do run`);
  }
  const pipe = String(env.CYBERSAFE_DEV_PIPE_NAME ?? "");
  if (!pipe.toLowerCase().startsWith(PREFIXO_PIPE_DEV)) throw new RecusaCorpus(RECUSA.PIPE, "pipe nao e do run isolado");

  if (String(env[FIXTURE_SCAN_FLAG] ?? "") !== "1") throw new RecusaCorpus(RECUSA.FIXTURE, "sessao de fixture nao declarada");
  try {
    fixtureRootFromEnv(env);
  } catch {
    throw new RecusaCorpus(RECUSA.FIXTURE, "validacao real do gate recusou o root de fixture");
  }
  const prova = gateDeFixtureMontadoPara(opts.scanManager, env);
  if (!prova.montado) throw new RecusaCorpus(RECUSA.GATE, `readOnly nao esta forcado pelo gate real: ${prova.motivo}`);

  const alvo = path.resolve(cru);
  if (!path.isAbsolute(cru)) throw new RecusaCorpus(RECUSA.CAMINHO, "caminho relativo");
  if (estaContido(path.resolve(opts.definitionsDir), alvo)) throw new RecusaCorpus(RECUSA.CORPUS_PRODUCAO, "corpus de teste nunca pode viver no corpus de producao");
  if (!estaContido(path.resolve(devRoot), alvo)) throw new RecusaCorpus(RECUSA.CAMINHO, "fora da raiz de DEV aprovada");
  if (path.extname(alvo).toLowerCase() !== ".yar") throw new RecusaCorpus(RECUSA.CAMINHO, "extensao nao e .yar");
  if (!ancestraisSemReparse(alvo, fs_)) throw new RecusaCorpus(RECUSA.REPARSE, "ancestral e reparse");

  let stat;
  try {
    stat = fs_.lstatSync(alvo);
  } catch {
    throw new RecusaCorpus(RECUSA.CAMINHO, "ficheiro ausente ou inalcançavel");
  }
  if (stat.isSymbolicLink()) throw new RecusaCorpus(RECUSA.REPARSE, "o proprio corpus e um link");
  if (!stat.isFile()) throw new RecusaCorpus(RECUSA.CAMINHO, "nao e ficheiro regular");
  if (!realpathIgualLexico(alvo, fs_)) throw new RecusaCorpus(RECUSA.REPARSE, "realpath do corpus difere do lexico");

  const limite = opts.maxBytes ?? DEV_TEST_YARA_MAX_BYTES;
  if (stat.size <= 0) throw new RecusaCorpus(RECUSA.CAMINHO, "ficheiro vazio");
  if (stat.size > limite) throw new RecusaCorpus(RECUSA.TAMANHO, `limite ${limite} bytes excedido`);

  let texto: string;
  try {
    texto = String(fs_.readFileSync(alvo, "utf-8"));
  } catch {
    throw new RecusaCorpus(RECUSA.CAMINHO, "ficheiro ilegivel");
  }

  const problemaConteudo = revisarConteudo(texto, opts.regraEsperada ?? DEV_TEST_YARA_REGRA);
  if (problemaConteudo) throw new RecusaCorpus(RECUSA.CONTEUDO, problemaConteudo);

  // A sonda é feita sobre os bytes que acabámos de ler — nunca sobre uma re-leitura do
  // caminho. Assim «o que compilou» e «o que se vai comparar ao canónico e entregar ao
  // motor» são a mesma sequência de bytes, e não três leituras que podem divergir.
  const bytes = Buffer.from(texto, "utf8");
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");

  const problemaCompilacao = await compilarESondar(bytes, digest);
  if (problemaCompilacao) throw new RecusaCorpus(RECUSA.CONTEUDO, `compilacao/sonda: ${problemaCompilacao}`);

  // Forma certa não é identidade. Depois de compilar, o corpus tem de ser o CANÓNICO byte a
  // byte: um ficheiro que mantivesse a forma (uma regra, o nome revirado, sem `include`) e
  // mudasse o literal — ou que escondesse uma segunda regra dentro de um comentário, que a
  // revisão estrutural não conta — passa aqui a ser recusado.
  if (texto !== DEV_TEST_YARA_CANONICO || digest !== DEV_TEST_YARA_CANONICO_SHA256) {
    throw new RecusaCorpus(
      RECUSA.CONTEUDO,
      `corpus nao e o canario canonico (sha ${digest.slice(0, 16)}, esperava ${DEV_TEST_YARA_CANONICO_SHA256.slice(0, 16)})`,
    );
  }

  // Depois da sonda, o caminho tem de ter AINDA aqueles bytes: o motor vai re-lê-lo, e uma
  // substituição entre a decisão e o load trocaria o corpus sem qualquer recusa. O que isto
  // prova é «os bytes sondados são os bytes do caminho no instante da decisão»; a janela até
  // ao `load()` do motor não é fechável por este módulo — daí o caminho ser fora das
  // definições de produção, dentro da raiz do run, sem reparse e sem escrita de terceiros.
  let textoApos;
  try {
    textoApos = String(fs_.readFileSync(alvo, "utf-8"));
  } catch {
    throw new RecusaCorpus(RECUSA.CAMINHO, "ficheiro ilegivel apos a sonda");
  }
  const digestApos = crypto.createHash("sha256").update(Buffer.from(textoApos, "utf8")).digest("hex");
  if (textoApos !== texto || digestApos !== digest) {
    throw new RecusaCorpus(RECUSA.CONTEUDO, "corpus mudou durante a sonda");
  }

  return {
    path: alvo,
    origem: "dev-test",
    motivo: `gate montado (${prova.motivo}), isolamento verificado, canonico byte-exact compilado por YARA real (sha ${digest.slice(0, 16)})`,
  };
}
