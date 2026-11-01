/**
 * Lote de quarentena: o resumo vem dos resultados POR FICHEIRO.
 *
 * Um lote em que o servico recusou metade nao e "concluido": e "3 de 6
 * restaurados, 3 recusados, entradas preservadas". Nada aqui executa o ficheiro
 * restaurado nem decide sobre bytes; so conta e descreve o que o servico disse.
 */
export type ResultadoLoteEntrada = {
  tipo: "confirmado" | "confirmado_com_aviso" | "recusado" | "sem_confirmacao";
};

export type TipoResumoLote = ResultadoLoteEntrada["tipo"];

export type ResumoLote = {
  total: number;
  confirmados: number;
  comAviso: number;
  recusados: number;
  semConfirmacao: number;
  naoTentados: number;
};

export function decidirResumoLote(
  resultados: readonly ResultadoLoteEntrada[],
  total: number,
): ResumoLote {
  const resumo: ResumoLote = {
    total,
    confirmados: 0,
    comAviso: 0,
    recusados: 0,
    semConfirmacao: 0,
    naoTentados: 0,
  };
  for (const resultado of resultados) {
    if (resultado.tipo === "confirmado") resumo.confirmados += 1;
    else if (resultado.tipo === "confirmado_com_aviso") {
      resumo.confirmados += 1;
      resumo.comAviso += 1;
    } else if (resultado.tipo === "recusado") resumo.recusados += 1;
    else resumo.semConfirmacao += 1;
  }
  resumo.naoTentados = Math.max(0, total - resultados.length);
  return resumo;
}

/** O estado do lote nunca e melhor do que o pior desfecho que ele contem. */
export function decidirTipoResumoLote(resumo: ResumoLote): TipoResumoLote {
  if (resumo.semConfirmacao > 0) return "sem_confirmacao";
  if (resumo.recusados > 0 || resumo.naoTentados > 0) return "recusado";
  if (resumo.comAviso > 0) return "confirmado_com_aviso";
  return "confirmado";
}

/** Descreve cada grupo com contagem; grupos vazios nao sao mencionados. */
export function textoResumoLote(resumo: ResumoLote, acao: "restore" | "delete"): string {
  const singular = acao === "restore" ? "restaurado" : "eliminado";
  const plural = acao === "restore" ? "restaurados" : "eliminados";
  const partes = [
    `${resumo.confirmados} de ${resumo.total} ${resumo.confirmados === 1 ? singular : plural}`,
  ];
  if (resumo.comAviso > 0) partes.push(`${resumo.comAviso} com aviso do servico`);
  if (resumo.recusados > 0) {
    partes.push(`${resumo.recusados} ${resumo.recusados === 1 ? "recusado" : "recusados"} — entradas preservadas`);
  }
  if (resumo.semConfirmacao > 0) partes.push(`${resumo.semConfirmacao} sem confirmacao do servico`);
  if (resumo.naoTentados > 0) {
    partes.push(`${resumo.naoTentados} ${resumo.naoTentados === 1 ? "nao tentado" : "nao tentados"}`);
  }
  return `${partes.join("; ")}.`;
}
