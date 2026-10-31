/** Production detail remains accessible without replacing the lab's composition. */
import { useState } from "react";
import {
  buildFindingGuidance,
  FINDING_SEVERITY_LABEL,
} from "@cybersafe/shared-types";
import type { DashboardProps } from "./LabDashboard";
import type { HardwareSnapshot } from "@cybersafe/shared-types";
import {
  explainProtectionScore,
  realtimeProtectionCopy,
} from "@/lib/protectionHealth";
import { cpuUsageDisplay } from "@/lib/cpuUsage";
import { ramUsageDisplay } from "@/lib/ramUsageDisplay";
import { networkReadingDisplay } from "@/lib/networkReadings";
import { formatGb, formatPercent, diskReadLabel } from "@/lib/diskDisplay";
const level = {
  good: "Estável",
  attention: "Atenção",
  critical: "Crítico",
  unknown: "Sem leitura",
};
const rate = (v: number | null) =>
  v === null
    ? "Sem leitura"
    : v < 1024
      ? `${v} B/s`
      : `${(v / 1024).toLocaleString("pt-PT", { maximumFractionDigits: 1 })} KB/s`;
function vram(gpu: HardwareSnapshot["gpu"] | undefined) {
  const total =
    typeof gpu?.vramTotalMb === "number" &&
    Number.isFinite(gpu.vramTotalMb) &&
    gpu.vramTotalMb > 0
      ? gpu.vramTotalMb
      : null;
  const used =
    typeof gpu?.vramUsedMb === "number" &&
    Number.isFinite(gpu.vramUsedMb) &&
    gpu.vramUsedMb >= 0 &&
    (total === null || gpu.vramUsedMb <= total)
      ? gpu.vramUsedMb
      : null;
  const gb = (n: number) =>
    (n / 1024).toLocaleString("pt-PT", {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });
  return total === null
    ? used === null
      ? "VRAM sem leitura"
      : `VRAM ${gb(used)} GB usados · capacidade sem leitura`
    : used === null
      ? `VRAM capacidade ${gb(total)} GB · uso sem leitura`
      : `VRAM ${gb(used)} de ${gb(total)} GB`;
}
export function LabDiagnostics(p: DashboardProps) {
  const [mount, setMount] = useState<string | null>(null);
  const score = typeof p.dashboard.riskScore === "number" && Number.isFinite(p.dashboard.riskScore)
    ? p.dashboard.riskScore : null;
  const info =
    score !== null && p.dashboard.engineHealth
      ? explainProtectionScore(score, p.dashboard.engineHealth)
      : null;
  const cpu = cpuUsageDisplay(p.hardware?.cpu),
    ram = ramUsageDisplay(p.hardware?.ram),
    net = networkReadingDisplay(p.hardware?.network);
  const disk = p.hardware?.disk,
    volumes = disk?.volumes.filter((v) => v.kind === "working") ?? [];
  const volume =
    volumes.find((v) => v.mount === mount) ??
    volumes.find((v) => v.mount === disk?.primary?.mount) ??
    volumes[0];
  const rt = realtimeProtectionCopy(p.realtime);
  return (
    <details className="dashboard-diagnostics">
      <summary>Diagnóstico e leituras detalhadas</summary>
      {p.serviceConnected !== true && (
        <p role="status">
          Sem ligação ao serviço. Valores da última leitura conhecida; não são
          um estado atual.
        </p>
      )}
      <section>
        <h3>Pontuação de proteção</h3>
        <p>
          {score === null ? "Sem leitura" : `${score}/100`}. Indicador de risco
          observado. Não confirma cobertura completa.
        </p>
        <p>
          {info
            ? `${info.activeEngines} de ${info.totalEngines} motores ativos · máximo possível ${info.maxPossible}`
            : "Motores sem leitura: o teto não se calcula"}
        </p>
        {info && info.threatPenalty > 0 && (
          <p>−{info.threatPenalty} por ameaças</p>
        )}
        {p.dashboard.engineHealth &&
          (p.dashboard.engineHealth.realtimeLoss?.queueRejections ??
            p.dashboard.engineHealth.realtimeDroppedEvents ??
            0) > 0 && (
            <p>
              {p.dashboard.engineHealth.realtimeLoss?.queueRejections ??
                p.dashboard.engineHealth.realtimeDroppedEvents}{" "}
              tentativas de análise rejeitadas. Cobertura incompleta ou não
              confirmada.
            </p>
          )}
        <p>
          Proteção em tempo real: {rt?.text ?? "Monitorização não verificada"}
        </p>
      </section>
      <section>
        <h3>Estado do PC</h3>
        <p>{p.pcState ? level[p.pcState.overall] : "Sem leitura"}</p>
        {p.pcState && (
          <p>
            {p.pcState.counts.urgent} agora · {p.pcState.counts.attention}{" "}
            problema(s) · Melhorias: {p.pcState.counts.recommended} ·{" "}
            {p.pcState.counts.informative} nota(s)
          </p>
        )}
        {p.pcState?.findings.map((f) => {
          const g = buildFindingGuidance(f);
          return (
            <details key={f.id}>
              <summary>
                {f.title} · {FINDING_SEVERITY_LABEL[f.severity]}
              </summary>
              <p>{g.significado}</p>
              {g.dado.length > 0 && (
                <div>
                  <h4>Dado</h4>
                  {g.dado.map((line) => (
                    <p key={line}>{line}</p>
                  ))}
                </div>
              )}
              {g.orientacao && <p>{g.orientacao}</p>}
            </details>
          );
        })}
      </section>
      <section>
        <h3>Leituras do computador</h3>
        <dl>
          <dt>CPU</dt>
          <dd>{cpu.text}</dd>
          <dt>RAM</dt>
          <dd>{ram.text}</dd>
          <dt>GPU</dt>
          <dd>{vram(p.hardware?.gpu)}</dd>
          <dt>Rede</dt>
          <dd>
            ↓ {rate(net.rxSec)} · ↑ {rate(net.txSec)} {net.label}
          </dd>
        </dl>
      </section>
      <section>
        <h3>Disco</h3>
        {disk && <p>{diskReadLabel(disk)}</p>}
        {volumes.length > 1 && (
          <label>
            Volume de trabalho
            <select
              value={volume?.mount}
              onChange={(e) => setMount(e.target.value)}
            >
              {volumes.map((v) => (
                <option key={v.mount} value={v.mount}>
                  {v.mount}
                </option>
              ))}
            </select>
          </label>
        )}
        <p>
          {volume
            ? `${volume.mount} · ${formatGb(volume.freeGb)} livres · ${formatPercent(volume.usagePercent)} usado`
            : "Sem leitura do volume do sistema"}
        </p>
        {disk?.volumes.some((v) => v.kind === "system-reserved") && (
          <p>
            Partições reservadas do sistema não são volumes de trabalho e não se
            escolhem.
          </p>
        )}
      </section>
    </details>
  );
}
