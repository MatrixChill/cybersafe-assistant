/**
 * Validação de FORMATO de email — partilhada entre a app e a API para as duas
 * condutas coincidirem (o ecrã não recusa o que o servidor aceitaria, nem
 * aceita o que o servidor recusa).
 *
 * Isto é formato, **não** confirmação: um email com formato válido não está
 * verificado nem entregue — nenhum ecrã deve apresentá-lo como «confirmado».
 *
 * Regras conservadoras (cobrem o caso reportado a 16/10/2026: `gmail.c` era
 * aceite pelo regex antigo `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` porque não exigia
 * um TLD completo):
 *  - um único `@`; parte local com átomos separados por ponto (sem `..`, sem
 *    ponto inicial/final), aceita `+alias` e os símbolos usuais;
 *  - domínio com etiquetas `A-Z a-z 0-9 -` (sem começar nem acabar em `-`),
 *    subdomínios aceites;
 *  - TLD com pelo menos 2 letras (`gmail.c` deixa de passar) ou a forma
 *    punycode `xn--…` dos IDN;
 *  - limites reais: ≤64 na parte local, ≤254 no total.
 *
 * Espera o valor já aparado (quem aceitar espaços à volta deve `trim` antes,
 * como faz a página de registo); validar o valor cru mantém estrita a API.
 */
export function isValidEmailFormat(value: string): boolean {
  const email = value;
  if (email.length === 0 || email.length > 254) return false;

  const at = email.indexOf("@");
  if (at === -1 || at !== email.lastIndexOf("@")) return false;

  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length === 0 || local.length > 64 || domain.length === 0) return false;

  // Parte local: átomos não vazios separados por um ponto.
  if (!/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/.test(local)) {
    return false;
  }

  const labels = domain.split(".");
  if (labels.length < 2) return false; // `gmail` sozinho não é um domínio
  for (const label of labels) {
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label)) return false;
  }

  const tld = labels[labels.length - 1];
  if (/^xn--/i.test(tld)) {
    return /^xn--[A-Za-z0-9-]{2,59}$/.test(tld); // IDN em punycode
  }
  return /^[A-Za-z]{2,63}$/.test(tld); // TLD completo: pelo menos 2 letras
}
