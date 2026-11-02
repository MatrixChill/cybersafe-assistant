/**
 * Dois eixos que o ecrã não pode misturar:
 *   • existe uma chave configurada (`hasKey`);
 *   • como é que essa chave está em repouso (este módulo).
 *
 * A afirmação «a tua chave está cifrada» só pode ser feita pelo mecanismo que
 * realmente cifra. Em Linux o `safeStorage` do Electron (33.x) tem dois
 * estados que `isEncryptionAvailable()` não distingue sozinhos: um gestor de
 * segredos real (libsecret/kwallet) e o backend `basic_text`, que cifra com uma
 * chave fixa de memória — qualquer processo do mesmo utilizador lê o ficheiro.
 * Por isso o `getSelectedStorageBackend()` é obrigatório para afirmar «seguro»,
 * e a sua ausência (`unknown`, chamada antes do `ready`, ou API inexistível) é
 * `desconhecido`, nunca `seguro`.
 */
export type NivelMecanismo = "seguro" | "nao-seguro" | "desconhecido";

export type OrigemCredencial = "cifrado" | "local-protegido";

export interface MecanismoCredenciais {
  nivel: NivelMecanismo;
  /** Rótulo curto para o ecrã — nomeia o mecanismo, não a nossa app. */
  rotulo: string;
  /** O que o mecanismo significa para a chave em repouso. */
  explicacao: string;
  /** Só existe quando há um passo que o utilizador pode dar. */
  remedio?: string;
}

export interface FactosMecanismo {
  plataforma: NodeJS.Platform;
  /** `safeStorage.isEncryptionAvailable()`. */
  cifradoDisponivel: boolean;
  /** `safeStorage.getSelectedStorageBackend()` — só tem significado em Linux. */
  backend?: string | null;
}

/** Gestores de segredos do Linux que entregam uma chave que não é pública. */
const BACKENDS_SEGUROS: ReadonlySet<string> = new Set([
  "gnome_libsecret",
  "kwallet",
  "kwallet5",
  "kwallet6",
]);

const ROTULOS_BACKEND: Readonly<Record<string, string>> = {
  gnome_libsecret: "carteira de segredos do sistema (libsecret)",
  kwallet: "KWallet",
  kwallet5: "KWallet 5",
  kwallet6: "KWallet 6",
};

export function classificaMecanismoCredenciais(factos: FactosMecanismo): MecanismoCredenciais {
  if (factos.plataforma === "win32") {
    return factos.cifradoDisponivel
      ? {
          nivel: "seguro",
          rotulo: "DPAPI (Windows)",
          explicacao: "cifra apenas para este utilizador do Windows.",
        }
      : {
          nivel: "nao-seguro",
          rotulo: "sem mecanismo de cifra",
          explicacao: "o Windows não disponibilizou a proteção DPAPI a este processo.",
        };
  }

  if (factos.plataforma === "darwin") {
    return factos.cifradoDisponivel
      ? {
          nivel: "seguro",
          rotulo: "Keychain (macOS)",
          explicacao: "cifra através do Keychain do sistema.",
        }
      : {
          nivel: "nao-seguro",
          rotulo: "sem mecanismo de cifra",
          explicacao: "o Keychain do macOS não está disponível a este processo.",
        };
  }

  if (factos.plataforma === "linux") {
    if (!factos.cifradoDisponivel) {
      return {
        nivel: "nao-seguro",
        rotulo: "sem mecanismo seguro de armazenamento",
        explicacao: "não existe um gestor de segredos acessível a esta sessão.",
        remedio:
          "Activa um keyring (gnome-keyring ou kwallet) e reinicia a sessão, ou autoriza explicitamente o ficheiro local protegido sem cifra.",
      };
    }
    const backend = typeof factos.backend === "string" ? factos.backend : "";
    if (backend === "basic_text") {
      return {
        nivel: "nao-seguro",
        rotulo: "cifra de chave fixa (basic_text)",
        explicacao:
          "o Electron não reconheceu o ambiente de trabalho e cifra com uma chave pública do código — qualquer processo deste utilizador lê o ficheiro.",
        remedio:
          "Instala/activa um keyring (gnome-keyring ou kwallet) para esta sessão, ou autoriza explicitamente o ficheiro local protegido sem cifra.",
      };
    }
    if (BACKENDS_SEGUROS.has(backend)) {
      return {
        nivel: "seguro",
        rotulo: ROTULOS_BACKEND[backend],
        explicacao: "cifra com uma chave do gestor de segredos desta sessão.",
      };
    }
    return {
      nivel: "desconhecido",
      rotulo: "mecanismo por confirmar",
      explicacao:
        "o Electron diz que a cifra está disponível, mas não identificámos o backend em uso — não podemos afirmar que a chave está protegida.",
      remedio:
        "Reabre a aplicação depois do arranque da sessão gráfica, configura um keyring, ou autoriza explicitamente o ficheiro local protegido sem cifra.",
    };
  }

  return {
    nivel: "desconhecido",
    rotulo: "mecanismo desconhecido",
    explicacao: "esta plataforma não tem um mecanismo de cifra reconhecido pelo CyberSafe.",
  };
}

/** Só este nível autoriza escrever bytes cifrados e dizer «está cifrada». */
export function mecanismoPermiteCifra(mecanismo: MecanismoCredenciais): boolean {
  return mecanismo.nivel === "seguro";
}

/**
 * Estado do IPC quando nem sequer conseguimos ler o armazenamento: é distinto
 * de «não há chave», e não afirma uma cifra que não foi confirmada.
 */
export const MECANISMO_INDETERMINADO: MecanismoCredenciais = {
  nivel: "desconhecido",
  rotulo: "mecanismo por confirmar",
  explicacao: "o armazenamento de credenciais não respondeu; não podemos afirmar como a chave ficaria protegida.",
};
