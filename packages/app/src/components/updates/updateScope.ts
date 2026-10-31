/**
 * TP-AUTO-03 · âmbito das ATUALIZAÇÕES: programa, definições ClamAV e regras
 * YARA/HashDB são operações DIFERENTES. Este módulo é descritivo e puro:
 *  - só o programa tem estado neste painel (AppUpdateSnapshot);
 *  - definições/regras não são verificadas nem atualizadas aqui;
 *  - não se afirma "assinatura verificada": o máximo é o que o snapshot diz
 *    (`canInstall` = verificações do atualizador concluídas), sem repetir a
 *    verificação nem inventar um check.
 */

export type EstadoTipo = "medido" | "nao-configurado" | "indisponivel" | "desconhecido" | "nao-apresentado";

export interface TipoAtualizacao {
  id: "programa" | "clamav" | "yara-hashdb";
  titulo: string;
  estado: EstadoTipo;
  texto: string;
  beneficios: string;
  riscos: string;
  preservacao: string;
}

export interface SnapshotPrograma {
  status?: string | null;
  installed?: { version?: string | null; build?: string | null } | null;
  canInstall?: boolean | null;
}

export interface AmbitoAtualizacoes {
  nota: string;
  tipos: TipoAtualizacao[];
  verificacao: string;
  avisos: string[];
}

const STATUS_PT: Record<string, string> = {
  unconfigured: "não configurado",
  unsupported: "não suportado neste ambiente",
  idle: "sem operação em curso",
  checking: "a verificar",
  "up-to-date": "já atualizado",
  available: "atualização disponível",
  downloading: "a transferir",
  verifying: "a verificar integridade",
  downloaded: "transferida, por instalar",
  deferred: "adiada",
  installing: "a instalar",
  error: "erro na última operação",
};

export function buildAmbitoAtualizacoes({ bridgeAvailable, snapshot }: { bridgeAvailable: boolean; snapshot: SnapshotPrograma | null }): AmbitoAtualizacoes {
  const versao = snapshot?.installed?.version ? `versão ${snapshot.installed.version}` : null;
  const build = snapshot?.installed?.build ? `build ${snapshot.installed.build}` : null;
  // Sem ponte é INDISPONÍVEL; sem snapshot é DESCONHECIDO. Só o snapshot com
  // status 'unconfigured' prova não-configurado.
  const estadoPrograma: EstadoTipo = !bridgeAvailable
    ? "indisponivel"
    : !snapshot
      ? "desconhecido"
      : snapshot.status === "unconfigured"
        ? "nao-configurado"
        : "medido";
  const textoPrograma = !bridgeAvailable
    ? "Sem ponte de atualizações nesta janela: não é possível verificar, transferir nem instalar."
    : !snapshot
      ? "Sem snapshot do atualizador nesta captura."
      : snapshot.status === "unconfigured"
        ? "O atualizador da aplicação não está configurado neste ambiente."
        : [STATUS_PT[String(snapshot.status ?? "")] ?? String(snapshot.status ?? "estado não mapeado"), versao, build].filter(Boolean).join(" · ");

  const verificacao = snapshot && snapshot.canInstall === true
    ? bridgeAvailable
      ? "Conforme o snapshot atual, o atualizador indica que as verificações de integridade/autoria/publicador/política foram concluídas; esta vista não repete essa verificação."
      : "O snapshot apresentado indica verificações concluídas ANTERIORMENTE; sem ponte nesta janela, o estado atual NÃO é confirmado."
    : "Assinatura/verificação não confirmada nesta vista (o estado pode ser apenas SHA ou configuração).";

  return {
    nota: "Este cartão trata APENAS da atualização do PROGRAMA CyberSafe. Definições do ClamAV e regras YARA/HashDB têm operação própria e não são aqui verificadas nem atualizadas.",
    tipos: [
      {
        id: "programa",
        titulo: "Programa CyberSafe",
        estado: estadoPrograma,
        texto: textoPrograma,
        beneficios: "Correções, melhorias de segurança e funcionalidades novas do código instalado.",
        riscos: "A instalação pode exigir reinício e interromper trabalho em curso; um artefacto inválido é recusado pelo atualizador.",
        preservacao: "As verificações e a instalação são do atualizador; esta vista não apaga dados nem altera preferências.",
      },
      {
        id: "clamav",
        titulo: "Definições ClamAV",
        estado: "nao-apresentado",
        texto: "Operação separada: não é verificada nem atualizada por este painel.",
        beneficios: "Bases mais recentes ampliam a deteção do motor antivírus.",
        riscos: "Sem bases atuais, a deteção fica limitada; a origem/tamanho das bases não é confirmada aqui.",
        preservacao: "Atualizar definições não altera ficheiros do utilizador nem configurações do programa.",
      },
      {
        id: "yara-hashdb",
        titulo: "Regras YARA / HashDB",
        estado: "nao-apresentado",
        texto: "Operação separada: não é verificada nem atualizada por este painel.",
        beneficios: "Regras e hashes mais recentes melhoram a identificação de amostras conhecidas.",
        riscos: "Uma atualização parcial pode deixar componentes desatualizados; esta vista não confirma cobertura nem eficácia.",
        preservacao: "A troca de regras/hashes é feita pela operação própria, sem alterar os dados do utilizador.",
      },
    ],
    verificacao,
    avisos: [
      "Atualizar definições ou regras não é feito por este cartão e não é verificado automaticamente.",
      "Nenhuma chamada de rede é feita por esta secção; o estado vem do snapshot existente.",
    ],
  };
}
