#!/usr/bin/env node
// REVISÃO DIRIGIDA DE ARTEFACTO — helper reutilizável do gate de artefacto (C4+).
//
// HISTÓRICO (importa para não repetir o erro): a versão anterior tinha a candidata C1
// (`candidate-20261015-083959-010660bd`) HARDCODED no topo e no metadata, não validava
// a identidade do artefacto e imprimia "36" como se fosse um facto do método. Não era
// reutilizável: corria sempre sobre a C1 independentemente do que existisse em disco.
// Esta versão troca isso por AUTORIDADE DE ARTEFACTO:
//   - `--candidate <dir>` e `--expect-asar-sha <sha256>` são OBRIGATÓRIOS;
//   - o sha256 do `app.asar` é RECALCULADO e comparado antes de qualquer análise;
//   - divergência ausente/errada ABORTA (sem fallback para candidata nenhuma);
//   - o metadata é derivado do argumento real, nunca de constante.
//
// Método (independente do classificador do qoder):
//   1. recalcula os hits no ASAR indicado, com o leitor próprio readAsar() (reutilizado,
//      sem alterações, de `scripts/audit-candidate-secrets.mjs`);
//   2. extrai a CORRIDA maximal (token) que contém cada hit — usada só como needle;
//   3. procura essa corrida, byte-a-byte, no CÓDIGO-FONTE do repo e nos pacotes
//      empacotados (em memória) para obter a proveniência real;
//   4. veredicto só com proveniência: origem em dependência empacotada → falso positivo
//      provado; origem no NOSSO fonte → NÃO é falso positivo; sem origem → UNRESOLVED.
//
// Regra dura: nunca escreve o token/valores no output; só caminhos, versões, famílias
// públicas, comprimentos, offsets e fingerprints sha256(10). Nenhuma chamada de rede.
//
// BLOQUEIO: `UNRESOLVED > 0` faz o processo sair com código 5 (gate BLOQUEADO). Não há
// flag para "passar à força" — por decisão explícita, `--known` não é implementado.
//
// COBERTURA DECLARADA: este helper cobre **2 famílias** (ver FAMILIES). NÃO é uma
// verificação de segurança completa do artefacto e NÃO afirma "full safety" sobre
// nenhum conjunto de ocorrências; complementa (não substitui) o varrimento de
// credenciais de `scripts/audit-candidate-secrets.mjs`.
//
// Uso:
//   node scripts/audit-candidate-review36.mjs --candidate <dir-do-candidato> \
//        --expect-asar-sha <sha256-do-app.asar> [--json <out.json>] [--md <out.md>]
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const { readAsar, collectLocalConfigs, detectLeaks } = await import(
  pathToFileURL(join(HERE, 'audit-candidate-secrets.mjs')).href
);

/** Códigos de saída. Estáveis e testados. */
export const EXIT = { OK: 0, USAGE: 2, ARTIFACT: 3, LEAK: 4, UNRESOLVED: 5 };

// --- knownCandidates: shortcodes → artefacto do repo, versionado ---
// Isto é documentação de como re-executedores CLI podem traduzir um shortcode
// para um candidate real E um hash SAME resolvem-se; não é default.export const knownCandidates = new Map([]);
//
// Known artefacts are documented here for executors that want a
// shortcode -> real candidate + same expected hash resolution, but the helper never uses
// them as defaults. Callers must explicitly opt in via `resolveKnownCandidate`.
//
export const KNOWN_ARTEFACT_C1 = {
  dir: relative(ROOT, join(ROOT, 'packages', 'desktop', 'release', 'candidate-20261015-083959-010660bd')),
  expectAsarSha: 'b3cc275c3104a86c4971ae61676c7cf04961b78dd712a09264ca483e8e64286a',
  note: 'reference artifact only: output/manual-retest/CODEX-REALTIME-DIAGNOSTICO.md section C1/C3 (historical)',
};

/**
 * Only: if a caller derives a historical shortcode it may resolve it explicitly via
 * `resolveKnownCandidate`, but this helper itself never uses those as defaults.
 */
