import { lstat } from "node:fs/promises";
import { lerPontosDeMontagemReais, type ResultadoPontosDeMontagem } from "@cybersafe/core";
import {
  hasReparseFreePath,
  isMountPointPath,
  isProtectedQuarantinePath,
  type QuarantinePathContext,
} from "./quarantine-path-policy.js";

/** Porquê de a quarentena ter recusado um caminho ao consultar as montagens. */
export type QuarantineMountRefusal = "mount-point" | "mount-table-unreadable" | "mount-table-incomplete";

/**
 * Que portão recusou. `not-found`, `inaccessible` e `not-a-file` existem para
 * que a ausência de um ficheiro nunca seja contada como «caminho protegido»:
 * a primeira diz que o alvo desapareceu, a segunda que não foi possível lê-lo,
 * e a terceira que o caminho não aponta para um ficheiro regular. Nenhuma
 * delas autoriza mover seja o que for.
 */
export type QuarantinePathRefusal =
  | "protected-path"
  | "not-found"
  | "inaccessible"
  | "not-a-file"
  | QuarantineMountRefusal;

/**
 * O caminho é proibido ao isolamento por ser (ou poder ser) um ponto de
 * montagem? Só em POSIX: em Windows não existem *mount points* com este
 * sentido, e o que lá redireciona caminhos já é apanhado pelo
 * `hasReparseFreePath`.
 *
 * As duas falhas de leitura recusam também. É a direção conservadora: não mover
 * é uma não-ação reversível (o ficheiro fica onde está, continua marcado como
 * malicioso, o pedido falha e fica auditado), enquanto mover um ponto de
 * montagem não é reversível por via nenhuma — e `mount-table-incomplete` quer
 * dizer precisamente «há linhas da tabela que não sei o que são», o que não
 * autoriza ninguém a afirmar que nenhuma delas monta este caminho. A consequência
 * é declarada: se um dia o formato do `mountinfo` mudar e o parser deixar de o
 * entender, o isolamento deixa de acontecer até o parser ser atualizado, em vez
 * de acontecer em cima de uma suposição.
 *
 * A tabela é injectável porque a pergunta é sobre a máquina de quem corre, e um
 * teste não tem o direito de responder por ela.
 */
export function quarantineMountRefusal(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
  readTable: () => ResultadoPontosDeMontagem = lerPontosDeMontagemReais,
): QuarantineMountRefusal | null {
  if (platform === "win32") return null;
  let tabela: ResultadoPontosDeMontagem;
  try {
    tabela = readTable();
  } catch {
    return "mount-table-unreadable";
  }
  if (!tabela.ok) return "mount-table-unreadable";
  if (tabela.ilegiveis > 0) return "mount-table-incomplete";
  return isMountPointPath(filePath, tabela.montagens) ? "mount-point" : null;
}

export interface QuarantineGateSources {
  /** injectável porque a pergunta das montagens só existe fora de Windows */
  platform?: NodeJS.Platform;
  /** injectável porque é um `realpath` no sistema de ficheiros de quem corre */
  reparseFree?: (filePath: string) => Promise<boolean>;
  /** injectável para distinguir ausência/inacessibilidade de link redirecionado */
  statFile?: (filePath: string) => Promise<{ isFile(): boolean }>;
  tabelaDeMontagens?: () => ResultadoPontosDeMontagem;
}

/**
 * O portão completo do `requestQuarantine`: raízes protegidas, existência,
 * links e (só POSIX) montagens. A ordem não é cosmética. A raiz protegida vem
 * primeiro porque é uma recusa de política que não precisa do disco; a
 * existência vem antes do `realpath` porque `hasReparseFreePath` devolve
 * `false` tanto para um link como para um `ENOENT`, e essa indistinção era o
 * defeito: um ficheiro que já não existia era anunciado como «caminho
 * protegido», escondendo a causa real. `statFile` é injectável para os testes
 * do portão não dependerem de caminhos reais.
 *
 * Vive aqui e não dentro do motor por uma razão de teste: o motor é a única
 * consumidora, mas instanciá-lo para provar um `if` seria pagar a máquina
 * inteira (pipes, SQLite, watchers) por três linhas. Assim, o que o motor chama
 * é o que os testes exercitam, razão de recusa incluída.
 */
export async function quarantinePathRefusal(
  filePath: string,
  context: QuarantinePathContext,
  sources: QuarantineGateSources = {},
): Promise<QuarantinePathRefusal | null> {
  if (isProtectedQuarantinePath(filePath, context)) return "protected-path";
  let info: { isFile(): boolean };
  try {
    info = await (sources.statFile ?? lstat)(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return "not-found";
    return "inaccessible";
  }
  if (!info.isFile()) return "not-a-file";
  if (!(await (sources.reparseFree ?? hasReparseFreePath)(filePath))) return "protected-path";
  return quarantineMountRefusal(
    filePath,
    sources.platform ?? process.platform,
    sources.tabelaDeMontagens ?? lerPontosDeMontagemReais,
  );
}
