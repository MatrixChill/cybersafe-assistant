# CyberSafe Assistant

O CyberSafe Assistant é um antivírus focado em análises avançadas em segundo plano.

## Como Executar

Este projeto é um monorepo (utilizando npm workspaces). Para executar o antivírus, siga os passos abaixo:

1. Instale todas as dependências do projeto na raiz:
```bash
npm install
```

2. Execute o projeto em modo de desenvolvimento. Isso iniciará os serviços, a interface desktop e outros componentes ao mesmo tempo:
```bash
npm run dev
```

Você também pode iniciar partes específicas do projeto, se necessário:
- `npm run dev:service` - Inicia apenas o serviço de plano de fundo do Windows
- `npm run dev:desktop` - Inicia apenas a interface Electron do antivírus
- `npm run dev:app` - Inicia a aplicação frontend (se houver)
- `npm run dev:api` - Inicia a API

## Configurações e APIs

As suas APIs já estão integradas no código fonte. Lembre-se de manter este repositório **PRIVADO**, pois expor chaves de API (como a do VirusTotal ou outras) em repositórios públicos compromete a segurança de suas contas.

> **Nota:** Em aplicações profissionais, é altamente recomendado o uso de um arquivo `.env` (adicionado ao `.gitignore`) para gerenciar as chaves, em vez de deixá-las diretamente no código.
