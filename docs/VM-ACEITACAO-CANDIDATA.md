# VM Windows — roteiro de aceitação da candidata

Estado: **NÃO EXECUTADO**. Este roteiro existe para ser corrido numa VM Windows isolada, com autorização, sobre uma candidata já empacotada. Não substitui o packaging, o freeze, o Authenticode nem a aprovação de publicação.

## 0. Pré-condições

- Windows 11 x64, preferencialmente 23H2/24H2, snapshot limpo antes de cada ciclo.
- Sem CyberSafe instalado, sem processos `CyberSafe*`, sem serviços `CyberSafe*`.
- 8 GB RAM e 20480 MB livres no disco do sistema, no mínimo.
- Setup da candidata, `product-version.json` e SHA-256 fornecidos pelo build.
- Uma conta de teste local, sem dados pessoais. O teste de login usa uma conta de ensaio.
- Nenhuma chave privada de produção dentro da VM.
- Autorização explícita para instalar/desinstalar e para usar EICAR numa pasta isolada.

Guardar tudo em `C:\lab\evidence\<data>\`; nunca usar `output/` do repositório como única cópia.

## 1. Preflight (executável)

```powershell
$Installer = "C:\lab\CyberSafe-Assistant-<versao>-setup.exe"
$Evidence  = "C:\lab\evidence\20261102"
New-Item -ItemType Directory -Force $Evidence | Out-Null
powershell -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\vm-acceptance-preflight.ps1 `
  -InstallerPath $Installer `
  -OutFile (Join-Path $Evidence "00-preflight.json")
