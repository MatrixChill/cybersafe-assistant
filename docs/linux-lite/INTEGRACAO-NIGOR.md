# Integração experimental Arch / Nigor OS

O alvo Arch reutiliza o renderer, a API local e o serviço que o Electron já inicia na edição Linux Lite. Não introduz um daemon root, portas novas, Wine ou dependência do shell Nigor. A receita destina-se a ensaios internos; o âmbito da licença global continua por clarificar.

## Construir e ensaiar

Num Arch x86_64 descartável, com sessão gráfica normal, Git, Node/npm e base-devel, faça checkout da branch aprovada e execute como utilizador normal:

```bash
bash scripts/linux-lite/arch/prepare-recipe.sh "$HOME/cybersafe-arch-build"
cd "$HOME/cybersafe-arch-build"
makepkg --syncdeps
pacman -Qlp ./cybersafe-assistant-linux-lite-*.pkg.tar.zst
sha256sum ./*.pkg.tar.zst
```

A receita contém um SHA-256 do arquivo de fontes e grava o commit em SOURCE-IDENTITY. É uma receita local, não uma submissão AUR. Depois de verificar a lista, instale no ambiente de ensaio com pacman -U, nunca execute Electron como root e não use --no-sandbox. Se a política do sistema não permitir o sandbox, registe a falha. O pacote não ativa serviços, não altera firewalls, nem remove dados de utilizador. Antes de ensaiar upgrade ou remoção, feche a aplicação e guarde cópia fria do perfil. Use pacman para gerir os ficheiros instalados.

## Ligação ao Nigor

- Entrada do menu: cybersafe-assistant-linux-lite.desktop.
- Ícone: cybersafe-assistant-linux-lite, no tema hicolor (PNG oficial).
- Ação Abrir CyberSafe: lançar cybersafe-assistant-linux-lite na sessão do utilizador, sem argumentos privados.
- Diagnóstico: cybersafe-linux-diagnose emite JSON schemaVersion 1 com sessão e presença de comandos. launchable apenas descreve pré-requisitos básicos; não confirma arranque. health permanece unknown porque isto não interroga o serviço.
- Não ligar o shell do Nigor ao RPC interno: o contrato externo autenticado e o painel de proteção ainda são trabalho do CyberSafe.

## Evidência e estado

| Área | Estado desta entrega |
|---|---|
| Receita, checksum de fontes e preparação Electron | Implementado; sintaxe/arquivo e build de diretório validados em Ubuntu WSL2, não em Arch |
| Pacote .pkg.tar.zst, instalação, sandbox e renderer em X11/Wayland | Não validados: makepkg e sessão Arch indisponíveis |
| Scanner, ClamAV/YARA, HashDB, processos, volumes, quarentena, MATRIX | Percursos Linux Lite reutilizados; consultar evidências históricas nesta pasta. Sem novo ensaio instalado; C++ nativo/ELF não comprovado |
| Monitorização | Parcial; observação não prova deteção ou prevenção. Sem novo bloqueio preventivo |
| Firewall Linux, serviço systemd persistente, API externa e painel rápido | Pendentes; nenhum estado de proteção simulado |

No Ubuntu 26.04/WSL2, com Node 22.23.4 e fontes de a75fc29, passaram npm ci, npm run build:all, o gate SQLite/Electron ABI 130 e o alvo --arch-stage. Os guardas verificaram o renderer 0.2.4, entrada da API, executável ELF e app.asar. Isso não prova arranque gráfico ou funcionamento dos motores. Em Windows/Node 24.13.0 passaram 15 testes dirigidos de packaging, diagnóstico e bindings Linux/Windows.

O próximo ensaio precisa de Arch x86_64 descartável com X11 ou Wayland: instalar, abrir sem elevar, conferir renderer/login/SQLite, analisar uma pasta de texto benigno, confirmar histórico e estado dos motores, testar quarentena/restauro com fixtures, observar criação de ficheiros, fechar e verificar processos. Só depois rever integração e distribuição Nigor.
