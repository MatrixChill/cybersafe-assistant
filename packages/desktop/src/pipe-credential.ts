/**
 * Credencial do named pipe, POR INSTALAÇÃO (TP-QA2-READINESS-20261025).
 *
 * O mecanismo, lido no fonte: o `main.ts` gerava a credencial com
 * `randomBytes(32)` ao importar o módulo — um valor novo por processo Electron,
 * nunca guardado. Um serviço filho que sobrevivesse ao pai (crash, `app.exit(0)`
 * no prazo do `before-quit`, restauro de snapshot, reboot com arranque
 * automático) continuava a servir o pipe com a credencial antiga. O arranque
 * seguinte decidia "há um serviço vivo" por um probe que só prova que existe um
 * listener, autenticava com a credencial nova, era recusado, e nunca mais
 * conseguia falar com o serviço — nem se fechasse e reabrisse.
 *
 * O que foi MEDIDO, e onde: esta foi reproduzido no HOST e na LANE (motor real
 * do serviço + cliente real do desktop, pipe e dados isolados). O estado
 * resultante — janela aberta, ProtectionHealth/PcState/sensores por confirmar,
 * modo limitado, gestor de tarefas vazio — é o que foi reportado na VM QA1, mas
 * NÃO há logs da VM para esta causa: sem eles, não se pode afirmar que o
 * arranque em causa tinha um serviço órfão, nem qual foi a causa do primeiro
 * arranque. A prova em host/lane mostra o defeito e a correção; a atribuição
 * ao episódio da VM fica em aberto (`deliverable/colher-logs-vm.ps1`).
 *
 * A credência passa o desenho já provado para o segredo JWT da API
 * (`api-lifecycle.ts`): gerada uma vez, persistida FORA do pacote no `userData`,
 * estável entre arranques. Continua a ser segredo — um processo de outro
 * utilizador ou de outra instalação não o conhece — mas deixa de ser
 * improvável por construção. Nota de ordem: o módulo principal lê esta
 * credência ANTES de `requestSingleInstanceLock()`, por isso dois arranques
 * podem chegar aqui em simultâneo; a publicação é `wx` no destino e quem chega
 * depois ADOTA o vencedor (ver `readExisting`), o que torna a divergência
 * impossível sem depender do lock.
 *
 * O que NÃO se faz:
 *  - escrever dentro do artefacto (o pacote é partilhado e só deve conter
 *    ficheiros imutáveis);
 *  - substituir em silêncio um ficheiro inválido ou a credência de outro
 *    criador (isso re-criaria exatamente o lockout que este módulo corrige);
 *  - seguir symlink ou hardlink: a posse é do próprio nodo;
 *  - registar o valor em lado nenhum — só o caminho aparece nos logs.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Nome do ficheiro dentro de `<userData>/secrets`. */
export const PIPE_CREDENTIAL_FILENAME = "pipe-credential";
/** 32 bytes → 64 hex: a forma exata que o serviço exige (`/^[a-f0-9]{64}$/`). */
export const PIPE_CREDENTIAL_BYTES = 32;
export const PIPE_CREDENTIAL_PATTERN = /^[a-f0-9]{64}$/;

/** Caminhos que pertencem ao artefacto, não à instalação. */
const PACKAGE_PATH_PATTERNS = [/app\.asar/i, /[\\/][Rr]esources[\\/]app([\\/]|$)/];

export interface PipeCredentialInfo {
  credential: string;
  /** true quando o ficheiro não existia e foi criado agora. */
  created: boolean;
  credentialPath: string;
}

export interface PipeCredentialDeps {
  fsImpl?: Pick<
    typeof fs,
    | "existsSync" | "readFileSync" | "writeFileSync" | "mkdirSync" | "chmodSync" | "lstatSync"
  >;
  generate?: () => string;
}

function looksLikePackage(candidate: string): boolean {
  return PACKAGE_PATH_PATTERNS.some((pattern) => pattern.test(candidate));
}

/**
 * Recusa symlink e hardlink sem seguir nada: `lstat` lê o próprio nodo, não o
 * destino. `mustExist` é para o ficheiro de credência (que se sabe existir);
 * para `secrets/` a ausência é o caminho normal do primeiro arranque.
 */
