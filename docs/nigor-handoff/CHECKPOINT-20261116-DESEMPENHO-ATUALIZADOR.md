# Checkpoint 16/11 — desempenho, quarentena entre discos e atualizador A→B

Branch `codex/nigor-arch-20261113`. Commits: `9c49cc4` (helper: corridas e lock
órfão), `1b36b8c` (lote ClamAV no tempo real), `b1f38b1` (aceitação de
quarentena entre sistemas de ficheiros e candidatas `0.2.4-5` / Nigor `0.2.4-2`).
Tudo medido no laboratório Arch/WSL2 descartável. Nada foi feito na máquina Nigor real.

## 1. Desempenho do Scanner em tempo real (modo económico)

**Causa:** no modo económico (o modo por omissão, sem clamd), cada ficheiro
observado lançava o seu próprio `clamscan`, e cada `clamscan` recarrega a base
oficial (~994 MB RSS medidos). Uma rajada ficava em série atrás dessas cargas,
o que explica os minutos de atraso observados no Nigor.

**Correção:** quando um job de tempo real arranca com outros ficheiros à espera,
um único `clamscan` analisa até 32. Os jobs seguintes reutilizam o veredicto
ClamAV só se a impressão digital admitida for a mesma, o resultado for recente
(< 120 s) e não for erro. YARA, HashDB e o motor nativo continuam a correr por
ficheiro, e uma alteração de conteúdo volta a pôr o ficheiro na fila (`changed`).

| Rajada benigna (watcher → fila → motores → veredicto) | Antes | Depois |
|---|---|---|
| 10 ficheiros: total / mediana / P95 | 55,0 s / 29,0 s / 55,0 s | 13,8 s / 13,6 s / 13,7 s |
| 40 ficheiros: total / mediana / P95 | 212,5 s / 109,7 s / 202,2 s | 19,5 s / 13,8 s / 19,4 s |
| Pico RSS do `clamscan` | ~994 MB | ~994 MB (inalterado) |

A RAM **não** baixou: há menos cargas da base, não cargas mais leves. Para
manter a base em memória continua disponível o perfil clamd opcional
(ver [LINUX-NEXT](LINUX-NEXT-20261116.md)). Para reproduzir:
`scripts/linux-lite/benchmark-realtime-economy.mjs --disposable-lab --count=N`.
Não medimos o hardware do Nigor; o ganho real lá está **NÃO TESTADO**.

## 2. Quarentena entre sistemas de ficheiros

`scripts/linux-lite/verify-quarantine-crossfs.sh --disposable-lab` (montagens
descartáveis; o motor corre como utilizador normal):

| Origem | Quarentena | Original | Modo | Restauro |
|---|---|---|---|---|
| Mesmo volume (ext4) | confirmada | inacessível | 000 | idêntico (SHA-256) |
| tmpfs | confirmada | inacessível | 000 | idêntico |
| vfat em loop (tipo USB) | confirmada | inacessível | 000 | idêntico |
| vfat só de leitura | **recusada** | preservado | — | — |

Não foi precisa nenhuma correção: o caminho EXDEV de `5700347` comporta-se
corretamente nestes sistemas de ficheiros reais. Com uma pen USB física no
Nigor: **NÃO TESTADO**.

## 3. Prevenção antes da execução

Mantém-se o que está em [LINUX-NEXT](LINUX-NEXT-20261116.md): o bloqueio com
fanotify/clamonacc funcionou apenas numa pasta descartável em laboratório e
**não está ativado** no produto. O produto faz deteção e quarentena **depois**
da escrita, e a UI e o JSON dizem-no (`monitoring.mode = post-write`,
`preventionConfirmed = false`). Nada privilegiado foi ativado em nenhuma máquina principal.

## 4. Atualizador — percurso A→B real (edição Nigor)

