import { Cpu, Database, Layers, Shield } from "lucide-react";
import type { EngineHealth } from "@cybersafe/shared-types";
import { engineStatusText } from "../../lib/protectionHealth";

/* ═══ CS-V2 · fase 2 (TP-PAP-DESIGN-V2-PHASE2-20261027) ══════════════════
   Um cartão por motor, os quatro SEMPRE presentes.

   Porque existe: o `engineDadoLinhas` do Dashboard só escreve quando o estado
   NÃO é `active`. Medido na base: com os quatro motores ativos, o Dashboard não
   dizia nada de cada um — ficava só o agregado «Motores ativos: N de M». O
   critério da PAP pede os quatro em separado, cada um com o seu estado
   verdadeiro; um motor verde sem cartão é um motor verde sem prova visível.

   O que este componente afirma, e o que se recusa a afirmar:
    - o estado vem exclusivamente de `EngineHealth.<chave>.status`, campos que já
      existem no contrato partilhado (`yara`, `hashDb`, `clamav`, `nativeEngine`).
      Nenhum campo novo, nenhuma chave inventada;
    - sem relatório, sem ligação ao serviço, sem a chave do motor no relatório,
      ou com um `status` fora dos quatro do contrato → «Sem leitura» / «Estado
      desconhecido». **Nunca `active` por omissão**;
    - `conexao !== true` mostra «Sem leitura» mesmo havendo dados em memória. Um
      valor conhecido-mas-antigo apresentado como estado de agora seria exatamente
      a mentira que a faixa `dashboard-stale-service` já vem advertir;
    - MOEDA — o que `conexao === true` NÃO prova. `serviceConnected` afirma que a
      conduta ao serviço está estabelecida (`App.tsx:504-527`); não afirma que a
      leitura é de agora. `App.tsx:462-465` retém deliberadamente o último estado
      confirmado quando uma atualização falha, com o comentário «a UI nunca inventa
      um estado em cima do silêncio» — portanto, com serviço ligado, o que está em
      memória pode ser anterior à última tentativa. Como não há marca temporal da
      leitura no contrato (`EngineHealth` traz apenas `definitionsUpdatedAt`, hora
      de DEFINIÇÕES, e `lastEventAt`, hora do último evento do tempo real — nenhum
      deles é a hora deste relatório), a idade não pode ser mostrada: `snapshotAgeText`
      inventar frescura. O que se faz é pôr o verbo no pretérito: as frases por
      cartão dizem o que o serviço REPORTOU, e a legenda declara a proveniência e
      que a idade não é afirmada. «Reporta … nesta leitura» era uma afirmação de
      atualidade que nada sustenta.
    - o `detail` do serviço NÃO é impresso aqui. Lido no código dos motores, o
      detalhe traz caminhos locais do utilizador e jargão do motor. Este painel é
      superfície de resumo; o texto técnico, com o acesso apropriado, já vive em
      `ProtectionDetails`. Aqui só aparecem frases PT-PT fixas, escolhidas pelo
      estado — o componente descreve o que o serviço reportou, não o motivo que
      ele não explicou;
    - `coverage` é uma string: `"normal" | "limited" | "unknown"` (não um objeto
      com `.kind`). Ausente = serviço antigo: diz-se «não comunicada», nunca
      «normal» — a documentação do próprio tipo obriga a tratar ausência como
      desconhecido. E `normal` com motor não-ativo desce a «não verificada», que
      é a regra que `ProtectionDetails.coberturaUserCopy` já aplica;
    - nenhum contador. Nada aqui escreve «N ficheiros analisados»: o contrato não
      transporta contagens por motor, e inventá-las era a falha que a PAP proíbe.
   ========================================================================== */

export type ChaveMotorPainel = "yara" | "hashDb" | "clamav" | "nativeEngine";

export const MOTORES_PAINEL: { chave: ChaveMotorPainel; nome: string; icon: typeof Cpu }[] = [
  /* Rótulo genérico de propósito: o serviço corre YARA clássico 4.6.0, não
     YARA-X, e «YARA» é verdadeiro para os dois. O contrato não tem campo de
     identidade do motor, por isso não se inventa um aqui. */
  { chave: "yara", nome: "YARA", icon: Layers },
  { chave: "hashDb", nome: "Base de assinaturas", icon: Database },
  { chave: "clamav", nome: "ClamAV", icon: Shield },
  { chave: "nativeEngine", nome: "Motor nativo", icon: Cpu },
];

/** Frases fixas por estado. Dizem o que o relatório AFIRMOU — nunca a causa, e
    nunca «agora»: o pretérito é o tempo que os dados sustentam. */
