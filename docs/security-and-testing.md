# Testes, segurança e limitações

CyberSafe é um projeto académico. Os testes automatizados verificam contratos concretos; não certificam proteção integral contra malware nem substituem ensaios instalados em hardware diferente.

- Um motor ativo não prova que todos os ficheiros foram analisados.
- Callbacks sem nome, saturação, pastas inacessíveis e resultados inconclusivos permanecem limitações observáveis.
- A correção ClamAV da v0.2.4 passou a CI do PR #3; a confirmação no portátil afetado continua pendente nesse registo.
- USB tem ensaios automatizados; não os apresentar como teste com pen física.
- WFP é um componente opcional e não equivale ao firewall do Windows.
- Não declarar atualização instalada A→B a partir de um teste de handoff.

Resultados pertencem ao commit, ambiente e corpus que os produziu. As notas do [PR #3](https://github.com/MatrixChill/cybersafe-assistant/pull/3) registam também duas falhas intermitentes e as repetições isoladas; não as converter em PASS global. Consulte os testes disponíveis e os resultados da [CI](https://github.com/MatrixChill/cybersafe-assistant/actions).

Para uma dúvida sem dados sensíveis, abra uma [issue](https://github.com/MatrixChill/cybersafe-assistant/issues). Para uma vulnerabilidade, consulte [SECURITY.md](../SECURITY.md). O reporte privado estava desativado na verificação de 2026-11-11; não presuma que uma issue ou um URL de criação de advisory é privado. Não publique chaves, palavras-passe, dumps de bases ou ficheiros maliciosos. Não existe promessa de SLA de resposta.

[Voltar à documentação](README.md)
