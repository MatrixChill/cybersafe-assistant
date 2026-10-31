import { useMemo } from "react";
import { AlertTriangle, HelpCircle, ShieldCheck } from "lucide-react";
import type { HardwareSnapshot, PcState } from "@cybersafe/shared-types";
import { cpuUsageDisplay } from "@/lib/cpuUsage";
import { ramUsageDisplay } from "@/lib/ramUsageDisplay";
import { networkReadingDisplay } from "@/lib/networkReadings";
import { temperatureDisplay } from "@/lib/temperature";
import { gpuPresence } from "@/lib/gpuDisplay";
import { buildExplicacoes, leiturasDe, type Certeza, type HelpersLeitura } from "@/lib/pccenter/explanations";

interface PcExplanationsProps {
  hardware: HardwareSnapshot | null;
  pcState?: PcState | null;
}

/** Helpers REAIS do produto — o adaptador honra o temperatureStatus neles descrito. */
const HELPERS: HelpersLeitura = {
  cpuUsage: (cpu) => cpuUsageDisplay(cpu as never),
  ramUsage: (ram) => ramUsageDisplay(ram as never),
  rede: (rede) => networkReadingDisplay(rede as never),
  temperatura: (valor) => temperatureDisplay(valor),
  presencia: (gpu) => gpuPresence(gpu as never),
};

const ETIQUETA_CERTEZA: Record<Certeza, string> = {
  medido: "medido",
  cache: "cache",
  desconhecido: "desconhecido",
};

const CLASSE_CERTEZA: Record<Certeza, string> = {
  medido: "text-primary",
  cache: "text-muted-foreground",
  desconhecido: "text-muted-foreground/70",
};

function formatarValor(valor: string | number | null, unidade: string | null): string {
  if (valor == null) return "—";
  if (typeof valor === "number") {
    const texto = Number.isInteger(valor) ? String(valor) : valor.toFixed(1);
    return unidade ? `${texto} ${unidade}` : texto;
  }
  return unidade ? `${valor} ${unidade}` : valor;
}

const TEXTO_RESUMO: Record<string, string> = {
  hipoteses: "Há hipóteses a explicar com base nas leituras medidas.",
  "leituras-disponiveis": "Sem hipótese gerada pelas regras desta secção (não é uma avaliação de normalidade do PC).",
  "faltam-leituras": "Faltam leituras válidas para sustentar hipóteses.",
};

/**
 * Explicações locais do PC Center: factos com fonte/estado, hipóteses com
 * base/contra, recomendações reversíveis e os limites declarados. Não envia
 * nada, não altera nada e não trata cache como medição atual.
 */
