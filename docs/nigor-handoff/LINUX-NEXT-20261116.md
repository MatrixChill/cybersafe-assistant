# Linux Next — correções e evidências de 16/11/2026

Branch `codex/nigor-arch-20261113`, PR #5. Edição experimental; Windows, PAP e
instalações pessoais preservados. As fontes do pacote ficam identificadas pelo
`SOURCE-IDENTITY` e pelos checksums anexos à candidata. Não é proteção integral.

## Problemas reproduzidos e corrigidos

- **ClamAV por ficheiro:** cada `clamscan` recarregava as bases. Um benigno de
  26 bytes demorou 5,51 s e atingiu cerca de 970 MiB RSS no laboratório.
- **Backend persistente opt-in:** INSTREAM pelo socket Unix privado do `clamd`;
  não cria TCP, daemon root ou novo endpoint. Reutiliza a vaga global única e
  prioridades manual/saúde/tempo real/processos, com progresso de background.
  Compara diretório e versão diária efetivamente carregada; recusa base
  divergente/antiga. Falha confirmada permite fallback explícito para clamscan,
  com recuo de 30 s. Timeout não prova fim: conserva vaga/lease até resposta
  terminal; sem prova, degrada e exige recuperação, em vez de sobrepor motores.
- **EXDEV:** quarentena entre volumes deixou de depender apenas de rename.
  Copia para staging privado, sincroniza, verifica SHA-256/identidade e publica
  sem sobrescrita antes de retirar a origem. Metadados de recuperação são
  persistidos primeiro. Uma origem trocada não é eliminada como se fosse a
  analisada. Diretório 0700 e ficheiro isolado 000 são verificados no Linux.
- **Restauro:** staging no volume de destino; hard link exclusivo quando
  suportado. Sem hard links, cópia exclusiva verificada e sincronizada, sem
  promessa de atomicidade. Uma interrupção preserva a quarentena; pode existir
  cópia parcial no destino, que não é apagada nem substituída automaticamente.
- **Maiúsculas/minúsculas:** dois caminhos POSIX distintos eram fundidos na
  recuperação e na atribuição de resultados ClamAV. Testes reproduziram ambos
  os defeitos; Windows mantém a comparação histórica.
- **Processos:** polling Linux usava CIM, embora a lista da interface já usasse
  `/proc`. O monitor reutiliza agora o mesmo fornecedor POSIX e o diff existente.
  É observação por polling: processos breves podem escapar; não é prevenção.
- **Persistência de utilizador:** raízes Linux de autostart/systemd substituem
  caminhos Windows; diretórios explicitamente escolhidos dentro de `.config`
  deixaram de ser descartados pelo filtro global de ocultos. Não escreve unidades
  nem ativa autoruns; apenas observa ficheiros que estejam acessíveis.
- **Sessão lembrada:** ver [SESSAO-LEMBRAR.md](SESSAO-LEMBRAR.md). Secret Service
  selecionado para Nigor; `basic_text` nunca é tratado como cifra segura.

## Perfis ClamAV — ativação sempre explícita

Economia é o comportamento sem perfil: clamscan, sem RAM permanentemente
reservada por um daemon; custo de carga por invocação. Não reduz motores/cobertura.

Para preparar desempenho, com bases oficiais existentes e recursos suficientes:

```sh
node /opt/cybersafe-assistant-linux-lite/clamav-profile.mjs performance /var/lib/clamav
# Só depois de confirmar a memória disponível e terminar análises:
systemctl --user daemon-reload
systemctl --user start cybersafe-clamd.service
# Reabrir o CyberSafe, ou reiniciar cybersafe-linux.service se estiver a usá-lo.
```

O comando prepara ficheiros privados; não inicia/ativa serviços. A unidade
opcional tem um worker, CPUQuota=100%, MemoryHigh=1400M, MemoryMax=1800M,
NoNewPrivileges e socket 0600. Não tem secção Install. O próprio clamd pode
demorar segundos a carregar a base; o serviço do CyberSafe mantém também a
prova de carga existente. Durante essa prova a RAM de ambos pode somar cerca
de 2 GiB: o perfil não deve ser ativado num computador sem margem suficiente.
O limite de memória pode terminar o daemon; nesse caso há degradação/fallback,
nunca promessa de que a base ficou carregada.

