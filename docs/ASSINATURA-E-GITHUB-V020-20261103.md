# Desbloquear assinatura e atualizações GitHub — 3 novembro 2026

Estado confirmado pelo proprietário: não existe certificado de code signing, publisher nem Ed25519 de produção aprovados. Não foi gerada qualquer identidade ou chave para substituir essa decisão. `release-trust.json` continua enabled=false/assistedInstallationEnabled=false, chave e fingerprint vazios. Autenticação Windows e assinatura de manifesto são dois mecanismos diferentes e ambos continuam obrigatórios.

## Opção recomendada de baixo custo
Primeira tentativa: candidatura SignPath Foundation para software OSS, sem custo se aceite. O repositório é público e declara MIT; isso não equivale a elegibilidade completa. A fundação exige manutenção, documentação, licença OSS dos componentes e uma versão já disponibilizada. Malware detection é distinguida de ferramentas que procuram/exploram vulnerabilidades; as funcionalidades do CyberSafe têm de ser descritas honestamente ao avaliar essa condição. Inclui binários de terceiros: confirmar a composição e licenças com a fundação. O publisher do certificado é a SignPath Foundation, não um nome CyberSafe inventado. O valor exato que o verificador Windows recebe tem de ser medido de um artefacto legitimamente assinado e aprovado.
Fonte oficial: https://signpath.org/terms e https://signpath.org/ . Não foi submetida candidatura nem aceite contrato.

Plano alternativo: Certum Open Source Code Signing. A página institucional mostra preços desde 25 EUR para OSS; a opção cloud SimplySign consultada mostra desde 49 EUR e está sem stock. Estes valores são indicação, não orçamento final: confirmar disponibilidade, impostos, período, necessidade de hardware/token e condições do plano. A cloud exige aplicação móvel/desktop e validação de identidade; não é uma compra feita por este agente. Obter cotação antes de pagar. Fontes: https://www.certum.eu/en/code-signing-certificates/ e https://shop.certum.eu/open-source-code-signing-on-simplysign.html?___store=certum_en .

Azure Artifact Signing não é a primeira opção para uma pessoa individual em Portugal: a documentação consultada limita indivíduos a EUA/Canadá; organizações na UE podem ser elegíveis, por exemplo uma escola apenas se ela aceitar formalmente assumir a identidade/papel. Não fingir organização. Fonte: https://learn.microsoft.com/en-gb/azure/artifact-signing/quickstart .

Assinatura válida não garante ausência imediata de avisos SmartScreen; não contornar os avisos. Não há promessa de certificados públicos gratuitos e instantâneos para este caso.

## Exatamente o que o proprietário tem de obter
1. Aprovação de um fornecedor legítimo, certificado/serviço Authenticode válido e mecanismo de assinatura com timestamp. Não enviar privada/PFX/password pelo chat. O uso de HSM/serviço remoto depende do fornecedor; não instalar certificados LAB na confiança do Windows.
2. Um primeiro artefacto de ensaio legitimamente assinado. Confirmar Get-AuthenticodeSignature=Valid, tipo Authenticode e o SimpleName real. Aprovar esse publisher exato para o campo publisherLabel. SignPath não significa que o publisher seja automaticamente CyberSafe Assistant.
3. Criar sob controlo do proprietário um par Ed25519 separado, offline e fora de todos os repositórios/worktrees. Não foi gerado nesta ronda. Usar o procedimento existente em docs/RELEASE-SIGNING-RUNBOOK.md e scripts/release-key-setup.mjs. No Windows, restringir ACL do diretório ANTES de gerar e proteger backup cifrado; o modo POSIX 0600 não é uma garantia NTFS.
4. Calcular e aprovar SHA-256 do DER SPKI com release-key-setup --fingerprint/--verify. Apenas a pública SPKI PEM e fingerprint entram na configuração da aplicação; a privada permanece offline ou num secret protegido.
5. Criar no GitHub o environment release-signing, com revisão humana adequada e branches de assinatura limitadas. Foi consultado e ainda não existe. Provisionar RELEASE_ED25519_PRIVATE_KEY, RELEASE_ED25519_PUBLIC_KEY e variable RELEASE_ED25519_FINGERPRINT conforme o workflow existente. A alternativa de menor exposição é assinar o manifesto offline com os scripts existentes e não colocar a privada no CI.
6. Aprovar o ambiente isolado e o percurso de ensaio instalado entre duas versões. A autorização da instalação RC1 no PC pessoal não é autorização para fazer upgrades nele. Autorizar separadamente artefactos, snapshots/backup, reinício e uma distribuição de teste compatível.
7. Aprovar o HEAD/inventário finais e novo freeze. O freeze 497e634 não pode aprovar estes fontes novos.

