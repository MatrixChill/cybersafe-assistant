# Launcher Preview — contrato NSIS e recuperação

A RC5/RC7 consultava InstallLocation na chave de desinstalação. O NSIS grava esse valor na chave Software/APP_GUID; DisplayVersion pertence à chave de desinstalação. A fixture LAB incorretamente reunia ambos os valores numa única chave.

Correção: ler o destino na chave de instalação e a versão na chave de desinstalação, na mesma vista HKCU. Mantêm-se a comparação com o executável pai, utilizador, versão compilada, caminhos canónicos, locks, identidade do launcher, assinatura, hash, consentimento e lease do Scanner.

Evidência: fixture com chaves separadas falhou antes da correção (launcher-exit-10); passou depois, incluindo rejeição de destino ausente/adulterado, versão incorreta, assinatura, hash, downgrade, Windows incompatível, launcher adulterado, cancelamento e falha do instalador. Isto é LAB inerte, não atualização instalada.

## Recuperação da RC5

A instalação existente tem metadados NSIS legítimos. Não acrescentar metadados fictícios para satisfazer o launcher antigo. Não substituir o launcher instalado silenciosamente. Uma nova candidata com launcher corrigido é necessária para distribuição. A alternativa recomendada é uma instalação manual única dessa candidata, aprovada separadamente após freeze/hash, preservando backup e dados. Esta recuperação não contará como RC5→RC7 pelo updater. A prova instalada do updater requer depois uma versão posterior legitimamente assinada e autorizada; não é demonstrada por handoff LAB.

Rollback: antes da recuperação, encerrar normalmente, guardar snapshot frio completo da instalação e perfis (incluindo perfil legado), validar hashes/SQLite; preservar Setup anterior. Em falha, preservar novos logs/dados e apresentar restauração do executável e snapshot de dados compatíveis antes de executar qualquer rollback.

## SQLite

As 9 bases da cópia before-rc7-cold-20261104-211333 abrangem quatro bases Chromium do perfil atual e cinco ficheiros SQLite do serviço. As 13 da cópia anterior incluem adicionalmente quatro bases Chromium em @cybersafe/desktop (perfil legado). Diferença de âmbito, não evidência de perda de quatro bases. O perfil legado requer verificação separada atual.

## Estado

RC7 pública e feed preservados. Instalação permanece RC5. Atualização instalada: FAIL no handoff; instalação RC7: NOT TESTED. Não reutilizar freeze RC7 para fontes corrigidas. Não publicar sucessora sem aprovação.
