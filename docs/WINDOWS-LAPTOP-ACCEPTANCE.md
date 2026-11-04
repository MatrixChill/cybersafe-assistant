# Validação do Setup no portátil

A RC4 aplica o DPI ao tamanho da janela e novamente ao layout calculado em píxeis. A correção limita a janela à área útil, aplica uma escala única aos controlos e tenta ativar a janela pelas APIs normais do Windows. Quando o Windows recusa a ativação, sinaliza a janela na barra de tarefas. O timer deixa de repintar a animação em segundo plano e reduz a cadência após pinturas demoradas. Não há medição de FPS no portátil.

Testar o próximo Setup em 1366×768, 1600×900 e 1920×1080, a 100%, 125%, 150% e, se disponível, 175%. Abrir pelo Explorador, avançar pelas etapas, navegar por teclado e testar maximizar/restaurar. Guardar captura das opções e do destino a 150%. Confirmar controlos visíveis, resposta aos cliques e fluidez. Validação física pendente.

No portátil, com o CyberSafe aberto, executar em PowerShell a partir da pasta onde está o script:

    powershell -NoProfile -File .\diagnose-cybersafe-laptop.ps1

Enviar o JSON produzido. Se o primeiro arranque falhar novamente, recolher um JSON antes de clicar em reconectar e outro depois. O script lê estado de hardware, processos, serviços, API e presença do binário ClamAV. Não lê credenciais ou logs brutos nem confirma carregamento de assinaturas. Anotar separadamente a mensagem exata do ClamAV e o horário. Falha inicial de ligação e degradação persistente no portátil continuam sem causa comprovada.
