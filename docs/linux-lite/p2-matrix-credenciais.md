# P2 — MATRIX Linux: onde a chave de IA fica, e o que o ecrã pode dizer

Documento do trabalho Linux Lite (branch `experimental/linux-lite-qoder`). Cobre o
ponto 8 do objetivo: «utilizar armazenamento seguro compatível, quando disponível, ou
configuração local protegida adequada ao modelo de execução. A interface deve informar
quando não existir um mecanismo seguro de armazenamento».

## Os dois eixos (o defeito original era misturá-los)

| Eixo | Pergunta | Onde vivia |
|---|---|---|
| Presença | existe chave configurada? | `hasKey` |
| Repouso | como está guardada essa chave? | **não existia** — o ecrã afirmava «cifrada localmente com DPAPI/safeStorage» sem nunca ter lido o mecanismo |

O `MatrixConfigModal` dizia «protegida por DPAPI» em Windows **e** em Linux, e o IPC
reduzia qualquer recusa a «Não foi possível atualizar a configuração protegida da IA».
Em Linux sem keyring isso era, no melhor dos casos, uma frase vazia e, no pior, uma
afirmação falsa: o `basic_text` do Electron cifra com uma chave fixa do código.

## O que passou a existir

`packages/desktop/src/mecanismo-credenciais.ts` — classificação pura, sem Electron:

| Plataforma / factos | `nivel` | Rótulo no ecrã |
|---|---|---|
| `win32`, cifra disponível | `seguro` | DPAPI (Windows) |
| `darwin`, cifra disponível | `seguro` | Keychain (macOS) |
| `linux` + backend `gnome_libsecret` / `kwallet*` | `seguro` | nome do gestor de segredos |
| `linux` + backend `basic_text` | `nao-seguro` | cifra de chave fixa (basic_text) |
| `linux` sem cifra disponível | `nao-seguro` | sem mecanismo seguro de armazenamento |
| `linux` com cifra mas backend `unknown`/inexistível | `desconhecido` | mecanismo por confirmar |

Fonte dos factos: `safeStorage.isEncryptionAvailable()` e
`safeStorage.getSelectedStorageBackend()` — este último existe no Electron 33.4.11 do
projeto e só tem significado em Linux (`node_modules/electron/electron.d.ts:10772`).
**Disponibilidade não identifica o backend**; por isso é o backend nomeado que autoriza
a palavra «cifrada», e a sua ausência é `desconhecido`, nunca `seguro`.

Aplicado em `ai-credentials-store.ts`:

- `writeKey` só escreve o ficheiro cifrado com `nivel === "seguro"`. Recusa com
  `RecusaArmazenamento(codigo: "mecanismo-insuficiente")` cujo texto inclui o rótulo,
  a explicação e o remédio; a recusa acontece **antes** de qualquer `mkdir`.
- `writeKeyLocalProtegido(key, provider, consentido)` é a «configuração local
  protegida adequada ao modelo de execução»: `secrets/ai-credentials.local`, modo
  `0600`, diretório `0700`, escrita atómica com `wx` + `fsync`, mesmas guardas de
  symlink/hard link. Recusa sem `consentido === true`
  (`"sem-consentimento"`) e recusa quando existe mecanismo seguro
  (`"cifra-segura-disponivel"`) — nunca se desce de cifra para texto puro.
- Se os dois ficheiros existirem, conta o cifrado; `estado()` devolve
  `origem: "cifrado" | "local-protegido" | null` e o mecanismo; `clear()` remove ambos.
- Nada de novo vai para o renderer: continua a não existir leitura da chave. O IPC
  publica presença, provider, origem e mecanismo (`ai-credentials-ipc.ts`), e a recusa
  usa o texto real em vez do genérico. O payload não contém a chave (testado).
- `main.ts:412` passa `plataforma: process.platform`; em Windows/macOS a classificação
  só consulta `isEncryptionAvailable()`, pelo que o caminho DPAPI é byte a byte o mesmo
  ficheiro cifrado de antes.

O ecrã (`MatrixConfigModal.tsx`) passou a ter duas linhas — «Estado atual» e «Proteção
em repouso» —, um painel de aviso quando `nivel !== "seguro"`, e uma caixa de
consentimento explícito sem a qual o botão «Guardar chave» fica desativado. A frase
sobre DPAPI desapareceu; o texto de sucesso usa o rótulo medido do mecanismo.

## Medido em WSL2 com o Electron real do projeto

Ambiente: `Linux 6.6.114.1-microsoft-standard-WSL2`, uid 1000, `DISPLAY=:0`,
`XDG_CURRENT_DESKTOP` ausente, Electron **33.4.11 linux-x64** extraído do zip já em
`~/.cache/electron` (sem downloads, sem instalar pacotes de sistema).