Para regressar a economia, sem análise em curso:

```sh
node /opt/cybersafe-assistant-linux-lite/clamav-profile.mjs economy
# Reabrir a app/reiniciar o serviço CyberSafe primeiro; parar depois o daemon:
systemctl --user stop cybersafe-clamd.service
```

Se as definições usadas pelo CyberSafe estiverem noutro diretório, o perfil e
o daemon devem apontar para essa mesma base. Não reutilizar uma base antiga no
daemon só porque o processo está em execução. As atualizações/reload de bases
continuam sob responsabilidade da configuração ClamAV oficial do sistema.

## Benchmark real, corpus sintético pequeno

Arch/WSL2, ClamAV 1.5.4 e 3 628 269 assinaturas oficiais, um worker. Não é o
hardware/corpus dos 317 ficheiros do Nigor: não há comparação direta legítima.
O teste de backend exclui carregamento inicial/health, watcher, YARA e Native.

| Corpus benigno | clamd quente, total | P95 desde admissão da rajada |
|---|---:|---:|
| 1 | 10,77 ms | 10,76 ms |
| 10 | 61,85 ms | 61,85 ms |
| 100 | 588,05 ms | 559,94 ms |
| 317 | 1844,77 ms | 1758,35 ms |

Zero falhas/deteções no corpus benigno deste microbenchmark. Referência fria
de um benigno: 5677,12 ms, pico RSS 993 540 KiB. Não executámos 317 arranques
frios consecutivos nem inferimos esse resultado por multiplicação. Clamd após
os ensaios: MemoryPeak=1 142 861 824 bytes; CPUUsageNSec=9 051 160 000, acumulado
do daemon incluindo arranque e os dois ensaios, não consumo total do CyberSafe.
Não foi demonstrada uma redução de RAM: o custo principal passa a ser residente.

No percurso **watcher real → fila → motores → veredicto → histórico**, sem GUI:
317 benignos + um EICAR chegaram a 318 veredictos; mediana 5,37 s e P95 7,60 s.
EICAR observado aos 3000,64 ms, detetado aos 5743,83 ms, quarentena confirmada
aos 5761,60 ms. Inclui a janela conservadora de estabilidade de escrita de três
segundos. A deteção e o isolamento persistiram no histórico. Um evento posterior
de ficheiro inacessível após isolamento não apaga a deteção anterior.

EICAR simples, ZIP e ZIP aninhado foram detetados pelo daemon real e isolados
no teste direto de motores/quarentena. **Isto não altera a política automática:**
`automatic-high-confidence` continua a exigir hash exato conhecido. Uma deteção
apenas por ClamAV, incluindo um ZIP, pode exigir quarentena manual. `warn`/`ask`
não autorizam isolamento automático. A UI nunca deve confundir isso com sucesso.

## Prevenção: prova isolada, não componente ativado do produto

O probe fanotify sem marcas confirmou EPERM sem privilégios e capacidade de
criar grupo de permissões como root no laboratório. Num ensaio temporizado de
`clamonacc`, limitado a **uma pasta descartável**, ler o benigno terminou com 0;
ler EICAR terminou com 1/«Operation not permitted», com assinatura confirmada.
Daemon sem root, scanner excluído, timeout de cat e watchdog de 20 s; processos
encerrados no fim. Não foi monitorizada a raiz nem alterado o host Windows.

O pacote continua em **deteção após gravação**. Esta prova não é implantação
segura de prevenção no Nigor: integração privilegiada mínima, crash/deadlock,
políticas de exclusão e recuperação em sessão real continuam pendentes.
Não ativar OnAccessPrevention em sistemas reais sem aprovação específica.

## Diretórios e volumes

É possível adicionar até 16 diretórios em `monitoring.json` dentro do diretório
de dados do serviço, com propriedade do utilizador e modo 0600:

