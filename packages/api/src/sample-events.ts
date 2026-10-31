/**
 * Política e inserção dos eventos de exemplo da API (AUD-001), isoladas do
 * módulo de base de dados para poderem ser testadas sem abrir uma DB real.
 *
 * Regra revista (review Codex): a amostra exige modo `development` ou `test`
 * EXPLÍCITO **e** opt-in. `NODE_ENV` ausente, `staging` ou qualquer outro valor
 * não autoriza. Produção nunca autoriza. Nada é apagado de bases existentes.
 */
export const SAMPLE_EVENTS_ENV = "CYBERSAFE_API_SAMPLE_EVENTS";

export function sampleEventsAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  const mode = String(env.NODE_ENV ?? "").trim();
  if (mode !== "development" && mode !== "test") return false;
  return env[SAMPLE_EVENTS_ENV] === "1";
}

export interface SampleThreatEvent {
  source: string;
  url: string;
  domain: string;
  severity: string;
  confidence: number;
  rulesTriggered: string[];
  createdAt: Date;
}

/** Dados fictícios de demonstração. Só chegam à DB por opt-in. */
export function buildSampleThreatEvents(now: number = Date.now()): SampleThreatEvent[] {
  return [
    {
      source: "dashboard",
      url: "file://suspicious-file.exe",
      domain: "file-scan",
      severity: "critical",
      confidence: 0.98,
      rulesTriggered: ["dangerous_file_extension", "heuristic_match"],
      createdAt: new Date(now - 1000 * 60 * 5),
    },
    {
      source: "extension",
      url: "http://phishing-site.net/login",
      domain: "phishing-site.net",
      severity: "high",
      confidence: 0.85,
      rulesTriggered: ["known_phishing_domain"],
      createdAt: new Date(now - 1000 * 60 * 15),
    },
  ];
}

export interface SampleSeedDeps {
  env?: NodeJS.ProcessEnv;
  countThreatEvents: () => number;
  createThreatEvents: (data: SampleThreatEvent[]) => Promise<unknown> | unknown;
  now?: () => number;
}

/** Inserção real, com dependências injectáveis (DB falsa nos testes). */
export async function seedSampleThreatEventsWith(deps: SampleSeedDeps): Promise<number> {
  if (!sampleEventsAllowed(deps.env)) return 0;
  if (deps.countThreatEvents() > 0) return 0;
  const data = buildSampleThreatEvents((deps.now ?? Date.now)());
  await deps.createThreatEvents(data);
  return data.length;
}