```
secrets-service: Call failed: The name org.freedesktop.secrets was not provided by any .service files
SONDA {"plataforma":"linux","electron":"33.4.11","node":"20.18.3","display":":0","desktop":null,
       "runtimeDir":"definido","backend":"basic_text","disponivel":false,"idaCifradaCurta":null,
       "modo0600":"600"}
```

Leitura honesta do resultado:

1. Nesta sessão Linux **não há** gestor de segredos e o Electron escolhe o backend
   `basic_text`; aqui ele nem sequer se declara disponível (`disponivel: false`).
   O comportamento anterior já recusava a escrita — mas dizia apenas «A proteção
   DPAPI/safeStorage não está disponível neste sistema», texto que o IPC deitava fora.
   Hoje o utilizador vê o motivo e o remédio.
2. A combinação `basic_text` + `disponivel: true` é a que o código trata como
   `nao-seguro` por inspeção do backend. Não foi possível produzi-la neste ambiente
   (exigiria `--password-store=basic`/`setUsePlainTextEncryption`), por isso é
   cobertura de teste injetado, não medição.
3. `modo0600: "600"` confirma no Linux real a premissa do caminho local protegido: o
   `open(..., 0o600)` é cumprido, logo o fallback consentido protege contra outros
   utilizadores — não contra outro processo do próprio utilizador, que é exactamente o
   que o aviso em cima da caixa de consentimento diz.

## Testes e regressão

`packages/desktop/test/p2-matrix-credenciais-linux.test.mjs` — 8 casos: classificação
por plataforma e backend; recusa sem tocar no disco; cifra real com libsecret;
consentimento obrigatório e proibição de descer de nível; 0600/0700, leitura após
reinício e estado «sem cifra»; prioridade da cifra e `clear` dos dois ficheiros;
IPC que publica o mecanismo e nunca ecoa a chave; IPC em Windows a manter o caminho
cifrado mesmo com o consentimento ligado.

`ag36-ai-credentials.test.mjs` (contrato Windows) mantém as suas 7 asserções; passou a
fixar `plataforma: "win32"` no fixture, porque sem essa hipótese declarada o mesmo
teste significaria coisas diferentes consoante o sistema onde corresse.

Regressão Windows corrida no clone isolado (win32, Node 26.3.0, Electron 33.4.11):

| Suíte | Resultado |
|---|---|
| `@cybersafe/desktop` | 645 testes, 645 passados, 0 falhas |
| `@cybersafe/app` | 2877 testes, 2877 passados, 0 falhas |
| typecheck `@cybersafe/desktop` | limpo |
| typecheck `@cybersafe/app` | limpo |

A linha `@cybersafe/app` foi medida depois de `TaskManagerPage.tsx` ter passado a ter
um único sítio de bloqueio para o SIGTERM e o SIGKILL; sem essa correção a suíte dava
2876/2877 com o teste `H4` vermelho (dois `setIsKilling(true)`). O corte de credenciais
não toca nesse ficheiro — os dois commits são separados precisamente para que a origem
de cada número se possa ler no histórico.

## Reproduzir

```bash
# testes de credenciais (Windows ou Linux, com tsx)
cd packages/desktop && node --import tsx --test test/p2-matrix-credenciais-linux.test.mjs test/ag36-ai-credentials.test.mjs
```

```bash
# sonda real ao safeStorage do Electron 33.4.11 (WSL2; precisa do zip em ~/.cache/electron)
wsl -e bash -lc 'S=/mnt/c/Users/caioc/.cybersafe-integration/qoder-linux-lite/repo/scripts/linux-lite; \
  tr -d "\015" < $S/wsl-p2-matrix-sonda.sh > /tmp/sonda.sh && bash /tmp/sonda.sh "$S"'
```

## Ainda não medido

- Nenhum keyring foi testado: `gnome_libsecret`, `kwallet5/6` são cobertos por teste
  injetado. Confirmar a tabela exige sessão Ubuntu/Mint com `gnome-keyring` ou `kwallet`.
- O ecrã do modal nos três estados (seguro / sem mecanismo / consentido) não foi visto
  num Linux gráfico — falta a validação GUI da VM.
- O envio da chave para o fornecedor (`ai-api-channel.ts` → API local) não foi
  alterado nem re-medido aqui; continua o caminho já documentado no P0/P1.
- Chaves em logs/Git/builds: nenhuma chave é lida por este caminho de código a partir
  do perfil Windows (o ficheiro vive no `userData` do Linux Lite), e nenhum literal de
  teste sintético corresponde a uma chave real. Não foi feita varredura de repositório
  nesta fase.
