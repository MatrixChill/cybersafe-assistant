Olá! Já desenvolvemos uma edição Linux experimental do CyberSafe Assistant,
com pacote Arch, serviço de utilizador, comunicação autenticada e painel rápido.
Queremos integrá-la no Nigor OS, mas primeiro precisamos de confirmar como
funciona na tua distribuição. Os módulos internos ficam do nosso lado.

O pacote autorizado, quando a pré-release estiver publicada, está aqui:
https://github.com/MatrixChill/cybersafe-assistant/releases/tag/linux-v0.2.4-arch-preview.1

As instruções e o modelo de resultados estão em
`docs/linux-lite/GUIA-NIGOR-OS-PRIMEIRO-TESTE.md` na mesma tag. Se a página ainda
não existir ou o hash não coincidir, não uses outro ficheiro em substituição:
avisa-me para confirmar a entrega.

Começa numa instalação descartável ou perfil de ensaio, com ficheiros benignos,
sem correr a aplicação como root ou desligar proteções. Já testámos em
Arch/WSL2 com X11 virtual; isso ainda não prova compatibilidade com o Nigor real.

Precisamos da versão do Nigor, kernel, arquitetura/hardware, shell e X11/Wayland,
além do resultado da instalação, abertura, Scanner, histórico, serviço e painel.
Envia os erros e logs relevantes depois de retirar dados privados. A integração
visual definitiva na barra e nas Definições fica para depois desses testes.
