/**
 * Rótulos legíveis das regras heurísticas na superfície principal.
 *
 * Os identificadores (`yara_match`, `known_bad_hash`, …) são a chave de dados:
 * continuam nos registos, no histórico e no detalhe técnico. O que o utilizador
 * lê em Ameaças é a descrição. Uma regra nova que ainda não tenha tradução cai
 * num rótulo legível derivado do próprio ID — nunca mostra underscores crus.
 */
const RULE_LABELS: Record<string, string> = {
  dangerous_file_extension: "Extensão de ficheiro perigosa",
  social_engineering_filename_pattern: "Nome de ficheiro com padrão de engenharia social",
  suspicious_download_type: "Tipo de transferência suspeito",
  double_extension: "Extensão dupla",
  executable_signature: "Assinatura de executável",
  archive_with_exe: "Ficheiro comprimido que contém um executável",
  magic_number_mismatch: "Cabeçalho do ficheiro não corresponde ao formato",
  high_entropy: "Conteúdo com entropia elevada",
  process_injection_indicator: "Indício de injeção de processos",
  suspicious_location: "Localização suspeita",
  persistence_attempt: "Tentativa de persistência",
  known_bad_hash: "Hash conhecido como malicioso",
  dev_canary_signature: "Assinatura de canário de teste",
  yara_match: "Correspondência de regra YARA",
  known_malware: "Malware conhecido",
  allowlisted_hash: "Hash na lista de permissões",
  trusted_publisher: "Editor de confiança",
  trusted_system_path: "Caminho de sistema confiável",
  unsigned_binary: "Executável sem assinatura",
  office_child_process: "Processo filho de uma aplicação do Office",
  script_spawns_binary: "Script que lança um executável",
  rapid_process_fanout: "Processos abertos em sequência rápida",
  blocked_reexecution: "Tentativa de voltar a executar depois de bloqueado",
  scan_inconclusive: "Análise não concluída — o motor não conseguiu avaliar o ficheiro",
};

export function threatRuleLabel(rule: string): string {
  const known = RULE_LABELS[rule];
  if (known) return known;
  const readable = rule.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!readable) return "Regra desconhecida";
  return readable.charAt(0).toUpperCase() + readable.slice(1);
}

/** Texto completo para `title`: descrição primeiro, identificador entre parênteses. */
export function threatRuleDetail(rule: string): string {
  return `${threatRuleLabel(rule)} (${rule})`;
}
