# Distribuição Linux — decisão e provas

Em 13/11/2026 o titular aprovou expressamente MIT para o código original do
CyberSafe, com `Copyright (c) 2026 Caio Amorim`, e confirmou os direitos/permissões
necessários sobre contribuições e assets próprios. O texto aprovado está em
`LICENSE`. Não se atribuem ao CyberSafe direitos de terceiros nem se alteram
as licenças desses componentes. A aprovação não é uma certificação jurídica
independente de titularidade.

| Parte distribuída | Tratamento |
|---|---|
| Código original, API, serviço, shell e scanner C++ | MIT aprovada pelo titular; metadados alinhados e texto incluído |
| Runtime npm efetivamente presente no ASAR | Inventário por nome/versão/licença e SHA-256 dos avisos lidos do payload, não de uma lista histórica Windows |
| Koffi e binário Linux da mesma versão | MIT; o binário usa o aviso do pacote Koffi apenas se a versão e a licença coincidirem |
| Renderer JavaScript | Relatório Vite dos módulos realmente incorporados; MIT, ISC e Apache-2.0 nas fontes revistas |
| Tailwind CSS e tw-animate-css incorporados no CSS | Textos MIT conservados separadamente; não se presume que o relatório JS os cobre |
| Electron 33.4.11 e Node/Chromium/FFmpeg incorporados | `LICENSE.electron.txt` e `LICENSES.chromium.html` completos, incluindo avisos de Node.js, OpenSSL e LGPL; não relicenciados como MIT do CyberSafe |
| ClamAV, YARA, Zenity, Node.js do sistema e bibliotecas Arch | Dependências externas geridas pelo pacman; os respetivos executáveis/bases não são copiados para o pacote CyberSafe |
| Monocypher e binários YARA/ClamAV Windows | Não incorporados no alvo Linux; não se apresentam os avisos históricos Windows como inventário deste payload |
| Fontes e marcas | A interface usa fontes do sistema; marca/assets CyberSafe sob a confirmação do titular. Não se concede uma marca de terceiros |

O coletor recusa metadados/licenças de runtime não revistos e avisos ausentes.
As expressões duplas encontradas oferecem MIT, que é a opção utilizada nesta
distribuição; os textos originais são preservados. Os avisos Apache/BSD/ISC
não são substituídos pelo texto MIT do projeto. O inventário e os textos ficam
em `/usr/share/licenses/cybersafe-assistant-linux-lite/`.

Não foi identificado um componente do payload revisto cuja licença exija retirar
o binário desta prévia. Isto é uma decisão de distribuição sobre o conteúdo
verificado, não uma garantia sobre dependências futuras. A ausência de licença
global e a falta dos avisos do renderer, que retinham a entrega anterior, foram
tratadas por aprovação do titular e inclusão dos textos efetivos.

Fontes oficiais: [MIT/OSI](https://opensource.org/license/mit),
[licença Electron na tag utilizada](https://github.com/electron/electron/blob/v33.4.11/LICENSE),
[inventário de licenças do Vite](https://vite.dev/config/build-options#build-license).
Os textos npm são os ficheiros dos módulos resolvidos pelo lockfile e os textos
Chromium/Node são os que acompanham o arquivo oficial do Electron utilizado.

Segurança é um eixo separado: Electron 33 é uma linha antiga, fora da política
das três versões estáveis mais recentes do [upstream](https://www.electronjs.org/docs/latest/tutorial/electron-timelines).
A prévia destina-se a ambiente descartável e dados sintéticos, com sandbox e
autenticação mantidos. Não é uma edição recomendada para produção nem uma
promessa de deteção integral. Atualizar o runtime é requisito de uma futura
edição suportada, não uma alteração silenciosa aos binários Windows publicados.
