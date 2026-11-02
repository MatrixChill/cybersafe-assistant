import { lerPontosDeMontagemReais, type ResultadoPontosDeMontagem } from "@cybersafe/core";
import { isMountPointPath } from "./quarantine-path-policy.js";

/** Porquê de a quarentena ter recusado um caminho ao consultar as montagens. */
export type QuarantineMountRefusal = "mount-point" | "mount-table-unreadable" | "mount-table-incomplete";

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
