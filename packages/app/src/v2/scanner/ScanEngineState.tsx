import type { EngineHealth } from "@cybersafe/shared-types";
import { engineCards } from "@/v2/dashboard/model";

/**
 * Estado ATUAL dos motores dentro da Scanner.
 *
 * A derivação não é daqui: `engineCards` é a única fonte que transforma
 * `EngineHealth` em estado/legenda/cobertura, e vive no modelo do Painel.
 * Reimplementá-la aqui dava dois vocabulários para o mesmo facto do serviço.
 *
 * O que este bloco NÃO afirma: que os motores participaram em qualquer análise.
 * `EngineHealth` é um instantâneo de serviço; a participação de um motor numa
 * sessão específica só pode vir do contrato de resultados dessa sessão.
 */

export interface ScanEngineStateProps {
  engineHealth?: EngineHealth;
  serviceConnected?: boolean | null;
}

export function scanEngineStateView(
  engineHealth?: EngineHealth,
  serviceConnected?: boolean | null,
) {
  const confirmada = serviceConnected === true;
  const cards = engineCards(engineHealth, serviceConnected);
  return { cards, confirmada };
}

export function ScanEngineState({
  engineHealth,
  serviceConnected,
}: ScanEngineStateProps) {
  // Nada foi ligado ao App: não há instantâneo para mostrar, e um cartão de
  // «Sem leitura» aqui seria uma afirmação sobre o serviço que ninguém leu.
  if (engineHealth === undefined && serviceConnected === undefined) return null;

  const { cards, confirmada } = scanEngineStateView(engineHealth, serviceConnected);

  return (
    <section
      className="cs-v2-engine-state"
      data-testid="scan-engine-state"
      data-conexao={confirmada ? "confirmada" : "nao-confirmada"}
      aria-label="Estado atual dos motores"
    >
      <h3>Estado atual dos motores</h3>
      <p className="caption">
        {confirmada
          ? "Instantâneo do serviço nesta página. Não prova que estes motores participaram em nenhuma análise."
          : "Sem ligação confirmada ao serviço: nenhum motor comunica o seu estado nesta página."}
      </p>
      <div className="result-grid engine-state-grid">
        {cards.map((c) => (
          <span
            key={c.key}
            className="engine-state"
            data-engine={c.key}
            data-state={c.state.toLowerCase()}
            data-comunicado={confirmada && c.report ? "true" : "false"}
          >
            <strong>{c.name}</strong>
            <em>{c.label}</em>
            <small>{c.coverage}</small>
          </span>
        ))}
      </div>
    </section>
  );
}
