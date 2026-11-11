# Instalação no Windows

A versão pública atual é a [Latest no GitHub](https://github.com/MatrixChill/cybersafe-assistant/releases/latest). Use apenas os assets dessa release: Setup, SHA256SUMS.txt e update-manifest.json. Windows 10/11 x64.

1. Descarregue o Setup e os checksums da mesma versão.
2. Execute `Get-FileHash -Algorithm SHA256 -LiteralPath "<setup>.exe"` e compare o resultado.
3. Ao atualizar, encerre a aplicação normalmente e preserve um backup do perfil, histórico, bases SQLite e quarentena. Não restaure ficheiros isolados apenas para testar.
4. Execute o instalador oficial e confirme a versão e os motores após abrir.

Não há Authenticode: o Windows pode mostrar editor desconhecido. Uma assinatura Ed25519 de manifesto não substitui a assinatura Windows do executável. Se uma política bloquear a execução, conserve o aviso; não desative proteções. [Como funciona o updater](updates.md).

[Voltar à documentação](README.md)
