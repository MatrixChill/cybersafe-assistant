# Atualizações e distribuição

O feed Windows aponta para `https://github.com/MatrixChill/cybersafe-assistant/releases/latest/download/update-manifest.json`.

O cliente valida canal, versão, compatibilidade e assinatura Ed25519 com chave pública pinada. O manifesto vincula URL, tamanho e SHA-256 ao instalador. A chave privada nunca pertence ao código ou aos assets públicos.

A instalação assistida permanece desativada enquanto faltar Authenticode legítimo. Descobrir e verificar uma atualização não prova que foi instalada. A transferência/instalação manual é o percurso público declarado.

## Gates de uma nova release

Fontes e testes → inventário exato → aprovação de freeze → preflight → packaging → verificação do payload e hashes → manifesto assinado → publicação → download público e verificação.

Não reutilizar aprovação para outra árvore, gerar chaves alternativas para ultrapassar um gate, mover tags publicadas ou substituir um Setup histórico. Alterações de documentação na main não recompilam os artefactos das tags.

[Runbook de assinatura](RELEASE-SIGNING-RUNBOOK.md) · [configuração do cliente](../packages/desktop/src/updater/release-trust.json) · [releases públicas](https://github.com/MatrixChill/cybersafe-assistant/releases).

[Voltar à documentação](README.md)
