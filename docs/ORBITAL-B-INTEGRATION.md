# Orbital B — frontend Win32 dentro do Setup NSIS

Checkpoint: 2026-11-04. Estado: **READY FOR MANUAL TEST — integração LAB verificada; candidata da aplicação ainda não gerada**.

## Arquitetura implementada

A interface é o desenho original de `scripts/setup-ui/main.cpp`, Win32/GDI+, janela 1120×720, órbitas, logótipo, cartões, navegação e botões originais. Não é uma página MUI reestilizada. `scripts/setup-ui/build.bat` produz `packages/desktop/build/x86-unicode/OrbitalSetup.dll` com MSVC x86 Unicode, CRT /MT. O único distribuível continua a ser o Setup NSIS do electron-builder, com DLL e recursos oficiais embutidos e extraídos em `$PLUGINSDIR`.

`packages/desktop/build/installer/orbital-installer.nsh` é agora o include selecionado. O trabalho anterior em `cybersafe-installer.nsh`, bitmaps, traduções e controlos foi preservado. O script principal e o desinstalador do electron-builder não foram substituídos nem alterados em node_modules.

### Comunicação e confiança

- `Start` abre uma thread UI e aguarda a decisão; devolve ação, destino e dois atalhos pela stack NSIS. Só a thread NSIS usa o ABI. Mensagens internas síncronas transferem fases/resultados; não existem portas, pipes públicos ou segundo Setup externo.
- `customInit` corre **depois** de `initMultiUser` na versão instalada do builder. Não se volta a chamar a macro que sobrescreve o destino. `/S` preserva o percurso NSIS do launcher, sem UI nem overrides de opções.
- `Validate` exige destino local, absoluto, canónico, não-root, sem reparse points existentes, componentes ambíguos ou Windows. Uma instalação nova exige pasta vazia com o nome do produto; uma atualização interativa fica presa ao InstallLocation registado. Motivo: o desinstalador stock remove a árvore inteira.
- `Begin` serializa o limite de cancelamento na thread UI. Antes de mutações, cancelar devolve erro e não extrai payload. Durante a secção crítica, Cancelar e fechar não forçam a terminação. A UI explica a indisponibilidade. Não existe promessa de rollback nem cancelamento a meio de Nsis7z.
- Progresso é indeterminado, com fases reais antes/depois da secção; nenhum temporizador decide percentagem ou conclusão. O tamanho do payload vem da secção NSIS, e o espaço livre da API Windows; não é uma estimativa completa das necessidades de staging.
- `Verify` compara SHA-256 de todos os ficheiros instalados com a árvore recém-extraída do 7z embutido. `customInstall` exige também EXE, app.asar, uninstaller, destino e DisplayVersion esperados, e aplica os atalhos. ZIP/APP_BUILD_DIR interativos não têm referência equivalente e falham fechados.
- Sucesso só é mostrado no callback `.onInstSuccess` com prova de verificação. `.onInstFailed` mostra falha. Uma saída `Quit` sem callback é coberta no lifetime callback do plugin: resultado não aprovado e exit 2.
- DLL e recursos são parte do EXE a assinar, não uma assinatura independente. O preflight exige a DLL; o freeze inclui explicitamente os seus bytes. Não se criou nova confiança de produção.

## Funcionalidades indisponíveis, explicitamente

- **Reparar e Desinstalar no frontend**: botões desativados com explicação. O desinstalador legítimo instalado continua disponível nas Definições do Windows; foi ensaiado em LAB. Não é uma implementação da ação Desinstalar dentro do Orbital B.
- Âmbito para todos os utilizadores indisponível neste percurso interativo; não se pede elevação nem se converte instalação existente em silêncio.
- Abertura automática da app indisponível; não existe checkbox aparentemente funcional. Os avisos de licença verdadeiros são apresentados em texto dentro do frontend. Não foi inventada uma EULA.
- Não foi validada acessibilidade completa do desenho owner-drawn, teclado em todos os controlos/DPI múltiplo, nem criação de atalhos ativados num desktop real.

## Evidência executada

### Fronteiras e falhas — 11 cenários

`node scripts/test-orbital-installer-lab.mjs` + `powershell -File scripts/setup-ui/test-backend.ps1`.
Última execução: `output/orbital-backend-lab/run-gkE2zj/observations.json`.

