/**
 * TP-PAP-QUARANTINE-ELECTRON-HARNESS-20261028 — bootstrap do SERVIÇO REAL para
 * a prova de deteção/quarentena/restauro na UI Electron.
 *
 * O que este ficheiro é:
 *   Um ponto de entrada alternativo para `packages/service/dist/index.js`, usado
 *   APENAS pelo harness `scripts/dev-quarantine-electron-proof.mjs`. Não é
 *   importado por produto, não muda o launcher e não substitui o gate de
 *   fixture (`packages/service/src/dev-fixture-gate.ts`), que continua a ser a
 *   autoridade para `scan.start` e para tudo o que não esteja aqui nomeado.
 *
 * O que este ficheiro NÃO é:
 *   - não é um segundo gate genérico: só conhece os três métodos de escrita da
 *     quarentena e duas leituras;
 *   - não prova runtime: a prova é produzida pelo harness, com evidência em
 *     disco; um `node --check` só prova sintaxe;
 *   - não cria assinaturas, não declara cobertura e não age sobre ficheiros
 *     fora do fixture da sessão.
 *
 * Contrato de ambiente (falha fechada: qualquer desvio aborta o arranque):
 *   CYBERSAFE_DEV_ISOLATION=1            isolamento do runner
 *   CYBERSAFE_DEV_OWNED_CHILD=1          shutdown gracioso por IPC do pai
 *   CYBERSAFE_REALDEV_FIXTURE_SCAN=1     gate de fixture montado (readOnly forçado)
 *   CYBERSAFE_REALDEV_FIXTURE_ROOT=<dir> raiz dedicada desta execução
 *   CYBERSAFE_QUARANTINE_FIXTURE_SESSION=1  liga ESTA camada (sem ela não arranca)
 *   CYBERSAFE_QUARANTINE_FIXTURE_MANIFEST=<ficheiro JSON>  identidade da sessão
 *   CYBERSAFE_USB_PROTECTION=0 / CYBERSAFE_STARTUP_RESUME=0  sem proteção automática
 *   NODE_ENV != production
 *
 * Identidade da sessão (manifesto escrito pelo harness antes do spawn):
 *   {
 *     "schema": "cybersafe-quarantine-fixture-v1",
 *     "root": "<realpath da raiz>",
 *     "quarantineTarget": "<nome de UM ficheiro dentro da raiz>",
 *     "files": [{ "name": "<nome>", "sha256": "<64 hex>", "bytes": <n> }]
 *   }
 *   O digest do alvo é recalculado do disco neste processo. Um manifesto que
 *   não bata byte a byte com o disco aborta o arranque — não se "corrige" um
 *   manifesto, recusa-se a sessão.
 *
 * Regras de escrita (todas validadas antes de chegar ao motor, que revalida):
 *   1. `threat.action` só com `action === "quarantine"`, e só para o caminho do
 *      `quarantineTarget` do manifesto, com o digest do manifesto.
 *   2. `quarantine.restore` / `quarantine.delete` só para IDs criados NESTA
 *      sessão (observados por `quarantine.list()` imediatamente após um
 *      isolamento confirmado), e só enquanto a entrada continuar a apontar para
 *      o alvo e para o digest da sessão.
 *   3. `trustAfterRestore` só pode ser `undefined` ou `false`. Qualquer outro
 *      valor — `true`, `1`, `"false"` — é recusado: no backend todos os valores
 *      truthy alteram a confiança do ficheiro restaurado.
 *   4. Orçamento fixo por processo: 2 isolamentos, 1 restauro, 1 eliminação.
 *      Esgotado o orçamento, a resposta é uma recusa, nunca um sucesso mudo.
 *   5. Escritas são SERIALIZADAS: com uma mutação em voo, qualquer segunda
 *      escrita é recusada (nunca entra em fila) — assim o orçamento e o conjunto
 *      de IDs de sessão não podem ser ultrapassados por concorrência.
 *   6. Qualquer outro método segue para o gate de fixture e é recusado por ele
 *      se estiver fora do conjunto de scan (incluindo proteção, monitor, USB,
 *      processos, definições e rede).
 *
 * Contenção durante os `await` (o que é e o que não é garantia):
 *   A cadeia de DIRETÓRIOS (raiz do fixture + todos os ancestrais) é fixada com
 *   `pinFixture` sobre um snapshot do gate reduzido a diretórios — o leaf nunca
 *   é bloqueado, para o rename da quarentena continuar possível. `pinFixture`
 *   abre cada diretório com GENERIC_READ e share que nega WRITE/DELETE, e
 *   confirma a identidade (volume/inode/diretório) da RAIZ — não do leaf —
 *   antes de o bloquear; a lease é libertada em `finally`, sempre.
 *   Isto impede a REDIRECÇÃO do caminho por rename/junction de um ancestral.
 *   NÃO congela o conteúdo do ficheiro: escrever bytes num ficheiro exige
 *   apenas o share do próprio ficheiro, não o dos diretórios. Por isso o leaf é
 *   validado por uma sonda atual (regular, sem reparse, nlink === 1, digest da
 *   sessão) antes de fixar e outra vez antes de entregar ao motor; no restauro
 *   exige-se o leaf AUSENTE. A identidade do leaf capturada no scan não é
 *   reutilizada: depois de um restauro o inode é novo, e isso não pode impedir
 *   o ciclo seguinte. Sonda + digest + raiz pinada são verificações declaradas,
 *   não uma prova de ausência de corrida do leaf. A prova
 *   que a sessão aceita é a PÓS-CONDIÇÃO, verificada no fim:
 *     isolamento: alvo ausente + blob `<id>.quarantine` com o digest da sessão
 *                 + entrada com `isolationStatus === "confirmed"`
 *     restauro:   alvo presente com o digest da sessão + entrada removida
 *     eliminação: entrada e blob ausentes + alvo ausente
 *   Se o motor devolver sucesso e a pós-condição falhar, a resposta é uma
 *   RECUSA de confirmação (a UI diz "isolamento não confirmado"), nunca um
 *   sucesso — é exactamente o caso de falha parcial que não pode aparecer verde.
 *
 * Leituras reais permitidas (sem efeitos): `quarantine.list` e `threats.list`.
 *   São as duas únicas que a UI precisa para mostrar as abas. Todas as outras
 *   leituras do snapshot continuam a ser recusadas pelo gate e a UI classifica
 *   essas recusas como neutras (`serviceSyncStatus.ts`), não como avaria.
 *
 * Registo: um JSONL append-only em `<serviceBaseDir>/quarantine-harness-audit.jsonl`
 *   com decisão, motivo, alvo (nome relativo), digest e id de entrada. Nunca
 *   inclui caminhos do utilizador fora do fixture.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
// `dotenv/config` primeiro, para a ordem de avaliação ser a mesma de
// `packages/service/dist/index.js` (que o importa antes de `engine.js`).
import 'dotenv/config';
import { ProtectionEngineService } from '../packages/service/dist/engine.js';
import {
  estaContido,
  fixtureRootFromEnv,
  gateDeFixtureMontadoPara,
  identidadeAindaBate,
  obterSnapshotValidado,
} from '../packages/service/dist/dev-fixture-gate.js';
import { serviceBaseDir } from '../packages/service/dist/log-writer.js';
import { criarLeaseDiretorios } from './quarantine-dir-lease.mjs';

const MARCA = 'quarantine_fixture_harness';
const MANIFEST_SCHEMA = 'cybersafe-quarantine-fixture-v1';
const MARCA_INSTALADA = Symbol.for('cybersafe.quarantineFixtureHarness');

const LEITURAS_REAIS = new Set(['quarantine.list', 'threats.list']);
const ESCRITAS = new Set(['threat.action', 'quarantine.restore', 'quarantine.delete']);
/** Orçamento por processo. Um fluxo UI completo gasta 2+1+1. */
const ORCAMENTO = Object.freeze({ quarantine: 2, restore: 1, delete: 1 });

