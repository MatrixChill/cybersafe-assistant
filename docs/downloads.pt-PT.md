# Downloads

[English](downloads.md) · [Documentação](README.md)

Assets públicos confirmados em **16/11/2026**. Escolha a edição antes de descarregar. Cada release fornece os seus checksums e notas.

| Edição | Release e instalável exato | Estado / guia |
|---|---|---|
| Windows | [v0.2.4](https://github.com/MatrixChill/cybersafe-assistant/releases/tag/v0.2.4), `CyberSafe-Assistant-Setup-0.2.4.exe` | Distribuição estável, editor Windows sem assinatura. [Instalar](installation.pt-PT.md). |
| Arch Linux | [Preview 3](https://github.com/MatrixChill/cybersafe-assistant/releases/tag/linux-v0.2.4-arch-preview.3), `cybersafe-assistant-linux-lite-0.2.4-3-x86_64.pkg.tar.zst` | Experimental, entrada na interface com conta. [Instalar](linux/README.pt-PT.md). |
| Nigor OS Edition | [Preview 1](https://github.com/MatrixChill/cybersafe-assistant/releases/tag/nigor-v0.2.4-preview.1), `cybersafe-assistant-nigor-0.2.4-2-x86_64.pkg.tar.zst` | Experimental, painel local e conta opcional. [Instalar / migrar](nigor-os/README.pt-PT.md). |

## Integridade

| Asset | Bytes | SHA-256 |
|---|---:|---|
| Setup Windows v0.2.4 | 279442395 | `6a3e9d730ef989c84ac7de701d98b46b7f5e65b9110d5e96032efdb0c880ea2c` |
| Pacote Arch Preview 3 | 112065428 | `54bd4c2914c516cbf969d92db36eebd97d3e531ae9b2a81d65dbb18b65da2a3c` |
| Pacote Nigor Preview 1 | 112189154 | `8a72c418448a9f2c0cb16da8ea26583ef7c76cd2b315696e2e1c40b1203e025d` |

Compare com `SHA256SUMS.txt` da mesma release. O checksum confirma os bytes face ao valor publicado. Não certifica cobertura de malware ou confiança do editor Windows. Os arquivos de fontes gerados pelo GitHub e as fontes de integração têm funções distintas dos pacotes instaláveis.

## Canais de atualização

| Rota | Consumidores e função atual |
|---|---|
| Windows `releases/latest` | Stable Windows continua na v0.2.4. Instalação manual enquanto faltam Authenticode legítimo e aceitação da atualização instalada. |
| `linux-update-channel` | Feed Arch legado conservado na Preview 2. Os clientes com o percurso antigo de instalação precisam de migração manual. |
| `linux-update-channel-v2` | Rota reservada a clientes Arch genéricos compatíveis. Sem release pública nesta revisão. A Preview 3 segue o guia público de instalação manual. |
| [`nigor-update-channel-v2`](https://github.com/MatrixChill/cybersafe-assistant/releases/tag/nigor-update-channel-v2) | Manifesto experimental v2 assinado exclusivo do Nigor. A Preview 1 é o pacote de entrada. A existência do feed não promete uma versão posterior compatível. |
| `channel-preview` | Feed histórico Windows Preview, separado dos contratos Linux e Nigor. |

Os canais contêm manifestos e assinaturas. Para instalar a aplicação, use a release da edição. Stable e Experimental têm manifestos separados. São exigidos autenticidade Ed25519, hash, tamanho, edição, cliente mínimo, consentimento e autorização do sistema. Um teste do helper não demonstra todo o percurso gráfico de atualização instalada.

## Distribuições históricas

- Os RCs Windows e checkpoints anteriores continuam em [Releases](https://github.com/MatrixChill/cybersafe-assistant/releases).
- As experiências Debian/AppImage estão em [Linux Lite](linux-lite/README.md). Não comprovam suporte Linux universal nem aceitam pacotes Arch.
- Relatórios e capturas originais da PAP estão no [índice do arquivo](archive/README.md).
