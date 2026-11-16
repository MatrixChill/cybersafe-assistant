# O que falta programar no Nigor OS

Motores, serviço, API, scanner, atualizador, diagnóstico e adaptador já estão
no CyberSafe. Do lado do Nigor ficam só estes passos:

1. **Ligar o adaptador ao painel existente da barra**
   - Incluir `integrations/nigor/include` no build da `nigor-bar`.
   - Substituir a leitura atual do JSON por `cybersafe::AsyncPoller` + `latest()`.
   - Mostrar: estado geral, serviço, monitorização, os quatro motores
     (`engineText`), última análise (`scanText`), alertas, CPU/RAM.
   - Botões: Atualizar (`refreshNow`), Abrir CyberSafe (`openApp`), Abrir Security Center.
2. **Registar o Security Center na barra**
   - Compilar `reference/security_center.cpp` (ou copiar as vistas para o código Nigor).
   - O botão do painel lança `cybersafe-security-center` como processo separado.
3. **Adaptar aparência**
   - Implementar `nigorTheme()` com as cores e fontes de `src/ui/appearance.h`.
4. **Menu e Definições**
   - Entrada de menu para o Security Center (ícone `cybersafe-assistant-linux-lite`).
   - Em Definições do Nigor, um atalho «Segurança» que abre o Security Center.
5. **Testar na sessão gráfica real**
   - Painel abre/fecha; Security Center abre pela barra; estados batem com
     `cybersafe-nigor-status`; serviço parado mostra «indisponível»; a barra não
     congela com o serviço parado (o timeout é 8 s numa thread separada);
     análise de um ficheiro benigno aparece no histórico; o Nigor arranca normalmente.

Se algo do CyberSafe não se comportar como em `CONTRATO.md`, avisa-nos: a
correção é feita do nosso lado.