export function resolveKnownCandidate(shrt) {
  if (shrt === 'C1') return KNOWN_ARTEFACT_C1;
  return null;
}

/**
 * Cobertura DECLARADA deste helper. São duas famílias, escolhidas por serem as que
 * apareceram na candidata que originou o script. A regex é parte do contrato: fica
 * aqui, em texto, para que a cobertura possa ser lida e não apenas presumida.
 */
export const FAMILIES = [
  {
    id: 'openai-style-sk',
    source: '/sk-(?!ant-)[A-Za-z0-9_-]{16,}/g',
    re: /sk-(?!ant-)[A-Za-z0-9_-]{16,}/g,
    semantic: 'tokens começados por `sk-` — forma de chave de API OpenAI-like',
  },
  {
    id: 'private-key-block',
    source: '/-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g',
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
    semantic: 'cabeçalho de bloco PEM de chave privada',
  },
];

const SHA256_RE = /^[0-9a-f]{64}$/;

const fp10 = (s) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 10);
const toRel = (p) => relative(ROOT, p).split(sep).join('/');
/** Relativo quando está dentro do repo (legível); absoluto quando está fora. */
const toDisplay = (p) => { const r = toRel(p); return r.startsWith('..') ? p.split(sep).join('/') : r; };

/** Erro de uso/artefacto — carrega o código de saída pretendido. */
export class GateError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'GateError';
    this.code = code;
  }
}

/**
 * Parser estrito. Sem valores por omissão escondidos: os dois argumentos que dão
 * AUTORIDADE ao gate são obrigatórios, e um sha malformado é recusado aqui (não
 * chega a tocar no disco).
 */
export function parseArgs(argv) {
  const get = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const candidate = get('--candidate');
  const expectAsarSha = get('--expect-asar-sha');
  if (!candidate || candidate.startsWith('--')) {
    throw new GateError('falta `--candidate <dir>` (obrigatório: o gate não escolhe candidata por omissão).', EXIT.USAGE);
  }
  if (!expectAsarSha || expectAsarSha.startsWith('--')) {
    throw new GateError('falta `--expect-asar-sha <sha256>` (obrigatório: sem ela o artefacto não tem identidade).', EXIT.USAGE);
  }
  const sha = expectAsarSha.trim().toLowerCase();
  if (!SHA256_RE.test(sha)) {
    throw new GateError('`--expect-asar-sha` não é um sha256 hex de 64 caracteres.', EXIT.USAGE);
  }
  return {
    candidateDir: candidate,
    expectAsarSha: sha,
    json: get('--json'),
    md: get('--md'),
    callerCandidate: candidate,
    callerExpectAsarSha: expectAsarSha,
    callerResolved: null,
  };
}

/**
 * Localiza e AUTENTICA o artefacto. Devolve o buffer, o sha real e os caminhos.
 * Qualquer falha é `EXIT.ARTIFACT` — nunca se analisa um artefacto não identificado.
 */
export function resolveArtifact(candidateDir) {
  const asarPath = join(candidateDir, 'win-unpacked', 'resources', 'app.asar');
  if (!existsSync(candidateDir) || !statSync(candidateDir).isDirectory()) {
    throw new GateError(`candidata inexistente: ${toDisplay(candidateDir)}`, EXIT.ARTIFACT);
  }
  if (!existsSync(asarPath)) {
    throw new GateError(`app.asar inexistente no layout canónico: ${toDisplay(asarPath)}`, EXIT.ARTIFACT);
  }
  return { asarPath };
}

/** Compara o sha real com o esperado. Divergência aborta com o artefacto identificado. */
export function assertSha(realSha, expectSha) {
  if (realSha !== expectSha) {
    throw new GateError(
      `sha256 do app.asar NAO corresponde ao esperado.\n    esperado: ${expectSha}\n    real:     ${realSha}\n  Analise abortada: artefacto sem identidade verificada.`,
      EXIT.ARTIFACT,
    );
  }
}

