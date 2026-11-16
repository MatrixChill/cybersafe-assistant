# Distribuições e canais oficiais

Repositório único: [MatrixChill/cybersafe-assistant](https://github.com/MatrixChill/cybersafe-assistant).
Estado confirmado em 16/11/2026. O prefixo da tag identifica a distribuição;
o número da versão da aplicação não demonstra equivalência de capacidades.

| Distribuição | Tags | Formato e requisitos | Canal |
|---|---|---|---|
| Windows | `vX.Y.Z`, mantendo as versões históricas | Setup x64, Windows 10/11 | Updater Windows e respetivo contrato de confiança, sem alterações nesta branch. |
| Linux / Arch | `linux-vX.Y.Z-arch-preview.N`; futuro stable `linux-vX.Y.Z` | `.pkg.tar.zst`, Arch x86_64/glibc, pacman, Node e dependências declaradas no PKGBUILD | `linux-update-channel`, `manifest-experimental.json` / `manifest-stable.json`, assinaturas destacadas `.sig`. |
| Nigor OS atual | **Reutiliza a release e o binário Arch** | Mesmos requisitos; Secret Service/porta-chaves para «Lembrar-me»; componentes de integração incluídos | Mesmo canal Linux, identidade `arch-shared`. Não existe hoje um segundo pacote nem um canal Nigor funcionalmente distinto. |
| Nigor OS futuro, se necessário | `nigor-vX.Y.Z-preview.N`; futuro stable `nigor-vX.Y.Z` | Apenas após existir uma diferença real de pacote/compatibilidade e validação própria | Canal dedicado proposto `nigor-update-channel`, ainda **não provisionado**; requer contrato e chaves públicas incorporados no cliente dessa edição. |

## O que descarregar agora

- [Windows v0.2.4](https://github.com/MatrixChill/cybersafe-assistant/releases/tag/v0.2.4).
- [Linux/Arch e Nigor Preview 3](https://github.com/MatrixChill/cybersafe-assistant/releases/tag/linux-v0.2.4-arch-preview.3):
  `cybersafe-assistant-linux-lite-0.2.4-3-x86_64.pkg.tar.zst`,
  `SHA256SUMS.txt`, `THIRD-PARTY-NOTICES-LINUX.tar.gz`, `SOURCE-IDENTITY` e guias.
- Os antigos `.deb` e `.AppImage` pertencem ao percurso Linux Lite documentado
  em [Linux Lite](linux-lite/README.md). Não são pacotes Arch e não são alvos
  do atualizador pacman. Não há promessa de atualização automática para todas
  as distribuições Linux. Uma futura distribuição não Arch exige um adaptador
  de instalação e ensaios próprios, reutilizando o verificador comum.

A Preview 3 é distribuída para [instalação manual](nigor-handoff/PREVIEW-3.md).
O canal público ainda aponta para a Preview 2. A próxima revisão do canal precisa
de separar os clientes que entregam ao pacman uma cópia protegida dos antigos.
A [edição Nigor com entrada local](nigor-handoff/EDICAO-NIGOR.md) está em preparação.

## Identidade e segurança

O pacote atual instala `update-channel.json` com `edition: arch-shared` e chave
pública Ed25519. O manifesto inclui pacote, edição, canal, arquitetura, versão,
pkgrel, URL, tamanho e SHA-256. Manifestos antigos deste mesmo canal sem `edition`
continuam compatíveis com a identidade partilhada; uma edição desconhecida é
recusada. O cliente não escolhe uma edição a partir do nome do desktop, da conta
ou de um manifesto remoto. Isso evita trocar o produto por uma versão Nigor
incompatível só porque a sessão mudou.

O novo verificador restringe os pacotes à rota oficial de releases Linux no
repositório acima, separa tags Stable/Preview e recusa tags Windows/Nigor distintas.
A assinatura Ed25519 é verificada antes de confiar nos metadados; download
retomável, tamanho e SHA-256 são verificados antes da instalação. Isto não
dispensa a política de assinaturas do pacman. Não se desativam verificações de
pacotes, não se instala uma chave privada no cliente e não se usa uma chave LAB.

Consulta, download e autorização de instalação **não exigem conta CyberSafe**.
Polkit/pacman podem exigir a autorização do sistema. O cliente local de proteção
usa uma credencial privada por utilizador, diferente de uma sessão de conta.

## Três responsabilidades distintas

1. **Aplicação:** `cybersafe-linux-update check`, `download` e instalação
   consentida do pacote CyberSafe. O mesmo comando é usado pelo Electron e
   pelo adaptador Nigor; não há outro updater no Security Center.
2. **Definições:** ClamAV/FreshClam, YARA e HashDB têm resultados e saúde
   separados. O novo serviço deteta `clamav-freshclam-once.timer` e serviços
   FreshClam conhecidos, delega o componente ClamAV ao sistema e não declara
   uma base atualizada só por ter encontrado o temporizador. Se a propriedade
   não puder ser determinada num sistema systemd, adia o escritor CyberSafe.
   A política de delegação não prova que dois caminhos de bases são iguais;
   a saúde do motor e a base realmente carregada continuam a ser verificadas.
3. **Sistema operativo:** kernels, drivers, bibliotecas e atualização global
   pertencem ao gestor do Arch/Nigor. CyberSafe não faz `pacman -Sy`, uma
   atualização parcial do sistema nem uma atualização global por iniciativa própria.

## Publicação seguinte — gates, não uma release já emitida

1. Consolidar o commit exato e CI; construir e instalar o pacote no laboratório
   Arch descartável; validar payload, dependências, licenças, arranque e dados.
2. Produzir `SOURCE-IDENTITY`, SHA256SUMS e avisos de terceiros; anotar limites
   reais e resultados. Um pacote Nigor diferente exige identidade e proveniência
   próprias; o mesmo pacote não deve ser carregado duas vezes só para mudar o nome.
3. Preparar a release Linux como **Draft / pré-release**, `make_latest=false`.
   Não promover a Preview experimental para Latest estável.
4. Após autorização de publicação, disponibilizar primeiro o pacote imutável,
   verificar o download HTTPS e o hash, e só depois publicar o manifesto
   Ed25519 correspondente no canal. Preservar cópias das versões anteriores.
5. O par manifesto/assinatura é atualizado com verificação pós-publicação.
   Durante uma troca não atómica entre os dois assets, uma combinação inválida
   deve falhar fechada e ser novamente consultada mais tarde, nunca aceite.
6. Confirmar que a release Windows Latest e o seu feed não foram alterados.
   Não publicar Stable Linux sem os respetivos ensaios e aprovação.

Não alterar canais instalados manualmente para forçar compatibilidade. Se uma
futura edição Nigor precisar de outro pacote, a migração tem de ser explícita,
consentida e testada; não é apenas uma alteração do URL.
