# Windows Preview — preparação RC5

Arrancar a futura RC5 instalada com o argumento explícito --cybersafe-preview-updates para aderir ao canal nessa sessão. Stable e a RC4 publicada conservam a configuração anterior. Preview permite verificar e descarregar, com indicação de Setup sem Authenticode. O percurso manual apenas revela o ficheiro verificado. A instalação assistida Preview permanece fechada.

Feed reservado: https://github.com/MatrixChill/cybersafe-assistant/releases/download/channel-preview/update-manifest.json. Publicar primeiro o Setup definitivo e verificar publicamente tamanho e SHA-256. Só depois assinar offline e disponibilizar o manifesto no canal fixo. O cliente exige RC superior, commit completo, build mínimo do Windows, URL versionada do repositório, Ed25519 com pin aprovado e confirmação de integridade dos bytes. A publicação do feed ainda não foi executada.

Para concluir A→B, falta implementar e validar uma política de execução Preview também no launcher nativo, com verificação independente da assinatura e do hash, consentimento específico, instalação interativa e recuperação. Não reutilizar a exceção de download como autorização de execução. A aprovação do percurso assistido e a autorização específica para instalar no Windows pessoal são gates separados.

Referências: Lunmi documenta manifesto Ed25519 e verificação do pacote no launcher. MAESTRIX beta disponibiliza beta.yml, assinatura separada, Setup e blockmap. Os assets não provam a lógica interna do updater MAESTRIX.
