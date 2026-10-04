/**
 * WS-B — copy humana por motor, em PT-PT, derivada SÓ do que o serviço mediu.
 *
 * O detail cru do provider ("Loaded 4 signature(s) from C:\...", caminhos,
 * "corre freshclam") ia para o texto principal do Dashboard e dos detalhes.
 * Aqui cada motor tem uma frase que um utilizador entende; o detalhe tecnico
 * continua disponivel onde e secundario (ProtectionDetails tecnicos,
 * degradedReasons, relatorios).
 *
 * Regras de honestidade (skills cybersafe-ptpt-ui):
 *  - instalado nao e operacional — so "Ativo" quando o servico disse active;
 *  - o modulo WFP nao e o Windows Firewall — a copy diz explicitamente que
 *    o estado daquele nada afirma sobre este;
 *  - sem leitura nao se inventa nada: os numeros so aparecem quando estao
 *    de facto no detail medido.
 */
import type { EngineSubsystemCoverage, EngineSubsystemHealth, EngineSubsystemStatus } from "./index.js";
import { ENGINE_DISPLAY_NAME } from "./index.js";

export interface EngineContextCopy {
  /** Estado em PT-PT ("Ativo", "Degradado", "Indisponível", "Erro", "Não verificado"). */
  estado: string;
  /** Frase principal, sem paths nem tokens. */
  texto: string;
  /** Contexto/advertencia, quando existe e verdadeira. */
  contexto?: string;
}

const STATUS_PT: Record<string, string> = {
  active: "Ativo",
  degraded: "Degradado",
  unavailable: "Indisponível",
  error: "Erro",
  unknown: "Não verificado",
};

/** Token de estado do servico → palavra PT-PT. Token desconhecido → honesto. */
export function engineStatusPt(status: string): string {
  return STATUS_PT[status] ?? "Não verificado";
}

function countFrom(detail: string | undefined, unit: string): number | null {
  const m = new RegExp(`Loaded\\s+(\\d+)\\s+${unit}`, "i").exec(detail ?? "");
  return m ? Number(m[1]) : null;
}

const plural = (n: number, singular: string, pluralWord: string) =>
  n === 1 ? singular : pluralWord;

/**
 * COBERTURA em PT-PT, a partir do campo medido pelo serviço.
 *
 * `coverage` ausente = serviço que não envia o campo. Isso é ausência de
 * evidência, e a frase tem de dizer exactamente isso. O caminho antigo
 * ("Cobertura … atualmente limitada.") affirmava LIMITADA para qualquer motor
 * activo, inclusive um com o corpus real carregado — dizia menos do que sabia
 * e mais do que media.
 *
 * Um serviço antigo que não conhece o campo continua a receber a versão
 * conservadora: sem `coverage` não affirmamos cobertura, mas também não
 * escondemos o motor — a linha principal já diz que está activo.
 *
 * ── Porque `status` entra aqui ────────────────────────────────────────────
 * `coverage: "normal"` só é credível com o motor `active`. Um motor
 * `unavailable` ou `degraded` a declarar cobertura normal é um estado
 * contradictório, e a UI não escolhe: desce para `unknown`. Não existe caminho
 * no serviço que produza o par — o guard está aqui porque os dados chegam por
 * um named-pipe e um emissor novo não conhece esta regra.
 *
 * O mesmo guard existe em `coberturaUserCopy` (app/components/
 * ProtectionDetails.tsx). São dois sitios com copy propria: se um deles
 * aceitar o par contradictorio, o utilizador recebe as duas versoes e a
 * errada. Testado em app/test/yara-coverage-gate.test.ts.
 */
function coberturaCopy(
  coverage: EngineSubsystemCoverage | undefined,
  oQue: "regras" | "assinaturas",
  status: EngineSubsystemStatus = "active",
): string {
  const efetiva: EngineSubsystemCoverage | undefined =
    status !== "active" && coverage === "normal" ? "unknown" : coverage;
  switch (efetiva) {
    case "limited":
      return `Cobertura limitada: só ${oQue} de canário de teste. Não detetam malware.`;
    case "normal":
      return `Cobertura normal: ${oQue} de deteção carregadas.`;
    case "unknown":
      return "Cobertura não determinada: o serviço não comunicou o que está carregado.";
    default:
      return "Cobertura não comunicada por este serviço.";
  }
}

export function engineContextCopy(name: string, sub?: EngineSubsystemHealth): EngineContextCopy {
  const status = sub?.status ?? "unknown";
  const estado = engineStatusPt(status);
  const detail = sub?.detail;

  if (status === "unknown") {
    return { estado, texto: `Sem leitura do ${ENGINE_DISPLAY_NAME[name] ?? name} nesta vista.` };
  }

  switch (name) {
    case "yara": {
      if (status === "active") {
        const n = countFrom(detail, "rule");
        const texto = n === null
          ? "Motor de análise por regras ativo."
          : `Motor de análise por regras ativo — ${n} ${plural(n, "regra carregada", "regras carregadas")}.`;
        return { estado, texto, contexto: coberturaCopy(sub?.coverage, "regras", status) };
      }
      break;
    }
    case "hashDb": {
      if (status === "active") {
        const n = countFrom(detail, "signature");
        const texto = n === null
          ? "Base local ativa."
          : `Base local ativa — ${n} ${plural(n, "assinatura carregada", "assinaturas carregadas")}.`;
        return { estado, texto, contexto: coberturaCopy(sub?.coverage, "assinaturas", status) };
      }
      break;
    }
    case "clamav": {
      if (status === "degraded") {
        return {
          estado,
          texto: "Motor instalado, mas a base de assinaturas antivírus ainda não está disponível.",
          contexto: "As assinaturas precisam de ser instaladas ou atualizadas antes de o ClamAV poder contribuir plenamente para a análise.",
        };
      }
      if (status === "active") {
        return { estado, texto: "Motor antivírus ativo e com base de assinaturas disponível." };
      }
      break;
    }
    case "nativeEngine": {
      if (status === "active") {
        return { estado, texto: "Motor nativo de análise disponível." };
      }
      break;
    }
    case "wfp":
    case "firewall": {
      if (status === "unavailable") {
        return {
          estado,
          texto: "O filtro de rede próprio do CyberSafe não está ativo.",
          contexto: "Isto não significa que o Firewall do Windows esteja desligado.",
        };
      }
      if (status === "active") {
        return { estado, texto: "O filtro de rede próprio do CyberSafe está ativo." };
      }
      return {
        estado,
        texto: "O filtro de rede próprio do CyberSafe não está a funcionar como esperado.",
        contexto: "Isto não significa que o Firewall do Windows esteja desligado.",
      };
    }
  }

  // Estado sem copy especifica: diz-se so o que se mediu — nome e estado.
  return { estado, texto: `${ENGINE_DISPLAY_NAME[name] ?? name}: ${estado}.` };
}