function abortar(motivo) {
  throw new Error(`${MARCA}: ${motivo}`);
}

/** Hash SHA-256 de um ficheiro, lido do disco agora (nunca de cache). */
function sha256DoFicheiro(ficheiro) {
  return crypto.createHash('sha256').update(fs.readFileSync(ficheiro)).digest('hex');
}

/** Mensagem de um erro sem perder o tipo original. */
function msgDe(erro) {
  return erro instanceof Error ? erro.message : String(erro);
}

function exigirFlag(nome, valor) {
  if (process.env[nome] !== valor) {
    abortar(`${nome} tem de ser "${valor}" (recebido: ${JSON.stringify(process.env[nome] ?? null)})`);
  }
}

/**
 * Valida o ambiente e devolve a identidade da sessão, relendo o disco.
 * Nada aqui escreve: se algo não fecha, o serviço não arranca.
 */
function carregarSessao() {
  if (process.env.NODE_ENV === 'production') abortar('NODE_ENV=production — este bootstrap é só de DEV');
  exigirFlag('CYBERSAFE_DEV_ISOLATION', '1');
  exigirFlag('CYBERSAFE_DEV_OWNED_CHILD', '1');
  exigirFlag('CYBERSAFE_REALDEV_FIXTURE_SCAN', '1');
  exigirFlag('CYBERSAFE_QUARANTINE_FIXTURE_SESSION', '1');
  exigirFlag('CYBERSAFE_USB_PROTECTION', '0');
  exigirFlag('CYBERSAFE_STARTUP_RESUME', '0');
  if (process.connected !== true) abortar('sem canal IPC do pai — o shutdown gracioso owned não está garantido');

  const raiz = fixtureRootFromEnv(process.env); // valida absoluto, reparse, raiz proibida
  const manifestoBruto = process.env.CYBERSAFE_QUARANTINE_FIXTURE_MANIFEST;
  if (!manifestoBruto || !path.isAbsolute(manifestoBruto)) {
    abortar('CYBERSAFE_QUARANTINE_FIXTURE_MANIFEST tem de ser um caminho absoluto');
  }
  let manifesto;
  try {
    manifesto = JSON.parse(fs.readFileSync(manifestoBruto, 'utf8'));
  } catch (erro) {
    abortar(`manifesto ilegível (${erro?.message ?? erro})`);
  }
  if (manifesto?.schema !== MANIFEST_SCHEMA) abortar(`manifesto com schema inesperado: ${String(manifesto?.schema)}`);
  if (typeof manifesto?.root !== 'string' || !path.isAbsolute(manifesto.root)) abortar('manifesto sem root absoluto');
  // Comparação directa com o realpath do ambiente: o manifesto é escrito pelo
  // harness com esse valor. Sem chamadas de filesystem sobre um caminho que
  // pode não existir — igualdade estrita (case-insensitive só no Windows).
  if (path.resolve(manifesto.root).toLowerCase() !== raiz.real.toLowerCase()) {
    abortar(`o root do manifesto não é a raiz de fixture do ambiente (${path.resolve(manifesto.root)} != ${raiz.real})`);
  }

  const alvoNome = manifesto?.quarantineTarget;
  if (typeof alvoNome !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(alvoNome)) {
    abortar('quarantineTarget tem de ser um nome simples (sem separadores, sem "..")');
  }

  const ficheiros = Array.isArray(manifesto?.files) ? manifesto.files : null;
  if (!ficheiros || ficheiros.length === 0) abortar('manifesto sem ficheiros');
  const porNome = new Map();
  for (const entrada of ficheiros) {
    const nome = entrada?.name;
    if (typeof nome !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(nome)) abortar(`nome inválido no manifesto: ${String(nome)}`);
    if (typeof entrada?.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entrada.sha256)) {
      abortar(`sha256 inválido para ${nome}`);
    }
    if (porNome.has(nome)) abortar(`nome repetido no manifesto: ${nome}`);
    const absoluto = path.join(raiz.real, nome);
    if (!estaContido(raiz.real, absoluto)) abortar(`ficheiro fora da raiz: ${nome}`);
    let st;
    try {
      st = fs.lstatSync(absoluto);
    } catch {
      abortar(`ficheiro do manifesto ausente no disco: ${nome}`);
    }
    if (!st.isFile() || st.isSymbolicLink()) abortar(`não é um ficheiro regular: ${nome}`);
    if (typeof entrada.bytes === 'number' && st.size !== entrada.bytes) {
      abortar(`tamanho diverge do manifesto em ${nome} (${st.size} != ${entrada.bytes})`);
    }
    const digest = sha256DoFicheiro(absoluto);
    if (digest !== entrada.sha256) abortar(`sha256 diverge do manifesto em ${nome}`);
    porNome.set(nome, { nome, absoluto, digest, bytes: st.size });
  }
  const alvo = porNome.get(alvoNome);
  if (!alvo) abortar(`quarantineTarget não está na lista de ficheiros: ${alvoNome}`);

  return {
    raizReal: raiz.real,
    alvo,
  };
}