Pacotes de laboratório reempacotados a partir do payload Nigor real e assinados
com uma chave **efémera de laboratório** (nunca publicada). Helper real do
pacote, `pacman -U` real, pseudo-terminal real:

| Caso | Resultado |
|---|---|
| Autorização recusada (polkit, palavra-passe errada) | `pkexec` 127; versão A intacta |
| Helper antigo (`e829dc8`) com lock órfão | `installation-busy-or-interrupted` (defeito reproduzido) |
| Helper corrigido com lock órfão | lock preservado como `.install.lock.stale-*` e recuperado |
| Serviço comprovadamente a correr | `service-running` |
| `db.lck` presente | `pacman-busy` |
| Utilizador responde «n» ao pacman | `package-installation-failed`; A intacto |
| Instalação válida `0.2.4-103 → 0.2.4-104` | instalada; `pacman -Qkk` 220/0; SQLite com o mesmo hash; serviço e histórico (mesmo ID) preservados |
| Reinstalar a mesma versão | `downgrade-or-equal` |
| Instalação interrompida durante a confirmação | sem `db.lck`; A intacto; diário em `installing` |

**Ainda não demonstrado:** o agente polkit **com a palavra-passe certa**.
Nesta sessão WSL o agente de texto falha com «No session for cookie» (sem
sessão logind para o processo). O caso autorizado foi exercido executando o
mesmo helper como root com `PKEXEC_UID`, que é o contexto que o `pkexec` lhe
dá. Com o agente polkit gráfico do Nigor: **NÃO TESTADO**.

## Clientes antigos e canais

O canal antigo continua a apontar para a Preview 2 e nada foi promovido nele.
Os clientes anteriores ao protocolo protegido (helper com staging privado)
precisam de uma instalação manual uma única vez. Os manifestos v2 exigem um
`minClient` protegido (Arch `0.2.4-4`, Nigor `0.2.4-1`) e a edição certa.

## Publicado (16/11)

- Candidatas de `b1f38b1`: `linux-lite 0.2.4-5` (não publicada; a Preview 3 continua a ser o
  download Linux genérico) e `nigor 0.2.4-2`, publicada como
  [nigor-v0.2.4-preview.1](https://github.com/MatrixChill/cybersafe-assistant/releases/tag/nigor-v0.2.4-preview.1).
- Aceitação da candidata Nigor no laboratório: migração da Preview 3 pública
  (SHA256SUMS verificados), `pacman -Qkk` 220/0, SQLite com o mesmo hash,
  abertura sem conta sob Xvfb, `/health` 200, rotas privadas 401, serviço e
  análise benigna, atualizador ciente da edição.
- Canal [nigor-update-channel-v2](https://github.com/MatrixChill/cybersafe-assistant/releases/tag/nigor-update-channel-v2)
  com manifesto v2 assinado; o cliente instalado responde `up-to-date` /
  `ed25519-verified`. O canal Linux antigo (Preview 2) não foi alterado.
- Entrega e mensagem: [ENTREGA-NIGOR-PREVIEW-1.md](ENTREGA-NIGOR-PREVIEW-1.md).

## Ponto de continuidade

1. «Lembrar-me» não foi testado de novo nesta candidata: o código de autenticação
   não mudou desde `e829dc8`, onde o outro agente o validou.
2. Login obrigatório na candidata genérica `0.2.4-5`, e eventual publicação dela
   como `linux-v0.2.4-arch-preview.4` com manifesto v2 no feed Arch.
3. Agente polkit gráfico com a palavra-passe certa (impossível no WSL sem sessão logind).
4. Documentos de entrega do outro agente, ainda por commitar (`README.md`, `MENSAGEM.md`,
   `EDICAO-NIGOR.md`, `CONTRATO.md`, `DISTRIBUICAO-ATUALIZACOES.md`,
   `distribution-channels.md`, `VALIDACAO-EDICOES-V2.md`): rever e commitar
   em conjunto com esta entrega.
