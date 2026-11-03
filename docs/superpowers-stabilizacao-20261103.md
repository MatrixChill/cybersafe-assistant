# Plano de estabilização — 2026-11-03

1. Extrair o parser do benchmark para módulo sem efeitos; testar métricas existentes ignoradas, fontes de cache e ausência de dados. Corrigir prazo e medir init sem tocar em veredictos.
2. Executar benchmark mínimo sintético e testes dirigidos de ClamAV/YARA/terminação; não executar carga instalada nem corpus histórico ausente.
3. Atualizar preflight VM para versão canónica e preparar matriz executável de 15 casos, snapshots, logs e recuperação.
4. Rever diff/segredos, testes e inventário de alterações; commits por bloco. Sem freeze, setup, VM, produção ou publicação.
