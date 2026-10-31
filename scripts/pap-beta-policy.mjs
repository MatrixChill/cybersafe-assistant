/** Política parcial de QA: não autoriza distribuição nem substitui o freeze. */
export function avaliarBeta({ optIn, marker, provenance } = {}) {
  const o = provenance?.obrigacaoPorResolver;
  const r = o?.residuos;
  const permitido = optIn === '1'
    && marker?.schema === 1 && marker.perfil === 'PAP_BETA_TEST'
    && marker.distribuicao === 'NAO_AUTORIZADA' && marker.pendencia === 'ascii_tree@0.1.1'
    && o?.bloqueador === true && Array.isArray(r) && r.length === 1
    && r[0]?.componente === 'ascii_tree' && r[0]?.versao === '0.1.1';
  return { permitido, conformidade: 'NAO_COMPROVADA', distribuicao: 'NAO_AUTORIZADA' };
}
