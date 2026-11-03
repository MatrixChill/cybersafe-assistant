# Integração final Windows — preparação

Branch atual codex/updater-visual-20261103 inclui 497e634 e commits visuais. Não tocar main, versão/freeze/artefacto RC1.
- [x] Reconciliar refs e worktrees por leitura; registar certificado/chave/feed e evidência manual do Gestor.
- [x] Testar e integrar UpdaterExperience na secção real, usando UMA instância do controller e confirmação existente; não promover sucesso pelo snapshot.
- [x] Executar benchmark sintético pequeno com motores reais apenas com seed oficial e isolamento provado; recolher tempos e limites.
- [x] Corrigir defeitos reproduzidos; regressão dirigida e abrangente nos pacotes afetados.
- [x] Registar resultado NO-GO enquanto assinatura/feed/ensaio instalado/freeze não tiverem prova; preparar checklist e inventário do HEAD sem aprovação fictícia.

Ameaça: eventos e ações do renderer podem pedir instalação. UI deve manter busy/gates e consentimento exato de versão; main continua autoridade. Sem novos canais IPC ou confiança local de teste em produção.