function refuseLinks(
  f: Pick<typeof fs, "lstatSync">,
  label: string,
  target: string,
  mustExist = false,
): void {
  let stats: fs.Stats;
  try {
    stats = f.lstatSync(target);
  } catch (error) {
    if (mustExist) throw error;
    return;
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`Credência do pipe recusada: ${label} em ${target} é um link simbólico e não um ficheiro desta instalação.`);
  }
  if (stats.nlink > 1) {
    throw new Error(`Credência do pipe recusada: ${label} em ${target} tem ${stats.nlink} ligações físicas (partilharia a credência com outra instalação).`);
  }
}

function randomCredential(): string {
  return crypto.randomBytes(PIPE_CREDENTIAL_BYTES).toString("hex");
}

/**
 * Lê a credência que está NO destino e valida a forma. É o caminho do vencedor
 * na criação concorrente: o que foi publicado primeiro manda, e adota-se —
 * inclusive quando o conteúdo publicado é inutilizável, caso em que se lança com
 * instruções explícitas em vez de se rodar em silêncio.
 */
function readExisting(
  f: Pick<typeof fs, "lstatSync" | "readFileSync">,
  credentialPath: string,
): string {
  refuseLinks(f, PIPE_CREDENTIAL_FILENAME, credentialPath, true);
  const current = String(f.readFileSync(credentialPath, "utf8")).trim();
  if (PIPE_CREDENTIAL_PATTERN.test(current)) return current;
  throw new Error(
    `Credência do pipe inválida em ${credentialPath}: esperado 64 hex. ` +
      "Não é substituída automaticamente (um serviço vivo continuaria com a antiga e o lockout voltava); " +
      "apague o ficheiro explicitamente para gerar uma nova.",
  );
}

/**
 * Lê a credência desta instalação ou cria-a no primeiro arranque.
 * Lança sempre que o estado em disco não é utilizável — o chamador decide o
 * que mostrar; nunca rodamos a credência por detrás de um serviço vivo.
 */
export function readOrCreatePipeCredential(
  userDataDir: string,
  deps: PipeCredentialDeps = {},
): PipeCredentialInfo {
  const f = deps.fsImpl ?? fs;
  const makeCredential = deps.generate ?? randomCredential;

  if (!userDataDir || !path.isAbsolute(userDataDir)) {
    throw new Error(`userDataDir do pipe inválido: esperado caminho absoluto, recebido ${String(userDataDir)}`);
  }
  if (looksLikePackage(userDataDir)) {
    throw new Error(
      `A credência do pipe não pode viver dentro do pacote (${userDataDir}): ficaria partilhada por todas as instalações do artefacto.`,
    );
  }

  const secretsDir = path.join(userDataDir, "secrets");
  const credentialPath = path.join(secretsDir, PIPE_CREDENTIAL_FILENAME);

  // Nada é lido ou escrito através de um link. A credência só vale se o ficheiro
  // for mesmo desta instalação: um symlink apontaria para outro lado, e um
  // hardlink faria duas instalações partilharem o mesmo segredo — que é
  // exatamente a posse que o pipe tem de provar.
  refuseLinks(f, "secrets", secretsDir);
  if (f.existsSync(credentialPath)) {
    return { credential: readExisting(f, credentialPath), created: false, credentialPath };
  }

  const credential = makeCredential();
  if (!PIPE_CREDENTIAL_PATTERN.test(credential)) {
    throw new Error("Credência gerada não tem a forma exigida pelo serviço; nada foi escrito.");
  }

  f.mkdirSync(secretsDir, { recursive: true });
  refuseLinks(f, "secrets", secretsDir);

  // Publicação no DESTINO com criação exclusiva (`wx`), não por tmp + rename.
  // Um `rename` por cima do ficheiro escrito entre a leitura e a publicação
  // apaga o vencedor: dois arranques que chegam ao mesmo tempo (e o módulo
  // principal gera esta credência ANTES de `requestSingleInstanceLock()`, por
  // isso acontece) ficariam cada um com a sua — exatamente o lockout que este
  // ficheiro existe para impedir. `wx` falha com `EEXIST` se alguém publicou
  // primeiro, e essa falha é o que nos diz para ADOTAR o vencedor: nunca
  // ignorar o erro, nunca substituir a credência de outrem.
  try {
    f.writeFileSync(credentialPath, `${credential}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
      return { credential: readExisting(f, credentialPath), created: false, credentialPath };
    }
    throw error;
  }
  try {
    // O Windows mapeia isto de forma parcial; nunca é motivo para falhar o arranque.
    f.chmodSync(credentialPath, 0o600);
  } catch {
    /* permissões melhor-esforço */
  }

  return { credential, created: true, credentialPath };
}
