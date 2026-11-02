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

Só depois de existir chave Ed25519 pública de produção, fingerprint aprovado e feed assinado.

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
