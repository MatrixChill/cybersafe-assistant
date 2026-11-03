# CyberSafe v0.2.0 — checkpoint final de preparação Windows

**Veredito: NO-GO para Release pública com atualizações funcionais.** Há engenharia integrada e testes aprovados, mas ainda faltam identidade de assinatura, confiança aprovada, distribuição/ensaio real entre versões e novo freeze. A versão canónica permanece 0.2.0-rc.1. Não foi gerado um setup final novo.

## Código e branches
Branch de trabalho: codex/updater-visual-20261103. Base visual recebida: 4bf1cde. Código de preparação: 68c2d06347fa8a1851bf297165161a9745a49c01, seguido pelo commit documental desta entrega.
- 24480e8: janela Orbital ligada ao controller existente de Atualizações, sob pedido.
- 4373710: benchmark com cópia isolada e identificada do corpus YARA local real.
- 68c2d06: ferramenta de confiança emite assistedInstallationEnabled=false; fixture de seed atualizada para o contrato do launcher; CI cobre branches codex/** e suíte da app.

Confirmado por git merge-base: 497e634, codex/final-v020-20261103, origin/main, origin/integration/windows-v0.2.0, Freebuff R7 e 94ac447 são ancestrais deste HEAD. Não foi necessário cherry-pick nem merge redundante. As branches e worktrees foram preservadas. O worktree Freebuff R7 continua com alterações locais preexistentes de setup; não foram tocadas. Nenhuma alteração no projeto Qoder/Linux.

## Integração efetiva do updater
Configurações → Atualizações passa a oferecer Abrir janela de atualização. UpdaterFlow/UpdaterExperience recebem a MESMA instância de state/actions do controller já usado pelo painel; não há segundo scheduler/subscrição/ponte. O diálogo nativo HTML captura foco; fechar só esconde a apresentação, nunca termina processos nem cancela uma instalação implicitamente.
Download/check/cancel obedecem às capacidades/busy existentes. Rever instalação abre InstallConfirmDialog, que exige versão exata e permissão ainda válida. A UI revalida antes de chamar actions.install; o main continua autoridade. Repetir após erro relê o snapshot, não repete instalação.
Os estados reais vêm de AppUpdateSnapshot. Autenticidade separada, preparação, reinício e confirmação final só serão exibidos quando houver eventos reais correspondentes; não foram inventados novos IPCs nem sucesso por inferência de percentagem/exit zero. Backend HTTPS, SHA-256, Ed25519, Authenticode, staging, locks, launcher, diário e recuperação foram preservados.
A versão distribuível inclui a janela real. A busca no JavaScript de produção confirmou ausência de updater-demo-phase e Sem WebGL (ensaio). O laboratório continua exclusivo DEV. No browser sem preload, o fluxo declara indisponibilidade.

Defeito encontrado/corrigido: o primeiro import direto da janela puxava CSS para o caminho SSR de Settings e fazia vários testes falhar. A janela agora é lazy, apenas aberta por ação explícita; a regressão completa voltou a passar.

## Scanner e quatro motores — ensaio real pequeno
Foi usado o benchmark existente, com dados gerados pelo ensaio e base de serviço temporária própria. Sem análise de disco/pastas pessoais, USB, monitorização do SO ou atualização de definições. A seed ClamAV é lida do recurso RC1 verificado, sem alterar o original.
Primeira execução: 7 alvos/19,99 s, mas YARA apenas com regras de teste; exit 2, corretamente INCOMPLETA. Não contabilizada como aprovação dos quatro motores.
Segunda execução: corpus YARA já instalado copiado para a base privada, origem preservada. 15474 bytes; SHA-256 5a14bd42c092057ebe482f84360cc3a4f8af9bc8434671c58a98bdd48f13c444. Registada a identidade exata, sem mudar regras/veredictos.
- Corpus: seis ficheiros benignos + um ZIP, 7 alvos exteriores, 261 bytes. Uma entrada extraída explica 8 observações de fases por motor; não são 8 alvos exteriores.
- Resultado: completed, 7/7 analisados, zero excluídos/falhados/inconclusivos/ameaças.
- Inicialização: 7373 ms. Janela de análise: 22743 ms. Throughput deste corpus: 0,3 alvos/s.
- Prefetch: cerca de 7000 ms; fase de lote 7443 ms; ZIP 7172 ms. Intervalos e contagens têm escopos próprios e não devem ser somados cegamente.
- YARA: 20 regras, ativo, cobertura desconhecida; origem/eficácia não verificadas pelo motor. Não é cobertura ampla de malware.
- HashDB: ativo, 3 assinaturas embutidas; base pequena.
- Native: ativo, invocação real confirmada; fases somaram 200 ms, máximo 30 ms.
- ClamAV: ativo, todos os veredictos obtidos; quatro spawns reais. Per-file com 0 ms refere leitura da cache de lote e NÃO custo zero de ClamAV. Os processos levaram aproximadamente 7 s cada, incluindo a prova de carga.
- Quatro PIDs ClamAV com CHILD_TERMINAL/deathUnconfirmed=false; reconciliação CIM posterior confirmou todos ausentes. Não se generaliza esta observação para todos os processos de todas as sessões.
- Recurso medido do processo Node controlador: 672 ms CPU em cerca de 30,274 s incluindo inicialização. Exclui CPU/memória dos filhos. Não se apresenta como consumo total dos motores.
- WFP continua indisponível, limitação já conhecida; não é o Firewall do Windows. Não foi ativado nem alterado.

Este corpus não é equivalente aos 800 alvos do histórico de 594406 ms. Esse problema não é declarado resolvido. Os tempos agora mostram custo de múltiplas cargas ClamAV e ZIP neste caso pequeno; não justificam reduzir cobertura. Não houve stress pesado, EICAR ou terminação de aplicações pessoais.

## Gestor e ensaios instalados
Percurso básico considerado validado pela evidência anterior de terminação individual da fixture no Windows (confirmação no produto, auditoria e reconciliação SO), mais relato do proprietário nesta missão: utilização manual prolongada sem indisponibilidade observada. O relato é evidência manual reportada, sem duração controlada, métricas de carga ou estatística de disponibilidade. Não foi repetida terminação física.
A RC1 LAB 497e634 anteriormente instalada no PC principal abriu, preservou sessão/histórico e passou SQLite quick_check/contagens conforme relatório privado da validação anterior. Isso NÃO é validação instalada do código novo desta branch. Nesta ronda não foi executado setup, feito upgrade, acedida VM ou alterada a instalação pessoal.

## Qualidade e regressões
- Build ordenado dos 8 workspaces: aprovado; build final da app após ajuste de política: aprovado.
- Typecheck dos workspaces: aprovado (service delega verificação conforme script existente).
- App: 2914 testes aprovados, zero falhas. Inclui quatro novos de gates/versão/erro/cancelamento.
- Desktop: 673 aprovados, zero falhas.
- Scripts: 441 casos, 436 aprovados, zero falhas, 5 ignorados. As inspeções do asar/pacote atual requerem novo artefacto; suíte de staging de produção não foi ativada. Não contam como provas de novo packaging.
- Cadeia release/key/workflow: 13 aprovados. A suíte detetou que release-key-setup omitira assistedInstallationEnabled, lido por production.ts; agora emite false explicitamente. As chaves dos testes são efémeras, não produção.
- Fixture de clamav-seed-bundle omitia scanEngine exigido pelo manifesto com launcher externo; corrigida a entrada de teste e acrescentada asserção do recurso launcher. Nenhuma salvaguarda do pipeline foi relaxada.
- Aviso de chunks >500 kB mantém-se; não se declarou melhoria de FPS/CPU nem ausência de fugas GPU sem medição adequada.

## Preflight, integridade e inventário
Pré-verificação oficial --check --json: inputs presentes; bundle ClamAV 1.5.4 (45 ficheiros), YARA 4.6.0 (4 ficheiros), seed ClamAV (4 ficheiros) e licenças prova-fecha aprovados. Resultado global bloqueado pelo freeze antigo divergente. Não é uma falha a contornar.
Inventário oficial recalculado de fontes em d42c683: 1891 entradas; digest b1a38dc8e19df247e328300f6273fee7567b2bf7d12dd41fae420dcbc195a4e8. Comparação com manifesto RC1: 12 adicionadas, 15 modificadas, zero removidas/ilegíveis/links/mutações/obrigatórios ausentes. Este digest NÃO está aprovado. A documentação e workflows são revistos por Git além das raízes do contrato de inventário.
Manifesto aprovado antigo preservado: SHA-256 df81b7992507cfd959901ae921493b2e777d4bee896bf172455bd2a57cc6846b.
Setup RC1 LAB preservado: SHA-256 155862f6453201d052a32f1d48fe1f349d86a1f32f517097e9ed8168133896a6. Nenhum setup novo empacotado/reassinado, nenhuma versão alterada.

Artefactos desta ronda em output/: final-integration-build.log, final-integration-app-build.log, final-integration-typecheck.log, final-integration-app-tests.log, final-integration-desktop-tests.log, final-integration-scripts-tests.log, final-release-chain-tests.log, final-small-real-benchmark.json/log (incompleto), final-small-four-engines.json/log, final-benchmark-child-reconciliation.json, final-release-preflight.json, final-source-inventory-check.json. Logs brutos locais não são publicados por conter caminhos/contexto do computador.

## Bloqueadores externos e próximos gates
1. Escolher/obter assinatura Authenticode legítima e aprovar publisher exato; ver docs/ASSINATURA-E-GITHUB-V020-20261103.md.
2. Gerar e aprovar Ed25519 sob controlo do proprietário, fora do repo; provisionar pública/fingerprint e mecanismo offline/CI protegido. Sem chave gerada/forjada nesta ronda.
3. Autorizar ambiente e distribuição de teste compatível para duas versões. Feed privado/draft não é acessível ao cliente atual sem autenticação; não foi publicada Release pública para forçar o ensaio.
4. Provar update real, NSIS, shutdown/reinício, confirmação de versão e preservação SQLite/configurações. Simulador/testes unitários não substituem esta prova.
5. Validar recursos gráficos/reduced motion/DPI e consumo num ensaio apropriado; o fallback forçado já foi visto, ausência real de WebGL/ausência de fugas não certificadas.
6. Fechar a árvore após confiança/integração, definir 0.2.0 coerentemente, novo inventário e aprovação válida de freeze; só então packaging final assinado/payload/checksums.
7. Aprovação própria para merge main, tag e Release pública. Nenhuma dessas operações foi executada.

Resultado: engenharia de apresentação integrada e lacunas de tooling corrigidas; GO para revisão e continuação controlada. NO-GO para anunciar v0.2.0 final ou atualizador público funcional.


## Verificação adicional num runner Windows limpo
A primeira execução remota (41674507216, HEAD 3d115c0) passou o build e a aplicação, mas encontrou duas falhas desktop: launcher C++ ausente no checkout limpo e isolamento não confirmado na fixture da ponte de segurança. A aprovação local não foi apresentada como aprovação remota.
O commit d42c683 acrescenta o build do launcher e do simulador inerte antes da suíte desktop. A fixture passa a resolver o caminho temporário canónico antes de criar os seus ficheiros: aliases de nome curto/junction não são um alvo adequado para o percurso que exige ausência de redirecionamento. Acrescentou-se diagnóstico dos eventos à asserção para identificar recusas persistentes. As verificações de caminhos e identidade do produto não foram alteradas.
Validação local dirigida: 3 testes da ponte de segurança e 5 ensaios de handoff aprovados, sem instalação. Revisão de padrões de segredos no diff: zero correspondências nos padrões inspecionados; não equivale a garantia universal.

Resultado remoto confirmado: https://github.com/MatrixChill/cybersafe-assistant/actions/runs/41675848542 — success, código d42c6834055a6bf6cbad51a83ea93d4ce9b11295. Build dos workspaces aprovado; aplicação 2914/2914, desktop 673/673 (zero skips), handoff Windows 5/5. Todos os restantes passos dirigidos do workflow passaram. Log completo local: output/final-github-ci-success.log. Isto continua a ser build/testes em runner limpo, não instalação NSIS nem upgrade real. O commit documental seguinte regista esta evidência e não modifica os fontes inventariados.