function abrirAuditoria() {
  let baseDir;
  try {
    baseDir = serviceBaseDir();
  } catch (erro) {
    abortar(`serviceBaseDir indisponível (${erro?.message ?? erro}) — sem auditoria não há sessão`);
  }
  const ficheiro = path.join(baseDir, 'quarantine-harness-audit.jsonl');
  return (linha) => {
    try {
      fs.appendFileSync(ficheiro, `${JSON.stringify({ at: new Date().toISOString(), ...linha })}\n`, 'utf8');
    } catch {
      // A auditoria não pode derrubar o serviço; a recusa já foi decidida.
    }
  };
}

const sessao = carregarSessao();
const auditar = abrirAuditoria();
const gasto = { quarantine: 0, restore: 0, delete: 0 };
/** IDs criados nesta sessão: só estes podem ser restaurados ou eliminados. */
const idsDaSessao = new Set();
/** Escritas serializadas: com uma mutação em voo, outra é recusada (não entra em fila). */
let mutacaoEmVoo = false;

const recusa = (pedido, motivo, extra = {}) => {
  auditar({ method: pedido?.method, decision: 'refuse', reason: motivo, ...extra });
  return { id: String(pedido?.id ?? ''), type: 'response', ok: false, error: `${MARCA}: ${motivo}` };
};