const ESTADO_PAINEL: Record<string, string> = {
  active: "O serviço reportou este motor como operacional no relatório recebido.",
  degraded: "O serviço reportou capacidade parcial neste motor.",
  unavailable: "O serviço reportou este motor como não disponível.",
  error: "O serviço reportou um erro neste motor.",
  "sem-leitura": "Sem leitura do serviço para este motor.",
};

export const SEM_LEITURA = "Sem leitura";

function coberturaPainel(
  coverage: string | undefined,
  estado: string,
): { texto: string; valor: string } {
  if (estado === "sem-leitura")
    return { texto: ESTADO_PAINEL["sem-leitura"], valor: "sem-leitura" };
  if (coverage === "limited") return { texto: "Cobertura limitada", valor: "limited" };
  if (coverage === "normal" && estado === "active")
    return { texto: "Cobertura comunicada como normal pelo serviço", valor: "normal" };
  if (coverage === "normal" || coverage === "unknown")
    return { texto: "Cobertura não verificada", valor: "unknown" };
  // Ausente: não inventar. «Não comunicada» é a afirmação mais forte que os dados permitem.
  return { texto: "Cobertura não comunicada por este serviço", valor: "ausente" };
}

export function EngineGrid({
  engine,
  conexao = null,
}: {
  engine?: EngineHealth;
  /**
   * Ligação ao serviço, tal como a prop `serviceConnected` do Dashboard:
   * `boolean | null`, com `null` a significar «ainda não confirmado» — não
   * «desligado». Só com `true` o cartão mostra o estado que o serviço reportou.
   * Fail-closed, porque `false` e `null` dão ambos um controlo não acionável
   * (`DashboardPage.tsx:51`) e um snapshot antigo pintado como atual seria a
   * mesma classe de defeito que a faixa `dashboard-stale-service` combate.
   * Nota: `true` afirma a conduta, não a hora da leitura — ver MOEDA acima.
   */
  conexao?: boolean | null;
}) {
  const confirmada = conexao === true;
  const subsistema = (chave: ChaveMotorPainel) => {
    if (!confirmada) return undefined;
    const s = engine?.[chave];
    // Um objeto sem `status` legível não é um estado: é ausência de leitura.
    return s && typeof s.status === "string" ? s : undefined;
  };

  return (
    <section
      aria-label="Motores de análise"
      data-testid="engine-grid"
      data-conexao={confirmada ? "confirmada" : conexao === false ? "desligada" : "nao-confirmada"}
      className="grid grid-cols-2 items-stretch gap-2 lg:grid-cols-4"
    >
      {!confirmada && (
        <p
          className="col-span-full cs-engine-caption font-mono text-[11px] leading-snug text-muted-foreground"
          data-nivel="aviso"
        >
          {conexao === false
            ? "Serviço desligado: os cartões abaixo não são uma leitura atual dos motores."
            : "Ligação ao serviço não confirmada: os cartões abaixo não são uma leitura atual dos motores."}
        </p>
      )}
      {confirmada && (
        <p
          className="col-span-full cs-engine-caption font-mono text-[11px] leading-snug text-muted-foreground"
          data-nivel="proveniencia"
        >
          Ligação confirmada: os cartões mostram o que o serviço reportou no último
          relatório recebido. A hora dessa leitura não vem no contrato, por isso a
          sua idade não é afirmada.
        </p>
      )}
      {MOTORES_PAINEL.map(({ chave, nome, icon: Icon }) => {
        const s = subsistema(chave);
        const estado = s ? s.status : "sem-leitura";
        const cob = coberturaPainel(s?.coverage, estado);
        return (
          <div
            key={chave}
            className="stat-card cs-engine-card p-3"
            data-engine={chave}
            data-state={estado}
            data-coverage={cob.valor}
          >
            {/* O nome é a identidade do motor, não decoração: cortá-lo a meio
                («Base de assinatu…») deixava o cartão ATIVO sem dono. Ele quebra
                ao limite da palavra; o estado nunca é comprimido nem partido —
                se não couber na linha, desce para a sua própria. */}
            <div className="cs-engine-head flex flex-wrap items-start gap-x-2 gap-y-1">
              <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="cs-engine-nome min-w-0 flex-1 basis-24 text-sm font-semibold leading-tight text-foreground">
                {nome}
              </span>
              <span
                className="cs-engine-state shrink-0 whitespace-nowrap font-mono text-[11px] uppercase tracking-wider"
                data-state={estado}
              >
                {s ? engineStatusText(s.status) : SEM_LEITURA}
              </span>
            </div>
            <p className="mt-1 text-xs leading-snug text-muted-foreground">
              {ESTADO_PAINEL[estado] ?? "Estado fora do contrato — não interpretado."}
            </p>
            <p className="cs-engine-coverage mt-1 font-mono text-[11px] text-muted-foreground">
              {cob.texto}
            </p>
          </div>
        );
      })}
    </section>
  );
}