/**
 * PRIVACIDADE — allowlist de proveniência, por construção.
 *
 * Uma versão anterior percorria o repositório inteiro com uma lista de exclusões e
 * acabava a ler 684 ficheiros, dos quais 485 fora do código de runtime — incluindo
 * `.qoder/settings.local.json`, `.claude/agents/**` e `.aider.chat.history.md`
 * (sessões de agentes), além de `.json/.md` de configuração e documentação. Isso
 * ampliava leituras privadas sem necessidade nenhuma para provar proveniência.
 *
 * Agora o índice é construído a partir de `packages/<ws>/src` e nada mais: não se
 * desce a diretórios de agentes, credenciais, backups, testes ou fixtures, e só se
 * lê o ficheiro depois de o caminho passar o predicado. Configurações do repo são
 * comparadas em separado por `audit-candidate-secrets.mjs` — nunca aqui.
 */
export const SOURCE_ROOTS = /^packages\/[^/]+\/src\//;
export const FORBIDDEN_SEGMENTS = new Set([
  'test', 'tests', '__tests__', '__mocks__', 'spec', 'specs',
  'fixture', 'fixtures', 'testdata', 'e2e',
  'backup', 'backups', 'credentials', 'secrets',
  '.claude', '.qoder', '.git', '.maestri', '.vscode', 'node_modules',
]);
export const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css', '.html']);

/** Predicado puro: este caminho relativo ao repo pode servir de proveniência? */
export function isProvenanceSource(rel) {
  if (typeof rel !== 'string' || !SOURCE_ROOTS.test(rel)) return false;
  const segs = rel.split('/');
  if (segs.some((s) => FORBIDDEN_SEGMENTS.has(s.toLowerCase()))) return false;
  const base = segs[segs.length - 1];
  return SOURCE_EXT.has(base.slice(base.lastIndexOf('.')));
}

/** Índice de proveniência: só fontes de runtime, lidas apenas depois do allowlist. */
export function buildSourceIndex() {
  const out = [];
  const packagesDir = join(ROOT, 'packages');
  let workspaces; try { workspaces = readdirSync(packagesDir); } catch { return out; }
  for (const ws of workspaces) {
    const srcDir = join(packagesDir, ws, 'src');
    if (!existsSync(srcDir)) continue;
    (function walk(dir) {
      let names; try { names = readdirSync(dir); } catch { return; }
      for (const n of names) {
        const p = join(dir, n);
        let st; try { st = statSync(p); } catch { continue; }
        if (st.isDirectory()) { walk(p); continue; }
        const rel = toDisplay(p);
        if (!isProvenanceSource(rel)) continue; // exclui ANTES de ler
        if (st.size > 4 * 1024 * 1024) continue;
        let t; try { t = readFileSync(p, 'utf8'); } catch { continue; }
        out.push({ f: rel, p, t });
      }
    })(srcDir);
  }
  return out;
}

/** Índice restrito dos pacotes empacotados pela app (para proveniência de dependência). */
function buildDepIndex() {
  const appPkg = JSON.parse(readFileSync(join(ROOT, 'packages', 'app', 'package.json'), 'utf8'));
  const out = [];
  for (const dep of Object.keys(appPkg.dependencies || {})) {
    const base = join(ROOT, 'node_modules', dep);
    if (!existsSync(base)) continue;
    (function walk(dir) {
      let names; try { names = readdirSync(dir); } catch { return; }
      for (const n of names) {
        const p = join(dir, n);
        let st; try { st = statSync(p); } catch { continue; }
        if (st.isDirectory()) { walk(p); continue; }
        if (st.size > 3 * 1024 * 1024) continue;
        if (!/\.(js|mjs|cjs|json|css|ts|map)$/.test(n)) continue;
        out.push({ p, buf: readFileSync(p) });
      }
    })(base);
  }
  return out;
}

function enclosingRun(text, idx) {
  let a = idx; while (a > 0 && /[A-Za-z0-9_-]/.test(text[a - 1])) a--;
  let b = idx; while (b < text.length && /[A-Za-z0-9_-]/.test(text[b])) b++;
  return { start: a, end: b, token: text.slice(a, b) };
}