PASS: destino alterado recebido pelo NSIS, opções desmarcadas recebidas, 20 ficheiros extraídos e hashes verificados, erro deliberado exit 2, cancelamento pré-instalação exit 1 sem payload, destino relativo recusado, pasta ocupada preservada, nome impróprio recusado, destino adulterado recusado sem extração, payload corrompido recusado, `Quit` sem callback exit 2, conclusão sem prova recusada e `/S` sem UI com hashes corretos. A tentativa de fechar durante a fase crítica não interrompeu a extração. Os testes de recusa são PASS dos gates, não instalações aprovadas.

### Script completo do electron-builder, 7z e A→B benigno

`node scripts/test-orbital-full-lab.mjs` + `powershell -File scripts/setup-ui/test-full-backend.ps1`.
Última execução: `output/orbital-full-lab/run-SHHHvF/observations.json`.

PASS: uninstaller gerado pelo template original; A interativo com Orbital B; destino escolhido; 7z real; 22 ficheiros SHA-256 idênticos; DisplayVersion e InstallLocation reais; texto da Licença idêntico ao documento original; B com a mesma identidade LAB, `/S --updated /currentuser`, nova versão `0.2.0-rc.2-LAB`, outros 22 hashes verificados, destino mantido; desinstalação legítima de B exit 0; registo LAB removido; ficheiro de dados separado preservado. A/B contêm apenas ficheiros benignos, incluindo marcadores não executáveis de EXE/asar. Não foram lançados como aplicação nem são candidatas CyberSafe.

Setup A LAB: `output/orbital-full-lab/run-SHHHvF/Orbital-B-Full-NSIS-LAB.exe`.
SHA-256: `306eef9ebf510e43d8127d0ba6851394e400f4362623480f9946afea57bae96c`.
Plugin final: `7712ec4a8e8e18909966ab0f456d8558d0c70cc4afd964d39e09532e714c9453`.
Capturas: `welcome.png`, `license.png`, `options.png`, `complete.png` nessa pasta; progresso em `output/orbital-backend-lab/run-gkE2zj/success/progress.png`.

### Regressões

- MSVC plugin: PASS, recompilado após a última alteração C++.
- `npm run test:scripts`: 472 total, **467 PASS, 0 FAIL, 5 skip**. Depois das últimas alterações C++, os seis contratos Orbital/NSIS foram repetidos: **6/6**.
- `npm run test -w @cybersafe/service` com perfil descartável e TEMP/TMP em `output/freebuff-final/Temp`: **1012 PASS, 0 FAIL, 1 skip**; segundo bloco **12/12**. Não se alteraram veredictos do produto.
- Handoff real existente: **5/5**, `output/freebuff-final/orbital-updater-handoff.log`; launcher nativo, simulador inerte, locks e recusas. Não é teste do launcher a executar este Setup LAB.
- `git diff --check`: PASS.

Falhas anteriores preservadas em logs: o primeiro harness não editava realmente o EDIT de outra janela (`SetWindowTextW`); corrigido para WM_SETTEXT/WM_GETTEXT e confirmado o destino. O template completo cria uma pasta inicial vazia em `.onInit`; a asserção foi corrigida para exigir ausência de payload aí, não ausência da pasta. A fixture de preservação não era escrita no caminho esperado devido a argumentos posicionais de PowerShell; agora usa LiteralPath/Value e comprova a escrita antes do ensaio. A primeira suite scripts com TEMP dentro do repo falhou os gates de chaves/aprovadores e fixtures sem DLL; fixtures completadas e suite repetida no ambiente normal sem enfraquecer os gates.

## Gates de entrega

**BLOCKED**: candidata Windows real, source-freeze novo aprovado para HEAD/digest exatos e registo externo de aprovadores. `--verify` nesta sessão falhou fechado por `CYBERSAFE_APPROVERS_FILE` ausente; não se correu `--write`. Authenticode, Ed25519 públicos, instalação pessoal, tag/Release e push não efetuados. Trust de produção mantém `enabled:false`, `assistedInstallationEnabled:false`.

**NOT TESTED**: instalação/arranque/Scanner/SQLite da nova candidata CyberSafe e A→B instalado da aplicação real. Os artefactos antigos não foram substituídos. Linux precisa rebuild pelas alterações partilhadas anteriores; pacotes antigos preservados, desktop Linux nativo não validado.

Fontes técnicas: https://www.electron.build/docs/nsis ; https://nsis.sourceforge.io/Docs/Chapter4.html ; https://raw.githubusercontent.com/kichik/nsis/master/Source/exehead/api.h ; https://raw.githubusercontent.com/kichik/nsis/master/Source/exehead/plugin.c . A ausência de `.onInstFailed` em todos os percursos não foi presumida: `Quit` foi ensaiado explicitamente.