/**
 * Contenção LEXICAL (sem filesystem): a raiz já foi validada por realpath em
 * `fixtureRootFromEnv`, e o caminho pedido é comparado de seguida com o alvo
 * exacto da sessão. Esta função só impede que um caminho de outro volume ou
 * fora da árvore chegue sequer a ser `lstat`ado.
 */
function dentroDaRaiz(alvo) {
  const raiz = sessao.raizReal.toLowerCase().replace(/[\\/]+$/, '');
  const caminho = path.resolve(alvo).toLowerCase();
  return caminho === raiz || caminho.startsWith(`${raiz}${path.sep}`);
}

/** Caminho do alvo, ou null quando o pedido não fala do alvo da sessão. */
function caminhoDoAlvo(pedido) {
  const bruto = pedido?.payload?.id;
  if (typeof bruto !== 'string' || bruto.trim() === '') return null;
  const semEsquema = bruto.startsWith('file://') ? decodeURIComponent(bruto.slice('file://'.length)) : bruto;
  if (!path.isAbsolute(semEsquema)) return null;
  return path.resolve(semEsquema);
}

/**
 * Instala a camada por cima do gate de fixture, no fim de `init()`.
 * O alvo é o `handleRequest` DA INSTÂNCIA (o gate já o substituiu) e o
 * original é o método do protótipo, para as duas leituras reais e para as
 * escritas validadas. Tudo o resto continua a passar pelo gate.
 */