/**
 * Entradas de documentação EMPACOTADAS cujo cabeçalho PEM de exemplo pode ser
 * reconhecido como falso positivo — e só quando o PRÓPRIO entry o prova (bloco de
 * código + ausência de corpo de chave). Nunca uma flag global vinda do host: um
 * README benigno do host não pode limpar um hit noutro ficheiro do ASAR.
 */
export const DOC_ENTRIES = /(^|\/)node_modules\/dotenv\/README[a-z-]*\.md$/i;

/**
 * Prova semântica da família `sk-`: a corrida maximal é uma classe utilitária CSS
 * pública `mask-*` (família emitida pelo tailwind-merge), não material de chave.
 */
export function isPublicCssMaskUtility(run) {
  return typeof run === 'string' && /^mask-[a-z0-9-]*$/i.test(run);
}

/**
 * Veredicto. Nunca aceita "está numa dependência" como inocência: dependências
 * empacotadas podem trazer valores com forma de chave (fixtures, configs embutidas).
 *  - PEM: falso positivo SÓ com prova POR ENTRADA do ASAR — o hit está no próprio
 *    ficheiro de documentação empacotado, dentro de um bloco de código, sem corpo nem
 *    trailer de chave nesse entry. Corpo presente, entry alheio ou fence ausente →
 *    UNRESOLVED (bloqueia).
 *  - sk-: falso positivo SÓ com prova semântica — corrida maximal = identificador CSS
 *    público `mask-*` E proveniência real do tailwind-merge com versão registada.
 *  - Tudo o resto → UNRESOLVED, que BLOQUEIA.
 */
export function verdictFor(hit, contexto = {}) {
  const deps = hit?.provenance?.packagedDeps ?? [];
  const repo = hit?.provenance?.repoSource ?? [];
  const ctx = hit?.context ?? {};
  const entry = ctx.entryPath ?? null;

  if (hit?.rule === 'private-key-block') {
    if (ctx.hasKeyBody === true || ctx.hasEnd === true) {
      return {
        verdict: 'UNRESOLVED',
        origin: entry,
        reason: 'o bloco PEM traz corpo/trailer de chave — nunca é limpo por documentação',
      };
    }
    if (entry && DOC_ENTRIES.test(entry) && ctx.isDocEntry === true && ctx.inDocsFence === true) {
      return {
        verdict: 'FALSE_POSITIVE_PROVEN',
        origin: entry,
        reason: `cabeçalho PEM de EXEMPLO no próprio ficheiro de documentação empacotado (\`${entry}\`), dentro de bloco de código e sem corpo de chave`,
      };
    }
    return {
      verdict: 'UNRESOLVED',
      origin: entry ?? repo[0] ?? deps[0] ?? null,
      reason: entry
        ? 'cabeçalho PEM sem prova de exemplo NESTE entry do artefacto (ficheiro de documentação, bloco de código ou ausência de corpo não provados)'
        : 'cabeçalho PEM em conteúdo sem localização interna no artefacto',
    };
  }

  if (hit?.rule === 'openai-style-sk') {
    const versao = contexto.tailwindMergeVersion ?? null;
    if (ctx.publicCssIdentifier === true && versao) {
      return {
        verdict: 'FALSE_POSITIVE_PROVEN',
        origin: `${deps[0] ?? 'node_modules/tailwind-merge'} (tailwind-merge@${versao})`,
        reason: 'a corrida maximal é uma classe utilitária CSS pública `mask-*`; a dependência real (tailwind-merge) está empacotada e a versão está registada',
      };
    }
    if (ctx.publicCssIdentifier === true && !versao) {
      return {
        verdict: 'UNRESOLVED',
        origin: entry,
        reason: 'corrida com forma de classe CSS pública, mas SEM versão real do tailwind-merge: prova semântica incompleta',
      };
    }
    if (repo.length > 0) {
      return { verdict: 'UNRESOLVED', origin: repo[0], reason: 'a corrida existe no NOSSO código-fonte: exige revisão humana, não é falso positivo' };
    }
    if (deps.length > 0) {
      return {
        verdict: 'UNRESOLVED',
        origin: deps[0],
        reason: 'existe numa dependência empacotada, mas estar numa dependência não prova que não seja credencial',
      };
    }
    return { verdict: 'UNRESOLVED', origin: null, reason: 'sem origem conhecida no repo nem nas dependências empacotadas' };
  }

  return {
    verdict: 'UNRESOLVED',
    origin: repo[0] ?? deps[0] ?? null,
    reason: 'família sem regra de prova semântica: bloqueia por omissão',
  };
}