```json
{"directories":["/media/utilizador/volume-escolhido"]}
```

Aplica-se na ativação seguinte da proteção. Mantém raízes predefinidas; recusa
raiz `/`, caminhos virtuais/sistema, symlinks, ficheiros e diretórios inacessíveis.
Configuração inválida gera cobertura degradada explícita. A descoberta existente
de montagens/USB não é autorização para vigiar todo o conteúdo; não existe
reattach automático novo de um volume remontado. USB/exFAT físico por validar.

## Integração e limites ainda abertos

- JSON v1 foi alargado sem retirar campos; ver [CONTRATO.md](CONTRATO.md).
  C++ acompanha IDs de análises/eventos, fila/raízes e prevenção não confirmada.
- Serviço systemd de utilizador existente e IPC autenticado preservados.
  Não é serviço anterior ao login nem proteção para todas as contas; não foi
  ativado automaticamente. O ensaio de watcher sem GUI não substitui logout/
  reinício e recuperação da sessão gráfica Nigor.
- YARA mantém corpus e licenças existentes; cobertura Linux ampla e falsos
  positivos representativos não demonstrados. Não foram adicionadas heurísticas
  experimentais como se fossem assinaturas maliciosas de produção.
- Redescoberta: ClamAV tem TTL/reprobe e cooldown do novo backend. O ciclo
  geral de instalação a quente de todos os motores ainda precisa de conclusão;
  não prometemos já que qualquer dependência aparece sem recarregar o serviço.
- Alertas Nigor continuam limitados à sessão do serviço; deteções/quarentena
  têm registo persistente próprio. Sem novo endpoint de rede ou telemetria.
- Wayland, tray/notificações, USB físico, login lembrado e prevenção no Nigor
  real continuam a exigir aceitação nativa. O responsável Nigor não tem de
  desenvolver motores: esses pontos são validação/integração da distribuição.

## Regressões

- Windows: desktop 704 PASS/0 FAIL/3 SKIP; aplicação 3078 PASS/0 FAIL.
- Linux: grupo dirigido 47 PASS e grupo de identidade/frescura clamd 13 PASS
  (sobrepostos, não somar); quarentena atualizada 27 PASS; C++ CTest 1/1.
- Core amplo: 1242 PASS/18 FAIL/27 SKIP/1 TODO (1288 casos). As mesmas 18 falhas
  foram reproduzidas nas fontes anteriores `ea0acba`, num grupo de 128 casos.
- Serviço amplo: 903 PASS/121 FAIL/1 SKIP (1025). Os nomes das falhas foram
  reproduzidos no commit anterior, no grupo de 243 casos (121 PASS/121 FAIL/1
  SKIP). Fixtures Windows, descoberta do host e reconciliação de progresso
  continuam por triar; não declarar suíte Linux completa aprovada.

Registos brutos privados permanecem em `output/linux-next/` no ambiente de
desenvolvimento; apenas resultados sanitizados entram na documentação pública.
As execuções CI do commit empacotado são um gate separado da aceitação Nigor.

## Reproduzir em laboratório

```sh
node scripts/linux-lite/benchmark-protection.mjs --disposable-lab --socket=/caminho/privado/clamd.sock --eicar
node scripts/linux-lite/verify-realtime-lab.mjs --disposable-lab --socket=/caminho/privado/clamd.sock --count=317 --eicar
```

Só Linux sem root; criam corpus próprio, não usam EICAR existentes nem malware
real. O segundo comando retém histórico sintético privado para inspeção e não
depende da interface Electron. Não usar estes comandos para monitorizar pastas
pessoais, desativar proteções ou reivindicar cobertura global.

Fontes: [ClamAV Scanning](https://docs.clamav.net/manual/Usage/Scanning.html),
[protocolo clamd](https://docs.clamav.net/manual/Usage/ClamdProtocol.html),
[On-Access](https://docs.clamav.net/manual/OnAccess.html),
[fanotify_init](https://man7.org/linux/man-pages/man2/fanotify_init.2.html).