function instalarCamada(servico) {
  if (servico?.[MARCA_INSTALADA]) abortar('camada já instalada nesta instância');
  const prova = gateDeFixtureMontadoPara(servico?.scanManager, process.env);
  if (!prova.montado) abortar(`gate de fixture não está montado (${prova.motivo}) — sem gate não há camada`);

  const portaGate = servico.handleRequest;
  if (typeof portaGate !== 'function') abortar('serviço sem handleRequest — o gate não pode ser respeitado');
  const handleRequestReal = ProtectionEngineService.prototype.handleRequest;
  if (typeof handleRequestReal !== 'function') abortar('sem handleRequest no protótipo do serviço');
  if (typeof servico.quarantine?.list !== 'function') abortar('serviço sem QuarantineManager.list — sem como provar IDs de sessão');

  const entradasDoAlvo = () =>
    servico.quarantine
      .list()
      .filter(
        (entrada) =>
          typeof entrada?.id === 'string' &&
          entrada.sha256 === sessao.alvo.digest &&
          typeof entrada.originalPath === 'string' &&
          path.resolve(entrada.originalPath) === sessao.alvo.absoluto,
      );

  /** Blob da quarentena: `<baseDir>/quarantine/<id>.quarantine` (ver QuarantineManager). */
  const caminhoDoBlob = (id) => {
    const base = typeof servico.baseDir === 'string' && servico.baseDir ? servico.baseDir : serviceBaseDir();
    return path.join(base, 'quarantine', `${id}.quarantine`);
  };

  /**
   * Snapshot do gate para esta raiz, reduzido a DIRETÓRIOS. A identidade
   * reconferida é a da RAIZ (volume/inode/tipo), porque é a raiz que vai ser
   * fixada: o leaf nunca entra na lease (o rename da quarentena tem de ser
   * possível) e é validado à parte — no isolamento tem de existir, ser regular,
   * sem reparse, nlink === 1 e com o digest da sessão; no restauro tem de estar
   * AUSENTE. Não se reutiliza a identidade do leaf capturada no scan: depois de
   * um restauro o inode é novo e isso não pode bloquear o ciclo seguinte.
   */
  const snapshotSoDiretorios = () => {
    const completo = obterSnapshotValidado(sessao.raizReal) ?? obterSnapshotValidado(sessao.alvo.absoluto);
    if (!completo || !(completo.nos instanceof Map)) {
      return { ok: false, motivo: 'sem snapshot validado do gate para esta raiz (é preciso analisar no Scanner)' };
    }
    const raizMudou = identidadeAindaBate(completo, sessao.raizReal);
    if (raizMudou) return { ok: false, motivo: `identidade da raiz mudou desde a validação: ${raizMudou}` };
    const raizSemBarra = sessao.raizReal.replace(/[\\/]+$/, '').toLowerCase();
    const nos = new Map();
    for (const [nome, identidade] of completo.nos) {
      if (String(nome).replace(/[\\/]+$/, '').toLowerCase() === raizSemBarra) nos.set(nome, identidade);
    }
    if (nos.size === 0 || !Array.from(nos.values()).every((id) => id?.tipo === 'dir')) {
      return { ok: false, motivo: 'snapshot do gate não contém a raiz como diretório' };
    }
    return { ok: true, snapshot: { ...completo, nos } };
  };

  /** Forma do leaf e conteúdo: recusa reparse/hardlink e digest divergente. */
  const sondaAlvo = () => {
    let st;
    try {
      st = fs.lstatSync(sessao.alvo.absoluto);
    } catch {
      return { ok: false, motivo: 'alvo ausente no disco' };
    }
    if (!st.isFile()) return { ok: false, motivo: 'alvo não é ficheiro regular' };
    if (st.isSymbolicLink()) return { ok: false, motivo: 'alvo é um ponto de reparse (symlink/junction) — recusado' };
    if (st.nlink !== 1) return { ok: false, motivo: `alvo tem ${st.nlink} ligações (hardlink) — recusado` };
    const digest = sha256DoFicheiro(sessao.alvo.absoluto);
    if (digest !== sessao.alvo.digest) {
      return { ok: false, motivo: 'os bytes do alvo são outros (digest atual != digest da sessão)' };
    }
    return { ok: true, digest };
  };

  /** Fixa a cadeia de diretórios com a lease share3 local; devolve a lease ou uma recusa já auditada. */
  const fixarDiretorios = (pedido, etapa) => {
    const dirs = snapshotSoDiretorios();
    if (!dirs.ok) return { ok: false, resposta: recusa(pedido, `${etapa}: ${dirs.motivo}`) };
    try {
      return { ok: true, lease: criarLeaseDiretorios(dirs.snapshot) };
    } catch (erro) {
      return {
        ok: false,
        resposta: recusa(pedido, `${etapa}: cadeia de diretórios não fixável (${msgDe(erro)})`),
      };
    }
  };

  const camada = async (pedido) => {
    const metodo = String(pedido?.method ?? '');

    if (LEITURAS_REAIS.has(metodo)) {
      // Só leitura, e só as duas que a UI precisa para as abas.
      return handleRequestReal.call(servico, pedido);
    }

    if (!ESCRITAS.has(metodo)) {
      // Gate de fixture: autoridade única para scan.start e para todas as recusas.
      return portaGate(pedido);
    }

    // Escritas: uma de cada vez. Uma segunda tentativa em voo é recusada — não
    // entra em fila, para o orçamento e os IDs de sessão não serem ultrapassados.
    if (mutacaoEmVoo) {
      return recusa(pedido, 'mutação em voo: escritas são serializadas (tentativa concorrente recusada)');
    }
    mutacaoEmVoo = true;
    let lease = null;
    try {
      if (metodo === 'threat.action') {
        const acao = pedido?.payload?.action;
        if (acao === 'restore' || acao === 'delete') {
          return recusa(pedido, `threat.action "${acao}" não é permitido: use quarantine.restore/quarantine.delete com o ID da sessão`);
        }
        if (acao !== 'quarantine') return recusa(pedido, `threat.action com ação não suportada: ${String(acao)}`);
        if (gasto.quarantine >= ORCAMENTO.quarantine) {
          return recusa(pedido, `orçamento de isolamentos esgotado (${ORCAMENTO.quarantine})`);
        }
        const digest = pedido?.payload?.sha256;
        if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/i.test(digest)) {
          return recusa(pedido, 'isolamento sem digest verificável');
        }
        if (digest.toLowerCase() !== sessao.alvo.digest) {
          return recusa(pedido, 'digest não é o do alvo da sessão', { digest: digest.toLowerCase() });
        }
        const alvo = caminhoDoAlvo(pedido);
        if (!alvo || !dentroDaRaiz(alvo)) {
          return recusa(pedido, 'isolamento fora da raiz do fixture');
        }
        if (path.resolve(alvo) !== sessao.alvo.absoluto) {
          return recusa(pedido, `isolamento pedido para outro caminho dentro do fixture: ${path.basename(alvo)}`);
        }
        const antes = sondaAlvo();
        if (!antes.ok) return recusa(pedido, `isolamento recusado: ${antes.motivo}`);

        const fixacao = fixarDiretorios(pedido, 'isolamento recusado');
        if (!fixacao.ok) return fixacao.resposta;
        lease = fixacao.lease;
        // Com a cadeia fixada, reconfirmar o leaf: forma, hardlink e conteúdo.
        const depois = sondaAlvo();
        if (!depois.ok) return recusa(pedido, `isolamento recusado após fixar diretórios: ${depois.motivo}`);

        const resposta = await handleRequestReal.call(servico, pedido);
        if (!(resposta?.ok === true && resposta?.result?.success === true)) {
          auditar({ method: metodo, decision: 'engine-refused', reason: String(resposta?.error ?? 'sem confirmação'), target: sessao.alvo.nome });
          return resposta;
        }
        // Pós-condição: alvo ausente + blob com o digest da sessão + entrada confirmada.
        const confirmadas = entradasDoAlvo().filter((entrada) => entrada.isolationStatus === 'confirmed');
        if (confirmadas.length === 0) {
          auditar({ method: metodo, decision: 'postcheck-failed', reason: 'sem entrada confirmada para o alvo', target: sessao.alvo.nome });
          return recusa(pedido, 'o motor devolveu sucesso mas não há entrada confirmada para este alvo — isolamento NÃO confirmado');
        }
        const alvoAusente = !fs.existsSync(sessao.alvo.absoluto);
        const provas = confirmadas.map((entrada) => {
          let digestDoBlob = null;
          try {
            digestDoBlob = sha256DoFicheiro(caminhoDoBlob(entrada.id));
          } catch {
            digestDoBlob = null;
          }
          return { id: entrada.id, blobDigestOk: digestDoBlob === sessao.alvo.digest };
        });
        if (!alvoAusente || provas.some((prova) => !prova.blobDigestOk)) {
          auditar({
            method: metodo,
            decision: 'postcheck-failed',
            reason: `alvoAindaPresente=${!alvoAusente} blobDigestOk=${provas.map((p) => p.blobDigestOk).join(',')}`,
            target: sessao.alvo.nome,
            entryIds: provas.map((p) => p.id),
          });
          return recusa(
            pedido,
            `pós-condição do isolamento falhou (alvo ainda presente: ${!alvoAusente}); isolamento NÃO confirmado`,
            { entryIds: provas.map((p) => p.id) },
          );
        }
        gasto.quarantine += 1;
        for (const prova of provas) idsDaSessao.add(prova.id);
        auditar({
          method: metodo,
          decision: 'allow',
          reason: 'isolamento com pós-condição verificada (alvo ausente + blob com o digest da sessão)',
          target: sessao.alvo.nome,
          digest: sessao.alvo.digest,
          entryIds: provas.map((p) => p.id),
        });
        return resposta;
      }

      // quarantine.restore | quarantine.delete
      const acao = metodo === 'quarantine.restore' ? 'restore' : 'delete';

      if (acao === 'restore') {
        // Só undefined/false. `1`, "false" e qualquer string são truthy no backend.
        const confianca = pedido?.payload?.trustAfterRestore;
        if (!(confianca === undefined || confianca === false)) {
          return recusa(
            pedido,
            `trustAfterRestore=${JSON.stringify(confianca)} recusado: só undefined ou false (qualquer outro valor altera a confiança)`,
          );
        }
      }
      if (gasto[acao] >= ORCAMENTO[acao]) return recusa(pedido, `orçamento de ${acao} esgotado (${ORCAMENTO[acao]})`);
      const id = pedido?.payload?.id;
      if (typeof id !== 'string' || id.trim() === '') return recusa(pedido, `${acao} sem id`);
      if (!idsDaSessao.has(id)) return recusa(pedido, `${acao} de um id que esta sessão não criou`);
      const entrada = servico.quarantine.list().find((item) => item?.id === id);
      if (!entrada) return recusa(pedido, `${acao} de uma entrada que já não existe`);
      if (entrada.sha256 !== sessao.alvo.digest) return recusa(pedido, `${acao} de uma entrada com outro digest`);
      if (typeof entrada.originalPath !== 'string' || path.resolve(entrada.originalPath) !== sessao.alvo.absoluto) {
        return recusa(pedido, `${acao} de uma entrada que não aponta para o alvo da sessão`);
      }

      if (acao === 'restore') {
        // Destino real do restauro: diretamente na raiz do fixture, sem reparse,
        // e ainda livre. O motor volta a validar antes de escrever.
        const destino = sessao.alvo.absoluto;
        const pai = path.dirname(destino);
        if (!dentroDaRaiz(destino) || path.resolve(pai).toLowerCase() !== sessao.raizReal.replace(/[\\/]+$/, '').toLowerCase()) {
          return recusa(pedido, 'destino de restauro não é diretamente na raiz do fixture');
        }
        let stPai;
        try {
          stPai = fs.lstatSync(pai);
        } catch {
          return recusa(pedido, 'diretório de destino do restauro ausente');
        }
        if (!stPai.isDirectory() || stPai.isSymbolicLink()) {
          return recusa(pedido, 'diretório de destino do restauro é reparse ou não é diretório');
        }
        if (fs.existsSync(destino)) return recusa(pedido, 'destino do restauro já existe — recusado');

        const fixacao = fixarDiretorios(pedido, 'restauro recusado');
        if (!fixacao.ok) return fixacao.resposta;
        lease = fixacao.lease;
        if (fs.existsSync(destino)) return recusa(pedido, 'destino do restauro apareceu durante a fixação — recusado');
      }

      const resposta = await handleRequestReal.call(servico, pedido);
      if (!(resposta?.ok === true && resposta?.result?.success === true)) {
        auditar({ method: metodo, decision: 'engine-refused', reason: String(resposta?.error ?? 'sem confirmação'), entryId: id });
        return resposta;
      }

      // Pós-condição por operação.
      const aindaNaLista = servico.quarantine.list().some((item) => item?.id === id);
      if (acao === 'restore') {
        const digestRestaurado = fs.existsSync(sessao.alvo.absoluto) ? sha256DoFicheiro(sessao.alvo.absoluto) : null;
        if (aindaNaLista || digestRestaurado !== sessao.alvo.digest) {
          auditar({ method: metodo, decision: 'postcheck-failed', reason: `aindaNaLista=${aindaNaLista} digestRestauradoOk=${digestRestaurado === sessao.alvo.digest}`, entryId: id });
          return recusa(pedido, 'o motor devolveu sucesso mas a pós-condição do restauro falhou — restauro NÃO confirmado', { entryId: id });
        }
      } else {
        const blobPresente = fs.existsSync(caminhoDoBlob(id));
        const alvoPresente = fs.existsSync(sessao.alvo.absoluto);
        if (aindaNaLista || blobPresente || alvoPresente) {
          auditar({ method: metodo, decision: 'postcheck-failed', reason: `aindaNaLista=${aindaNaLista} blobPresente=${blobPresente} alvoPresente=${alvoPresente}`, entryId: id });
          return recusa(pedido, 'o motor devolveu sucesso mas a pós-condição da eliminação falhou — eliminação NÃO confirmada', { entryId: id });
        }
      }

      gasto[acao] += 1;
      idsDaSessao.delete(id);
      auditar({
        method: metodo,
        decision: 'allow',
        reason: `${acao} com pós-condição verificada`,
        target: sessao.alvo.nome,
        digest: sessao.alvo.digest,
        entryId: id,
      });
      return resposta;
    } finally {
      // A lease é sempre libertada, mesmo quando o motor lança ou a validação
      // recusa depois de a ter obtido. Uma falha de libertação é auditada e não
      // esconde a resposta já decidida.
      if (lease) {
        try {
          lease.release();
        } catch (erro) {
          auditar({ method: 'release', decision: 'release-failed', reason: msgDe(erro), target: sessao.alvo.nome });
          console.error(`[Service] ${MARCA}: libertação da lease não confirmada (${msgDe(erro)})`);
        }
      }
      mutacaoEmVoo = false;
    }
  };

  Object.defineProperty(camada, MARCA_INSTALADA, { value: true });
  servico.handleRequest = camada;
  Object.defineProperty(servico, MARCA_INSTALADA, { value: true, configurable: false, enumerable: false });

  console.log(
    `[Service] camada de fixture de quarentena montada: alvo=${sessao.alvo.nome} digest=${sessao.alvo.digest.slice(0, 16)}… ` +
      `orçamento=${JSON.stringify(ORCAMENTO)} leituras=${Array.from(LEITURAS_REAIS).join(',')}`,
  );
  auditar({ method: 'install', decision: 'allow', reason: 'camada montada após init', target: sessao.alvo.nome, digest: sessao.alvo.digest });
}

// A instalação acontece DENTRO de `init()` (depois do init real), para que a
// camada fique por fora do gate e antes do `service-ready` sair ao Electron.
const proto = ProtectionEngineService.prototype;
const initOriginal = proto.init;
if (typeof initOriginal !== 'function') abortar('protótipo do serviço sem init');
proto.init = async function initComCamadaDeQuarentena(...args) {
  const resultado = await initOriginal.apply(this, args);
  if (!this[MARCA_INSTALADA]) instalarCamada(this);
  return resultado;
};

// Só agora o serviço real arranca: logging, crash handlers, gate, arranque
// progressivo, init, `service-ready`, signal handlers e shutdown owned são os
// de `index.js`, sem cópia nem reimplementação.
await import('../packages/service/dist/index.js');
