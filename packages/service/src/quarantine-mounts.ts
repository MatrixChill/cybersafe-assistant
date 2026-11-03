import { lerPontosDeMontagemReais, type ResultadoPontosDeMontagem } from "@cybersafe/core";
import {
  hasReparseFreePath,
  isMountPointPath,
  isProtectedQuarantinePath,
  type QuarantinePathContext,
} from "./quarantine-path-policy.js";

/** Porquê de a quarentena ter recusado um caminho ao consultar as montagens. */
export type QuarantineMountRefusal = "mount-point" | "mount-table-unreadable" | "mount-table-incomplete";

/** Que portão recusou: o mesmo `protected-path` de sempre, ou um dos três novos. */
export type QuarantinePathRefusal = "protected-path" | QuarantineMountRefusal;

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
  tabelaDeMontagens?: () => ResultadoPontosDeMontagem;
}

/**
 * O portão completo do `requestQuarantine`, na mesma ordem de sempre — raízes
 * protegidas, depois links, depois (só POSIX) montagens — e com a mesma
 * preguiça: um caminho protegido não chega a ser `realpath`-ado.
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
  if (!(await (sources.reparseFree ?? hasReparseFreePath)(filePath))) return "protected-path";
  return quarantineMountRefusal(
    filePath,
    sources.platform ?? process.platform,
    sources.tabelaDeMontagens ?? lerPontosDeMontagemReais,
  );
}
