# Próxima edição CyberSafe para Nigor OS

O código permite abrir o painel local sem conta quando o processo principal
confirma a identidade da edição Nigor. O botão «Iniciar sessão» mantém a
entrada e criação de conta disponíveis, incluindo «Lembrar-me». Logout regressa
ao painel local. As rotas privadas da API mantêm a autenticação de conta.
As operações locais continuam a usar a ponte Electron, o socket autenticado
e as autorizações e confirmações próprias de cada operação.

Para o futuro pacote Arch, usar o nome `cybersafe-assistant-nigor` e instalar
o recurso `/opt/cybersafe-assistant-nigor/resources/edition.json`, pertencente
a root, com permissões `0644` e diretórios sem escrita por outros utilizadores.
A receita futura usará o [marcador versionado](../../integrations/nigor/packaging/edition.json).

O marcador aplica-se apenas ao executável Linux empacotado nessa localização.
Instalação genérica, Windows, desenvolvimento e marcador ausente ou inválido
usam o fluxo de conta atual. A aplicação Nigor recusa o encaminhamento ao
atualizador Arch genérico. As preferências de `XDG_CURRENT_DESKTOP` continuam
a servir para escolher Secret Service e são independentes desta identidade.

Antes de emitir uma candidata própria, preparar a receita Nigor, a proveniência
e o inventário, definir como migrar perfil, SQLite, quarentena e credencial do
socket com consentimento, e evitar que os dois pacotes concorram pelo mesmo
socket ou serviços. O nome e a rota de atualizações de `nigor-vX.Y.Z-preview.N`
devem ser validados no cliente e no helper usando um manifesto assinado da
edição Nigor. Testar o pacote em sessão gráfica local antes de o disponibilizar.
Até lá a [Preview 3 partilhada](PREVIEW-3.md) usa a entrada por conta.
