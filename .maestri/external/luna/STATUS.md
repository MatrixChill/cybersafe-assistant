TASK_READY

ponto de entrada: 1 a 5 (ver RULES)
controlador: Freebuff (Maestro Principal) - autoridade do utilizador 2026-10-01
modelo real: GPT-5.6 Luna, EXTERNO, em ChatGPT Free/Go via Remote Desktop Commander
nao existe aqui: qualquer execucao do Luna
task atual: auditoria read-only de coerencia AGENT ROLES / skill-routing / MAESTRI_STATE
task anterior: auditoria PAP/DOCUMENTATION 2026-10-04 (guardada em TASK.previous-2026-10-04.md.bak;
  apontava para um DOCX antigo, nao para o relatorio LIVE - nao confundir)
STATUS possiveis: AVAILABLE_EXTERNAL, TASK_READY, WAITING_EXTERNAL, HANDOFF_READY, BLOCKED
NUNCA declarar RUNNING sem evidencia do lado externo.

atualizado: 2026-10-05
LUNA_TASK_SENT = NO (a task esta escrita; o trigger humano nao aconteceu nesta sessao)
LUNA_RESULT_RECEIVED = NO
LUNA_HANDOFF_VALID = NOT_VERIFIED
LUNA_END_TO_END = NO
MANUAL_TRIGGER_REQUIRED = YES
proximo passo: utilizador despacha manualmente TASK.md no bridge externo;
depois STATUS = WAITING_EXTERNAL; Freebuff le o HANDOFF.md e valida antes de acreditar