## GitHub sem servidor próprio
Origem confirmada por git remote e GitHub API: https://github.com/MatrixChill/cybersafe-assistant , público, default main. Nenhuma Release existe na consulta de 3 novembro. O feed configurado é https://github.com/MatrixChill/cybersafe-assistant/releases/latest/download/update-manifest.json e atualmente não pode fornecer uma atualização publicada. Não foi criada Release/tag/draft nem alterado environment ou segredo.
O workflow CI foi preparado para branches codex/** e para a suíte completa da app além do desktop. É validação read-only, não publication/packaging. release-sign já é manual, contents:read, e exporta só o manifesto assinado; não assina Authenticode nem publica.

Ordem correta da cadeia:
- Construir e assinar binários/instalador conforme método legítimo, respeitando a ordem de packaging e a assinatura do desinstalador.
- Revalidar Authenticode/publisher e payload final. Só depois calcular hashes/tamanhos dos bytes assinados.
- Produzir manifesto com scripts/release-manifest.mjs e URL definitiva do artefacto daquela versão. Assinar com release-signing.mjs e verificar a assinatura embutida.
- Produzir/verificar SHA256SUMS. A assinatura do manifesto não é a assinatura do EXE.
- Colocar instalador, update-manifest.json e somas numa Release autorizada; metadados apontam a URL versionada, o cliente consulta latest/download. Não é necessário manter um servidor próprio.
- Validar feed, redirects/download, integridade, publisher, consentimento, handoff, reinício, SQLite e confirmação real da versão antes de ativar ambos os gates de produção.

## Ensaio LAB entre versões — bloqueadores reais
O cliente usa HTTPS GitHub sem credenciais de feed privado. Drafts/assets privados não se tornam acessíveis por magia a esse cliente. Não publicar uma Release pública só para simular esse ensaio, nem colocar tokens em URL/renderer. É necessária uma opção de distribuição de teste expressamente aprovada e compatível, ou autenticação privada desenhada/validada separadamente.
Usar duas versões SemVer estritamente crescentes e aprovadas, em árvores LAB separadas, com identidade visual LAB clara e dados descartáveis. O produtor atual rejeita prereleases no canal stable: não ignorar essa regra nem trocar apenas build metadata (não representa upgrade SemVer). As versões concretas e freezes têm de ser aprovados antes de produzir os dois instaladores. A cadeia LAB tem de ficar separada dos pinos de produção. Nenhum certificado LAB foi inventado nesta ronda.

Ensaios esperados: descoberta da segunda versão; bytes/assinaturas; consentimento exato; cancelamento antes de handoff; shutdown só dos processos próprios; NSIS autorizado; arranque; versão real e saúde API/SQLite; configurações e conta preservadas. Falhas a ensaiar: manifesto alterado, hash errado, publisher divergente, rede interrompida, consentimento retirado, NSIS não-zero e reinício sem confirmação. Saída zero do setup não significa atualização concluída. Recuperação manual segura, sem anunciar rollback automático inexistente.

## Decisão
NO-GO para Release com atualizações públicas enquanto estes gates estiverem pendentes. Continuar UI, CI, builds e testes é permitido; ativar confiança, fabricar aprovação, criar tag/main/Release pública não é.