export default function PcExplanations({ hardware }: PcExplanationsProps) {
  const explicacoes = useMemo(
    () =>
      buildExplicacoes({
        leituras: leiturasDe(hardware, HELPERS),
        extras: {
          vramUsedMb: hardware?.gpu?.available === false ? null : hardware?.gpu?.vramUsedMb ?? null,
          vramTotalMb: hardware?.gpu?.vramTotalMb ?? null,
          gpuModel: hardware?.gpu?.model ?? null,
        },
      }),
    [hardware],
  );

  return (
    <section
      data-testid="pccenter-explicacoes"
      className="bg-card cyber-border rounded-xl p-6 space-y-6"
      aria-labelledby="pccenter-explicacoes-titulo"
    >
      <header className="flex items-center gap-2">
        <HelpCircle className="w-5 h-5 text-primary" aria-hidden="true" />
        <div>
          <h2 id="pccenter-explicacoes-titulo" className="text-lg font-semibold">Explicações locais</h2>
          <p className="text-xs text-muted-foreground">
            O que foi medido, o que é cache, o que é inferência e o que continua desconhecido. Nada daqui é diagnóstico.
          </p>
        </div>
      </header>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Factos</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="text-xs uppercase text-muted-foreground font-mono">
              <tr>
                <th className="py-1 pr-3">Leitura</th>
                <th className="py-1 pr-3">Valor</th>
                <th className="py-1 pr-3">Fonte · sensor · instante</th>
                <th className="py-1">Estado</th>
              </tr>
            </thead>
            <tbody className="font-mono tabular-nums">
              {explicacoes.fatos.map((facto) => (
                <tr key={facto.id} className="border-t border-border/60">
                  <td className="py-1 pr-3 text-foreground">{facto.rotulo}</td>
                  <td className="py-1 pr-3" title={facto.motivo ?? undefined}>{formatarValor(facto.valor, facto.unidade)}</td>
                  <td className="py-1 pr-3 text-muted-foreground text-xs">
                    {[facto.fonte, facto.sensor, facto.medidoEm ? `lido ${facto.medidoEm}` : "instante não publicado"].filter(Boolean).join(" · ")}
                  </td>
                  <td className={`py-1 text-xs ${CLASSE_CERTEZA[facto.certeza]}`}>{ETIQUETA_CERTEZA[facto.certeza]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Hipóteses</h3>
        <p className="text-xs text-muted-foreground">{TEXTO_RESUMO[explicacoes.resumo]}</p>
        {explicacoes.hipoteses.length > 0 && (
          <ul className="space-y-3">
            {explicacoes.hipoteses.map((h) => (
              <li key={h.id} className="rounded-lg border border-border bg-secondary/30 p-3">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 mt-0.5 text-primary shrink-0" aria-hidden="true" />
                  <div className="space-y-1">
                    <p className="text-sm text-foreground">{h.descricao}</p>
                    <p className="text-xs font-mono text-muted-foreground">certeza: {h.certeza}</p>
                    <p className="text-xs text-muted-foreground">Base: {h.base.join(", ")}</p>
                    <p className="text-xs text-muted-foreground">Contra: {h.contra.join("; ")}</p>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Recomendações locais</h3>
        {explicacoes.recomendacoes.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nada a recomendar com base nas leituras atuais.</p>
        ) : (
          <ul className="space-y-2">
            {explicacoes.recomendacoes.map((r) => (
              <li key={r.id} className="flex items-start gap-2 text-sm">
                <ShieldCheck className="w-4 h-4 mt-0.5 text-primary shrink-0" aria-hidden="true" />
                <span>
                  {r.descricao}{" "}
                  <span className="text-xs text-muted-foreground font-mono">
                    · risco {r.risco} · reversível: {r.reversivel ? "sim" : "não"}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Riscos e reversibilidade</h3>
        <ul className="space-y-1 text-xs text-muted-foreground">
          {explicacoes.riscos.map((r) => (
            <li key={r.id}>
              <span className="text-foreground">{r.descricao}</span> {r.reversibilidade}
            </li>
          ))}
        </ul>
      </div>

      <div className="rounded-lg border border-border bg-secondary/20 p-3 space-y-1" data-testid="pccenter-matriz">
        <p className="text-sm text-foreground">MATRIX — opção consentida</p>
        <p className="text-xs text-muted-foreground">
          {explicacoes.matriz.nota} Estado: <span className="font-mono">{explicacoes.matriz.estado}</span>.
        </p>
        <button
          type="button"
          disabled
          aria-disabled="true"
          className="mt-1 rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground/70 cursor-not-allowed"
          title="Requer consentimento explícito num contrato próprio; indisponível nesta versão."
        >
          Ativar MATRIX (requer consentimento)
        </button>
      </div>

      <p className="text-xs text-muted-foreground" data-testid="pccenter-assistente">
        Assistente externo: não integrado nesta secção — {explicacoes.assistente.motivo}
      </p>

      <ul className="space-y-1 text-xs text-muted-foreground/80">
        {explicacoes.avisos.map((a) => (
          <li key={a}>• {a}</li>
        ))}
      </ul>
    </section>
  );
}
