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
import type {
  EngineSubsystemCoverage,
  EngineSubsystemHealth,
  EngineSubsystemReason,
  EngineSubsystemStatus,
} from "./index.js";
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
 * O valor legado `normal` não transporta evidência de proveniência ou alcance.
 * A compilação, por si só, mantém a cobertura `unknown`; por isso nenhum valor
 * recebido neste contrato autoriza a afirmação "Cobertura normal".
 *
 * `coberturaUserCopy` (app/components/ProtectionDetails.tsx) aplica a mesma
 * regra ao texto apresentado no painel.
 */
function coberturaCopy(
  coverage: EngineSubsystemCoverage | undefined,
  oQue: "regras" | "assinaturas",
): string {
  switch (coverage) {
    case "limited":
      return `Cobertura limitada: só ${oQue} de canário de teste. Não detetam malware.`;
    case "normal":
    case "unknown":
      return "Cobertura não verificada: a origem e o alcance das definições carregadas não foram validados.";
    default:
      return "Cobertura não comunicada por este serviço.";
  }
}

/**
 * Motivo legível para a UI principal. Usa o `reason` estruturado quando o
 * serviço o envia; para serviços antigos classifica o `detail` de forma
 * conservadora (só padrões inequívocos). `null` = sem motivo especial.
 */
export function engineUserReason(name: string, sub?: EngineSubsystemHealth): EngineSubsystemReason | null {
  if (!sub || sub.status === "active") return null;
  if (sub.reason) return sub.reason;
  const detail = sub.detail ?? "";
  if (sub.busy === true && sub.status === "unavailable") return "starting";
  if (name === "clamav") {
    if (sub.status === "unavailable" && /ENOENT|not found|não encontrad|não instalad|não é motor desta plataforma/i.test(detail)) return "not-installed";
    if (sub.status === "degraded" && /sem base|no database|freshclam|sem assinaturas|signature database/i.test(detail)) return "no-definitions";
    if (sub.status === "error") return "exec-failed";
    return null;
  }
  if (name === "yara") {
    if ((sub.status === "unavailable" || sub.status === "error") && /indisponível neste sistema|ENOENT|not found|não encontrad|não instalad/i.test(detail)) return "not-installed";
    if (sub.status === "error") return "exec-failed";
    return null;
  }
  return null;
}

const NOT_INSTALLED_TEXT: Record<string, string> = {
  clamav: "ClamAV não instalado neste sistema.",
  yara: "YARA não instalado neste sistema.",
};

/**
 * Frase curta (≤ 1 linha) para listas e para o hero do Dashboard. Nunca leva
 * o `detail` técnico: esse fica no diagnóstico completo.
 */
export function engineUserSummary(name: string, sub?: EngineSubsystemHealth): string {
  const label = ENGINE_DISPLAY_NAME[name] ?? name;
  switch (engineUserReason(name, sub)) {
    case "not-installed": return `${label} não instalado`;
    case "no-definitions": return `${label} instalado, sem bases de assinaturas`;
    case "exec-failed": return `${label}: erro ao executar`;
    case "starting": return `${label}: a verificar`;
  }
  return `${label}: ${engineStatusPt(sub?.status ?? "unknown")}`;
}

export function engineContextCopy(name: string, sub?: EngineSubsystemHealth): EngineContextCopy {
  const status = sub?.status ?? "unknown";
  const estado = engineStatusPt(status);
  const detail = sub?.detail;

  if (status === "unknown") {
    return { estado, texto: `Sem leitura do ${ENGINE_DISPLAY_NAME[name] ?? name} nesta vista.` };
  }

  // Motivo estruturado primeiro: «não instalado» não é «erro crítico», e o
  // ENOENT/caminho do provider nunca chega a esta frase.
  const reason = engineUserReason(name, sub);
  if (reason === "not-installed") {
    return {
      estado: "Não instalado",
      texto: NOT_INSTALLED_TEXT[name] ?? `${ENGINE_DISPLAY_NAME[name] ?? name} não instalado neste sistema.`,
      contexto: "Os restantes motores continuam a funcionar. O diagnóstico completo mostra o que foi procurado.",
    };
  }
  if (reason === "starting") {
    return { estado: "A verificar", texto: `A verificar o ${ENGINE_DISPLAY_NAME[name] ?? name}…` };
  }
  if (reason === "exec-failed") {
    return {
      estado: "Erro ao executar",
      texto: `O ${ENGINE_DISPLAY_NAME[name] ?? name} está instalado, mas falhou ao executar.`,
      contexto: "O detalhe técnico está no diagnóstico completo.",
    };
  }
  if (reason === "no-definitions" && name !== "clamav") {
    return { estado: "Sem bases", texto: `${ENGINE_DISPLAY_NAME[name] ?? name} instalado, sem bases utilizáveis.` };
  }

  switch (name) {
    case "yara": {
      if (status === "active") {
        const n = countFrom(detail, "rule");
        const texto = n === null
          ? "Motor de análise por regras ativo."
          : `Motor de análise por regras ativo — ${n} ${plural(n, "regra carregada", "regras carregadas")}.`;
        return { estado, texto, contexto: coberturaCopy(sub?.coverage, "regras") };
      }
      break;
    }
    case "hashDb": {
      if (status === "active") {
        const n = countFrom(detail, "signature");
        const texto = n === null
          ? "Base local ativa."
          : `Base local ativa — ${n} ${plural(n, "assinatura carregada", "assinaturas carregadas")}.`;
        return { estado, texto, contexto: coberturaCopy(sub?.coverage, "assinaturas") };
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