```

Critérios:

- `cleanHost=true` antes da instalação.
- `installer.sha256` igual ao SHA publicado pelo build.
- `signatureStatus` registado; se continuar `NotSigned`, não declarar Authenticode.
- `version.productVersionMatchesExpected=true`.
- `updaterTrust.enabled=false` é o estado atual; não tentar ativar sem chave/fingerprint aprovados.

## 2. Instalação limpa

1. Executar o setup sem `/S`.
2. Capturar boas-vindas, opções, progresso e conclusão. O progresso deve ser o Nsis7z real, não uma barra simulada.
3. Confirmar:
   - instalação por utilizador, sem elevação;
   - pasta `%LOCALAPPDATA%\Programs\CyberSafe Assistant`;
   - atalhos no Desktop e Start Menu criados ou removidos conforme as opções;
   - `.exe` principal e desinstalador existentes;
   - versão mostrada no setup = versão canónica;
   - sem erros no log do instalador.
4. Abrir a aplicação pelo checkbox final e confirmar que o primeiro arranque não bloqueia.

Evidência: capturas datadas, `Get-ChildItem` da pasta, `Get-ItemProperty` da chave `Uninstall`, `Get-AuthenticodeSignature` do `.exe`.

## 3. Primeiro arranque e serviço

- Confirmar processo principal, serviço de proteção e tray.
- Verificar que a aplicação mostra `Serviço ligado` apenas quando há leitura real; sem serviço, deve mostrar indisponível.
- Confirmar versão em `Sobre` e no setup.
- Confirmar login/registo e persistência de sessão; terminar sessão e repetir.
- Medir tempo até à janela utilizável e tempo até ao primeiro snapshot; registar, não inventar.

## 4. Scanner e motores

Preparar corpus benigno isolado e, só nesta VM, uma pasta EICAR separada.

- Análise rápida e profunda.
- Confirmar ficheiros considerados/analisados/conclusivos/inconclusivos/excluídos.
- Confirmar saúde de ClamAV, YARA, HashDB e motor nativo; não apresentar YARA de teste como cobertura real.
- Registar tempo total e fases. A meta de cinco minutos para 800 ficheiros só é PASS com medição no artefacto instalado.
- Confirmar que ficheiros não analisados não são contados como limpos.

## 5. Quarentena, restauro e relatório

- Ativar quarentena automática com consentimento explícito.
- Detetar EICAR na pasta isolada; confirmar quarentena, hash e metadados.
- Restaurar para uma pasta de teste e confirmar o hash.
- Gerar relatório/PDF e confirmar que não contém caminhos pessoais nem segredos.
- Desligar a política e confirmar que a UI não continua a dizer “ativa”.

## 6. Gestor de Tarefas

### Fixture benigna preparada para o ensaio instalado

Somente na VM autorizada, numa consola sem elevação e na mesma sessão/conta da candidata:

```powershell
.\scripts\vm-process-fixture.ps1 -AuthorizedVm -OutDirectory C:\lab\process-case-01 -StartFixture
```

Usar uma pasta nova por caso. O helper recusa host sem identificação de VM, elevação, caminhos protegidos e substituição de ficheiros. Compila com o .NET local um `termination-fixture.exe` que apenas espera três minutos e sai naturalmente. Não termina processos, não faz rede, não modifica serviços nem instala ferramentas. O reconhecimento de VM é uma guarda operacional, não uma fronteira contra um operador malicioso.

Guardar `fixture-evidence.json` (SHA-256, PID e início). Na UI, pesquisar esse nome e confirmar **PID e início da mesma instância**, sem selecionar processos pessoais ou homónimos. Verificar CPU/RAM como medições, sem exigir valores artificiais específicos.

1. Abrir a confirmação e cancelar: o processo continua e nenhuma terminação é auditada como sucesso.
2. Criar outra fixture, preparar e confirmar dentro da validade do ticket: exigir resultado real, auditoria e desaparecimento após nova enumeração. Confirmar ausência com `Get-Process -Id <PID da fixture>`; se o PID reaparecer, comparar o início antes de concluir.
3. Criar outra fixture e deixá-la sair naturalmente: a UI não pode atribuir a saída ao CyberSafe.
4. Ticket expirado, confirmação repetida e identidade desatualizada devem ser recusados. Não alterar relógio, direitos ou processos do Windows para fabricar estes casos; usar os testes deterministas existentes e registar o limite do ensaio manual.
5. Processos protegidos permanecem inelegíveis. `KILL_TERMINATION_DISABLED` continua ativo; não chamar o comando legado nem usar taskkill como alternativa.

Estado deste procedimento: **PREPARADO, NÃO EXECUTADO EM VM**. A sintaxe do helper foi verificada; não foi compilada nem iniciada uma fixture no computador pessoal. Este procedimento ainda não comprova a terminação instalada.

- Abrir Notepad ou processo benigno elegível.
- Confirmar listagem, detalhe e classificação.
- Testar uma terminação individual permitida e uma recusa protegida; confirmar auditoria e ausência de crash.
- Confirmar que `KILL_TERMINATION_DISABLED=true` continua a recusar o caminho legado.
- Repetir com a janela em segundo plano e com o serviço ocupado; não aceitar um freeze como sucesso.

## 7. MATRIX online

Só com fornecedor real e credencial autorizada.

- Consentimento explícito, chamada com métricas de processo, resposta e expiração.
- Revogar consentimento e confirmar que uma nova chamada é recusada.
- Simular falha de rede e confirmar que a UI não inventa resposta.
- Confirmar que nenhuma chave ou prompt completo aparece em logs, relatórios ou browser storage.

## 8. Atualizador

O ensaio da cadeia com HTTPS local e chaves efémeras pode ser executado antes de provisionar confiança de produção:

```powershell
node --import tsx --test packages/desktop/test/updater-local-https.integration.test.mjs
```

Exige OpenSSL local (ou `CYBERSAFE_TEST_OPENSSL`), gera TLS/Ed25519 efémeros, usa apenas loopback e cache temporária, e nunca executa instalador. A CA é confiada apenas pelo processo filho de teste; não é instalada no Windows. Não equivale a upgrade instalado.

Para o canal oficial, exigir chave pública de produção, fingerprint aprovado e feed assinado. Para upgrade com candidatas de teste, usar configuração explicitamente isolada e aprovada; nunca substituir `release-trust.json` de produção por material de fixture.

- Feed de teste assinado, manifesto, tamanho e SHA-256.
- Atualização aplicada, reinício e versão nova.
- Assinatura inválida, fingerprint errado e manifesto truncado: recusa fechada.
- Rollback para a versão anterior sem perder dados.
- `release-trust.json` só pode estar `enabled:true` com chave/fingerprint reais; nunca com fixture.

## 9. Upgrade, reparação e desinstalação

- Instalar a versão N-1, criar dados, sessão, exclusões e quarentena.
- Instalar a candidata por cima: confirmar upgrade, dados e definições preservados.
- Executar reparação a partir do setup; confirmar que não duplica a instalação.
- Desinstalar: atalhos e binários removidos; dados de utilizador preservados; registo limpo.
- Reinstalar e confirmar que os dados continuam legíveis.

## 10. UI, DPI, GPU e encerramento

- 100%, 125% e 150% de escala; textos longos em PT-PT.
- GPU presente e GPU ausente: o núcleo 3D deve degradar para o fallback sem partir o layout.
- Movimento reduzido/desligado; confirmar que o Orbital Glass não anima.
- Encerrar pela janela, pelo tray e com o serviço ocupado; confirmar que não ficam processos órfãos.
- Reiniciar a VM e confirmar que a aplicação não arranca sozinha sem opt-in.

## 11. Evidência mínima

Por fase:

- JSON do preflight.
- capturas de ecrã datadas;
- stdout/stderr e código de saída dos comandos;
- `Get-FileHash` dos artefactos;
- versão e estado dos motores;
- lista de PASS/FAIL/INCONCLUSIVO com a razão.

Não declarar PASS sem output. Um teste não executado fica **NÃO EXECUTADO**, não “passou por inspeção”.

## 12. Bloqueadores atuais

- Não existe candidata integrada final; o setup V3 é uma **pré-visualização de design** a partir do `win-unpacked` existente.
- Os BMPs V3 estão em `tmp-installer-preview/`, não em `packages/desktop/build/installer/`.
- A assinatura Authenticode continua ausente.
- A chave Ed25519 de produção e o feed assinado continuam por provisionar.
- O corpus YARA disponível é de teste.
- A versão continua `0.1.11-internal.pap-r7.20261031`; não foi promovida para `0.2.0`.


## Abertura e tray — aceitação nativa obrigatória

Estado: **PENDENTE DE VM**, não coberto pelos testes com objetos de janela simulados.

- Instalação normal: opção «Abrir o CyberSafe Assistant» marcada; concluir e confirmar janela visível, utilizável e em primeiro plano. Repetir desmarcando: não deve abrir.
- Repetir após upgrade autorizado, preservando dados; o argumento `--updated` não deve equivaler a `--hidden`.
- Com a janela minimizada, escondida pelo X, atrás de outra janela e já visível, fazer duplo clique no ícone do tray: restaurar/mostrar/focar a mesma janela.
- Capturar menu do clique direito e confirmar a ação de abrir; manter o comportamento do clique simples.
- Confirmar um único processo principal/instância (os subprocessos legítimos do Electron não contam como instâncias adicionais).
- Durante encerramento, clicar não deve recriar a janela. Na inicialização, um pedido explícito deve sobreviver até a janela estar pronta.
- Arranque automático autorizado com `--hidden`: manter oculto até pedido explícito. Não confundir este cenário com o primeiro arranque após instalação.
- Guardar capturas antes/depois e registar versão/hash exatos da candidata; não instalar no computador pessoal para obter esta prova.
