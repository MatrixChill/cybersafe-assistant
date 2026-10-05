# LUNA — ESTRUTURA MAESTRI COHERENCE AUDIT (READ-ONLY)

STATUS = READY_FOR_MANUAL_TRIGGER
PREPARED_BY = Freebuff (Maestro Principal), sessao "Maestri Structure Completion", 2026-10-05
SCOPE = READ-ONLY. Não escrever em produto, não commitar, não instalar, não executar testes,
não abrir o Word, não tocar no relatório PAP.

Esta tarefa substitui a auditoria PAP/DOCUMENTATION de 2026-10-04, que apontava para um
ficheiro DOCX antigo (`Relatorio_PAP_CyberSafe_v9_REVISTA_04-10-2026 (1).docx`) e não para
o relatório LIVE. Não é a mesma tarefa e não deve ser confundida com ela.

---

## OBJECTIVO

Auditar se as três fontes que governam o Maestri **concordam entre si** sobre quem é o
Freebuff, quem é o Qoder, e como as skills chegam aos agentes:

1. `AGENT ROLES` — quem pode escrever o quê.
2. `skill-routing` — que skills cada agente recebe, e por que caminho.
3. `MAESTRI_STATE` — o que o estado persistido afirma.

Se as três não concordarem, o Maestro vai dar o mesmo advice a três sistemas diferentes.
Isso é o que esta auditoria procura.

---

## FICHEIROS PARA LER (só leitura)

Raiz do repositório:
`C:\Users\caioc\Desktop\Caio\garoto de programa\cybersafe-assistant`

- `AGENTS.md`, `CLAUDE.md` (raiz)
- `docs/ai-map/06-AGENT-ROLES.md`  ← fonte de verdade dos papéis
- `.maestri/tools/maestro.py`      ← `AGENT_SKILLS`, `NATIVE_LOADERS`, `ROUTING_TEXT`, `CLASSIFY_RULES`
- `.maestri/state/maestro-state.json`
- `.maestri/state/ownership.json`
- `.maestri/state/skills-manifest.json`
- `.maestri/external/luna/STATUS.md`

Para skills (só para confirmar nomes e contagens; **não** usar como fonte de regra):
- `%USERPROFILE%\.agents\skills\`  ← canónica, 32 skills

---

## PERGUNTAS A RESPONDER

1. O `AGENT ROLES` diz que o **Freebuff** é o Maestro Principal / Integration Lead?
   `maestro.py` trata-o como `Freebuff Builder` no perfil de skills? Os nomes batem?
2. O `AGENT ROLES` diz que o **Qoder** é o writer de frontend/design?
   Em `ROUTING_TEXT`, `frontend_design` e `bug_ui` vão mesmo para `qoder`?
3. Algum papel descrito no `AGENT ROLES` **não existe** em `AGENT_SKILLS` em `maestro.py`?
4. Algum agente em `AGENT_SKILLS` **não aparece** no `AGENT ROLES`?
5. Alguma skill em `ROUTING_TEXT` está **fora do perfil** do agente que a recebe?
6. `maestro-state.json` afirma algum papel ou skill que já não existe na biblioteca?

---

## FORMATO DA RESPOSTA

Devolver em `HANDOFF.md`, com estas quatro secções e **só** isto:

```
CONFIRMED          — o que se confirmou, com o ficheiro e a linha
CONFLICTS          — o que as fontes dizem de formas diferentes (fich:linha de cada lado)
STALE_REFERENCES   — o que aponta para algo que já não existe
RECOMMENDATIONS    — o que deve ser corrigido, por ordem de gravidade
```

Regras:

- Citar `ficheiro:linha` em cada afirmação. Sem citação, a afirmação não conta.
- Se um ficheiro não existir ou não for legível: escrever `BLOCKED` com o caminho exacto.
  Não adivinhar o conteúdo.
- **Não** propor mudanças de produto. Isto é auditoria de infra.
- **Não** editar nada. A única escrita permitida é o próprio `HANDOFF.md`.

---

## O QUE ESTE TRABALHO NÃO DEVE CONCLUIR

- Não declarar o routing "correcto" porque as skills existem. Existe ≠ está carregada.
- Não declarar Luna integrada porque este ficheiro existe. TASK_READY ≠ LUNA_USED.
- Não tratar `maestro-state.json` como verdade quando o `AGENT ROLES` diz outra coisa:
  registar como CONFLICT, não escolher um lado.