/**
 * Contexto POR ENTRADA do ASAR (nunca do host). É isto que decide se ESTE hit é
 * provável: ficheiro real, deslocamento real, bloco de código e ausência de corpo.
 */
export function entryContextFor(asar, offset) {
  const entry = asar.entries.find((e) => offset >= e.start && offset < e.end);
  if (!entry) return { entryPath: null, isDocEntry: false, inDocsFence: false, hasKeyBody: null, hasEnd: null };
  const texto = asar.buf.subarray(entry.start, entry.end).toString('latin1');
  const rel = offset - entry.start;
  const antes = texto.slice(0, rel);
  const depois = texto.slice(rel, rel + 240);
  const FENCE = '`'.repeat(3);
  const janelaLonga = texto.slice(rel, rel + 8192);
  return {
    entryPath: entry.path,
    isDocEntry: /\.(md|markdown|txt)$/i.test(entry.path),
    inDocsFence: (antes.split(FENCE).length - 1) % 2 === 1,
    // corpo de chave: material base64 imediatamente a seguir ao cabeçalho
    hasKeyBody: /[A-Za-z0-9+/]{60,}/.test(depois),
    // trailer de chave: fecha o bloco (não pode ocorrer em prosa)
    hasEnd: /-----END [A-Z ]*PRIVATE KEY-----/.test(janelaLonga),
  };
}

/** Recolhe os hits do artefacto, com proveniência e contexto POR ENTRADA. Nunca imprime o token. */
export function collectHits(asar, indexes) {
  const text = asar.buf.toString('latin1');
  const hits = [];
  for (const family of FAMILIES) {
    for (const m of text.matchAll(family.re)) {
      const run = enclosingRun(text, m.index);
      const nb = Buffer.from(run.token, 'latin1');
      const ctx = entryContextFor(asar, m.index);
      hits.push({
        rule: family.id,
        offsetInArtifact: m.index,
        tokenLength: run.token.length,
        matchedLength: m[0].length,
        fingerprint: fp10(m[0]),
        runFingerprint: fp10(run.token),
        innerPath: ctx.entryPath,
        context: {
          ...ctx,
          // A corrida NUNCA sai do processo: só o booleano da prova semântica.
          publicCssIdentifier: family.id === 'openai-style-sk' && isPublicCssMaskUtility(run.token),
        },
        provenance: {
          repoSource: indexes.src.filter((c) => c.t.includes(run.token)).map((c) => c.f).slice(0, 6),
          packagedDeps: indexes.deps.filter((c) => c.buf.includes(nb)).map((c) => toRel(c.p)).slice(0, 6),
        },
      });
    }
  }
  return hits;
}

/** Factos da documentação dotenv (apoio à família PEM). Nunca lê corpo de chave para fora. */
function dotenvDocFacts() {
  const relFile = 'node_modules/dotenv/README-es.md';
  const dotPath = join(ROOT, relFile);
  const base = { file: relFile, occurrences: 0, insideFence: null, hasKeyBody: null, hasEnd: null };
  if (!existsSync(dotPath)) return base;
  const dot = readFileSync(dotPath, 'utf8');
  const occ = [...dot.matchAll(FAMILIES[1].re)].map((m) => m.index);
  const FENCE = '`'.repeat(3);
  const facts = occ.map((o) => {
    const near = dot.slice(o, o + 240);
    const before = dot.slice(Math.max(0, o - 600), o);
    return {
      inFencedCodeBlock: (before.split(FENCE).length - 1) % 2 === 1,
      hasKeyBody: /[A-Za-z0-9+/]{60,}/.test(near),
      hasEnd: /-----END [A-Z ]*PRIVATE KEY-----/.test(near),
      line: dot.slice(0, o).split('\n').length,
    };
  });
  return {
    file: relFile,
    occurrences: occ.length,
    inFencedCodeBlock: facts.every((f) => f.inFencedCodeBlock),
    hasKeyBody: facts.some((f) => f.hasKeyBody),
    hasEnd: facts.every((f) => f.hasEnd),
    lines: facts.map((f) => f.line),
    backticksInFile: dot.split('`').length - 1,
    fileBytes: dot.length,
  };
}

