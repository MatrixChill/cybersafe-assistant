# v0.2.2 — continuação Codex, 06/11/2026

Base recebida: 1aa4994, worktree limpa em fix/v021-realtime-coverage. Preservados os 35 commits exclusivos da linha v0.2.2 e o commit de manifesto exclusivo de origin/main através de merge normal. A v0.2.1 pública não foi alterada. A candidata antiga 1aa4994 mantém SHA-256 3d86e7cd99d2c2c81c3ba2b18c36d4586ced626badb4874288a66da69faba6f2, mas não contém as correções abaixo e não será publicada como se as contivesse.

## Correções

- Cartões distinguem ausência de uma métrica de cobertura de ausência de leitura do serviço. Não inferem cobertura normal do estado Ativo. Teste RED no texto antigo e GREEN depois.
- Callbacks sem nome abrem pendências por pasta. Após 3 segundos de quietude, uma reconciliação serializada tenta enumerar e analisar um snapshot pequeno. Só fecha a pendência se todos os ficheiros tiverem veredicto conclusivo e uma segunda enumeração comprovar a mesma lista e identidades. Não recupera por passar tempo ou por mera admissão na fila.
- Limites conservadores: 32 ficheiros, 16 MiB, 256 entradas, profundidade 8, verificações de orçamento de enumeração de 2 s; até 32 pastas agendadas, uma reconciliação ativa. Exceder limites, exclusões, ligações, falhas, alterações ou resultados inconclusivos deixa a lacuna explícita. Pastas grandes podem continuar a exigir análise manual. Os pedidos usam o arbiter real, sinal de cancelamento e readOnly=true; não restauram nem colocam ficheiros em quarentena.
- Contadores históricos permanecem. O snapshot reconciliado não certifica a entrega de eventos históricos nem a análise de ficheiros já desaparecidos. Novos sinais e parar a proteção invalidam confirmações em voo. Raízes desaparecidas/inacessíveis conservam a pendência.
- Teste de identidade de packaging deixa de presumir que um resultado diferente de NotSigned é uma assinatura válida. Falha do módulo Authenticode resulta em gate fechado, nunca em PASS inventado.

## Verificações desta execução

App 3050 PASS; desktop 694 PASS; nativo 25 PASS; scripts 484 PASS. Core na repetição: 1225 PASS, 29 skip, 1 TODO, zero falhas. Na primeira corrida paralela, uma leitura real de discos falhou sob carga; passou isoladamente e na repetição integral sem alterar a medição.
Serviço habitual: 1022 PASS, 1 skip, zero falhas; complemento eventos/inventário 12 PASS. Reconciliação/fila/cobertura dirigida: 39 PASS, mais testes adicionais de invalidar confirmação e temporizador sem sucesso. A suíte completa é registada no ficheiro output/codex-v022-service-full.log; não reutilizar os números reportados pelo Claude como nova prova.
Build de shared-types, core, serviço e app aprovado. Nenhum ensaio de instalação nem novo EICAR nesta execução. O EICAR instalado da candidata anterior foi confirmado pelo proprietário, não é evidência instalada deste novo código.

## Distribuição

Registo externo legítimo de aprovadores localizado. Seed e bundle oficiais passaram a verificação com configuração de processo, sem alterar o Windows. Chave Ed25519 existente verificada pelo procedimento --check-key: fingerprint aprovado 3982C36398918D077A417DDA02E6E7FF6C1F70622684DA4FB43673652E4C8FB6. A chave privada não foi copiada nem mostrada.
A instalação assistida continua false. Após novo freeze aprovado: compilar candidata pelo pipeline oficial, verificar payload, gerar manifesto a partir do Setup final, assinar offline com a chave aprovada, verificar assinatura e só então publicar v0.2.2 e confirmar download por hash. A aprovação do freeze 1aa4994 não se aplica ao código novo.

## Novo computador

Após publicação verificada, procurar atualizações na v0.2.1, confirmar versão 0.2.2, descarregar do GitHub oficial e comparar SHA-256 com SHA256SUMS.txt. Encerrar normalmente, preservar backup dos dados e executar o Setup de atualização manual. Sem Authenticode, o Windows pode mostrar editor desconhecido; não desativar proteções. Se a política bloquear a execução, guardar a mensagem. Confirmar versão e motores após abrir. Não se declara atualização automática instalada.

Suite completa do serviço concluída nesta revisão funcional: 1438 testes, 1421 aprovados, 17 ignorados, zero falhas (278,1 s). Os caminhos de logs acima são locais; este documento não contém dados pessoais.
