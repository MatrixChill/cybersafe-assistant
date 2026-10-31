/**
 * TP-RETOMA-04 · mapa do port visual LAB V2 -> PC Center.
 * O port é uma ADAPTAÇÃO de composição: o cabeçalho/métricas/temperaturas do LAB
 * ficam ACIMA das vistas originais, que continuam a ser renderizadas como
 * children (perCore, frequência, discos físicos, HardwareDetailPanel, etc.).
 */

export const LEITURAS_OBRIGATORIAS = [
  'cpu.uso',
  'cpu.temperatura',
  'cpu.perCore',
  'cpu.frequencia',
  'gpu.uso',
  'gpu.temperatura',
  'gpu.hotspot',
  'gpu.memoryJunction',
  'gpu.vram',
  'ram.uso',
  'disco.uso',
  'disco.fisica',
  'rede.rx',
  'rede.tx',
  'bateria.percent',
] as const;

export type LeituraObrigatoria = (typeof LEITURAS_OBRIGATORIAS)[number];

export interface SecaoVisual {
  id: 'cabecalho' | 'metricas' | 'temperaturas' | 'vistas-originais';
  titulo: string;
  leituras: LeituraObrigatoria[];
  /** Composição LAB adaptada (não é import literal de primitivas). */
  lab: string;
}

export const SECOES_VISUAIS: SecaoVisual[] = [
  { id: 'cabecalho', titulo: 'Conhece o ritmo do teu PC.', leituras: [], lab: 'PageHead (adaptado)' },
  { id: 'metricas', titulo: 'Recursos', leituras: ['cpu.uso', 'gpu.uso', 'ram.uso', 'disco.uso'], lab: 'Metric + Chart (adaptados a TelemetrySparkline real)' },
  { id: 'temperaturas', titulo: 'Temperaturas e sensores', leituras: ['cpu.temperatura', 'gpu.temperatura', 'gpu.hotspot', 'gpu.memoryJunction'], lab: 'Panel + Badge (adaptados; estados via leiturasDe)' },
  { id: 'vistas-originais', titulo: 'Vistas originais preservadas', leituras: ['cpu.perCore', 'cpu.frequencia', 'gpu.vram', 'disco.fisica', 'rede.rx', 'rede.tx', 'bateria.percent'], lab: 'SimpleView/AdvancedView + HardwareDetailPanel (preservados como children)' },
];

export function leiturasCobertas(secoes: SecaoVisual[] = SECOES_VISUAIS): Set<LeituraObrigatoria> {
  const cobertas = new Set<LeituraObrigatoria>();
  for (const s of secoes) for (const l of s.leituras) cobertas.add(l);
  return cobertas;
}

export function validarMapaVisual(secoes: SecaoVisual[] = SECOES_VISUAIS): { ok: boolean; faltam: LeituraObrigatoria[] } {
  const cobertas = leiturasCobertas(secoes);
  const faltam = LEITURAS_OBRIGATORIAS.filter((l) => !cobertas.has(l));
  return { ok: faltam.length === 0, faltam };
}

/** O modo muda as children originais; a composição LAB mantém-se visível. */
export function secoesPorModo(_modo: 'simples' | 'avancado', secoes: SecaoVisual[] = SECOES_VISUAIS): SecaoVisual[] {
  return secoes;
}