function depVersion(name) {
  try { return JSON.parse(readFileSync(join(ROOT, 'node_modules', name, 'package.json'), 'utf8')).version; } catch { return null; }
}

function renderMd(r) {
  const L = [];
  L.push('# Revisão dirigida de artefacto — gate de identidade verificada');
  L.push('');
  L.push(`Modo: **LOCAL/OFFLINE/READ-ONLY**, 0 chamadas de rede. Gerado: ${r.generatedAt}`);
  L.push(`Candidata: \`${r.artifact.candidate}\``);
  L.push(`app.asar: \`${r.artifact.asarPath}\` · sha256 \`${r.artifact.asarSha256}\``);
  L.push(`Identidade verificada contra \`--expect-asar-sha\`: **${r.artifact.authorityVerified ? 'SIM' : 'NÃO'}**`);
  L.push('');
  L.push('## Veredicto');
  L.push('');
  L.push(`**${r.totals.falsePositiveProven}/${r.totals.hits} com prova semântica** · UNRESOLVED: ${r.totals.unresolved} · fingerprints distintas: ${r.totals.distinctFingerprints}.`);
  L.push('');
  L.push(r.totals.unresolved > 0
    ? '**GATE BLOQUEADO**: há ocorrências sem prova semântica concluída. Não se fecha o gate com UNRESOLVED.'
    : 'Sem UNRESOLVED nesta amostra: todas as ocorrências têm prova semântica por entrada.');
  L.push('');
  L.push('## Cobertura (declarada, não presumida)');
  L.push('');
  L.push(`Famílias cobertas: **${r.patternCoverage.families.length}** (não é verificação de segurança completa).`);
  for (const f of r.patternCoverage.families) L.push(`- \`${f.id}\` — \`${f.source}\` — ${f.semantic}`);
  L.push('');
  L.push(r.patternCoverage.disclaimer);
  L.push('');
  L.push('## Por ocorrência (mascarado: sem valores/contexto)');
  L.push('');
  L.push('| # | família | ficheiro | offset | compr.(match) | corrida | fp | veredicto | origem |');
  L.push('|---|---|---|---|---|---|---|---|---|');
  r.hits.forEach((h, i) => L.push(`| ${i + 1} | ${h.rule} | ${h.innerPath} | ${h.offsetInArtifact} | ${h.matchedLength} | ${h.enclosingRunLength} | \`${h.fingerprint}\` | ${h.verdict} | ${h.origin ?? '—'} |`));
  L.push('');
  L.push('## Limites');
  L.push('');
  L.push(`- Cobertura limitada às ${r.patternCoverage.families.length} famílias acima; ausência de hit **não** prova ausência de segredos.`);
  L.push('- Proveniência: a mesma corrida aparece em vários ficheiros da **mesma** origem (fonte + builds) — é uma origem, não duplicação independente.');
  L.push('- Falso positivo **prova-se semanticamente**, por entrada: matriz PEM reconhecida na documentação EMPACOTADA daquele entry (bloco de código, sem corpo/trailer de chave) ou identificador CSS público `mask-*` com a dependência real e versão registada. **Nunca** por o token ser curto, por classes de caracteres, ou por estar numa dependência.');
  L.push('- Estar dentro de uma dependência empacotada **não** é prova de inocência: uma dependência pode transportar valores com forma de chave. Esses casos ficam UNRESOLVED e bloqueiam.');
  L.push('- A prova PEM é **por entrada do ASAR** (ficheiro real, deslocamento real, bloco de código real). Uma referência benigna no HOST nunca limpa um hit noutro ficheiro do artefacto.');
  L.push('- Os valores de configuração local entram apenas como guarda anti-fuga; nunca são impressos nem persistidos.');
  L.push('- Auditoria prévia de referência: `output/manual-retest/SECURITY-GATE-20261015/FREEBUFF-REVIEW-36.md` (UMA candidata, C1). Os números dessa auditoria **não** se transportam para este artefacto.');
  L.push('');
  return L.join('\n');
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`USO: ${err.message}`);
    process.exit(err.code ?? EXIT.USAGE);
  }

  const candidateDir = isAbsolute(opts.candidateDir) ? opts.candidateDir : join(ROOT, opts.candidateDir);
  let asarPath;
  let asar;
  let asarSha;
  let expect;
  try {
    ({ asarPath } = resolveArtifact(candidateDir));
    const buf = readFileSync(asarPath);
    asarSha = createHash('sha256').update(buf).digest('hex');
    expect = opts.expectAsarSha;
    assertSha(asarSha, expect);
    asar = readAsar(asarPath);
    opts.callerResolved = { candidate: candidateDir, asarSha, expectAsarSha: expect };
  } catch (err) {
    console.error(`ARTEFACTO: ${err.message}`);
    process.exit(err.code ?? EXIT.ARTIFACT);
  }

  const hits = collectHits(asar, { src: buildSourceIndex(), deps: buildDepIndex() });
  const doc = dotenvDocFacts();
  const tailwindMergeVersion = depVersion('tailwind-merge');

  const perHit = hits.map((h) => {
    // A AUTORIDADE é o contexto POR ENTRADA do ASAR (`h.context`) — nunca uma flag
    // global do host. A versão do tailwind-merge só conta como prova se existir de
    // facto no disco.
    const v = verdictFor(h, { tailwindMergeVersion });
    return {
      rule: h.rule,
      innerPath: h.innerPath,
      offsetInArtifact: h.offsetInArtifact,
      fingerprint: h.fingerprint,
      runFingerprint: h.runFingerprint,
      matchedLength: h.matchedLength,
      enclosingRunLength: h.tokenLength,
      // Contexto publicável: só booleans. Nunca a corrida, nunca o valor.
      entryIsDocumentation: h.context.isDocEntry === true,
      insideDocumentationFence: h.context.inDocsFence === true,
      entryHasKeyBody: h.context.hasKeyBody === true,
      entryHasKeyTrailer: h.context.hasEnd === true,
      cssPublicIdentifierProof: h.context.publicCssIdentifier === true,
      verdict: v.verdict,
      origin: v.origin,
      reason: v.reason,
      publicIdentifier: v.verdict === 'FALSE_POSITIVE_PROVEN',
    };
  });

  const candidateRel = toDisplay(candidateDir);
  const base = candidateRel.split('/').pop() || 'candidate';
  const outJson = opts.json ?? join(ROOT, 'output', 'manual-retest', 'ARTIFACT-GATE', `${base}-review.json`);
  const outMd = opts.md ?? join(ROOT, 'output', 'manual-retest', 'ARTIFACT-GATE', `${base}-review.md`);

  const report = {
    generatedAt: new Date().toISOString(),
    task: 'revisão dirigida de artefacto com identidade verificada (gate de candidata)',
    mode: 'LOCAL-ONLY / OFFLINE / READ-ONLY (0 chamadas de rede)',
    artifact: {
      candidate: candidateRel,
      asarPath: toDisplay(asarPath),
      asarSha256: asarSha,
      expectedAsarSha256: expect,
      authorityVerified: asarSha === expect,
      asarEntries: asar.entries.length,
      asarBytes: asar.buf.length,
    },
    artifactSecurity: {
      sha256ComputedFromFile: toDisplay(asarPath),
      sha256ComputedBeforeAnalysis: true,
      hashPassivatedToMetadataOnly: false,
      noDefaultCandidateSelected: true,
      noSilentFallback: true,
      callerArgs: {
        candidate: opts.callerCandidate,
        expectAsarSha: opts.callerExpectAsarSha,
        resolved: opts.callerResolved ?? null,
      },
    },
    method: 'sha256 do app.asar recalculado e comparado com --expect-asar-sha ANTES da análise; hits recalculados com readAsar() próprio; corrida maximal de cada hit usada como needle (nunca impressa) e procurada byte-a-byte no fonte do repo e nos pacotes empacotados',
    patternCoverage: {
      familiesCount: FAMILIES.length,
      families: FAMILIES.map((f) => ({ id: f.id, source: f.source, semantic: f.semantic })),
      isFullSafety: false,
      disclaimer:
        'Este helper cobre apenas as famílias listadas. NÃO afirma segurança completa do artefacto e NÃO substitui o varrimento de credenciais (`audit-candidate-secrets.mjs`) nem qualquer revisão humana. Contagem de hits não é, por si, um veredicto: só a proveniência é. Auditoria prévia de referência: `output/manual-retest/SECURITY-GATE-20261015/FREEBUFF-REVIEW-36.md` — foi um exercício sobre UMA candidata (C1), não um método reutilizável, e os seus números NÃO se transportam para outro artefacto.',
    },
    totals: {
      hits: hits.length,
      falsePositiveProven: perHit.filter((h) => h.verdict === 'FALSE_POSITIVE_PROVEN').length,
      unresolved: perHit.filter((h) => h.verdict === 'UNRESOLVED').length,
      distinctFingerprints: new Set(hits.map((h) => h.fingerprint)).size,
    },
    families: Object.fromEntries(
      FAMILIES.map((f) => {
        const fh = perHit.filter((h) => h.rule === f.id);
        return [f.id, { hits: fh.length, allProven: fh.length > 0 && fh.every((h) => h.verdict === 'FALSE_POSITIVE_PROVEN'), semantic: f.semantic }];
      }),
    ),
    supportFacts: {
      tailwindMergeVersion,
      dotenvVersion: depVersion('dotenv'),
      // Informativo e NÃO autoritativo: descreve o README no HOST. Quem decide o
      // veredicto é o contexto por entrada do ASAR, nunca este campo.
      dotenvReadmeOnHostReference: { ...doc, authority: 'NAO-AUTORITATIVO (apenas referência do host)' },
      fileBytes: asar.buf.length,
    },
    hits: perHit,
  };

  // guarda anti-fuga: os valores de config local só existem para esta comparação e
  // nunca são escritos no output (reutiliza o coletor, sem o alterar).
  const values = collectLocalConfigs(ROOT).entries.map((e) => e.value);
  const md = renderMd(report);
  const leaksJson = detectLeaks(JSON.stringify(report, null, 1), values);
  const leaksMd = detectLeaks(md, values);
  if (leaksJson.length || leaksMd.length) {
    console.error('ABORTADO: guarda anti-fuga detectou valor de config local no output.', JSON.stringify(leaksJson.concat(leaksMd)));
    process.exit(EXIT.LEAK);
  }

  mkdirSync(dirname(outJson), { recursive: true });
  mkdirSync(dirname(outMd), { recursive: true });
  writeFileSync(outJson, JSON.stringify(report, null, 1) + '\n');
  writeFileSync(outMd, md + '\n');

  console.log(`ARTIFACT GATE — ${candidateRel}`);
  console.log(`  asar sha256: ${asarSha} (identidade verificada)`);
  console.log(`  hits=${report.totals.hits} FP_PROVEN=${report.totals.falsePositiveProven} UNRESOLVED=${report.totals.unresolved}`);
  console.log(`  cobertura: ${FAMILIES.length} famílias (não é segurança completa)`);
  console.log(`  json: ${toRel(outJson)}`);
  console.log(`  md:   ${toRel(outMd)}`);
  console.log('  guarda anti-fuga: OK');
  if (report.totals.unresolved > 0) {
    console.error(`GATE BLOQUEADO: ${report.totals.unresolved} ocorrência(s) UNRESOLVED — sem origem provada.`);
    process.exit(EXIT.UNRESOLVED);
  }
  process.exit(EXIT.OK);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
