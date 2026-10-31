# Assinatura Ed25519 de releases — runbook

Estado em 2026-10-31: **NÃO PROVISIONADO**. `packages/desktop/src/updater/release-trust.json`
tem `enabled: false`, `publicKeyPem` vazio e `pinnedKeyFingerprint` vazio. Nenhuma
chave foi ativada em produção e nenhum segredo foi escrito no repo,
nos logs ou no payload. Foi gerado um par PROPOSTO fora do repo, com ACL apenas
do utilizador; aprovação humana **PENDING**. Fingerprint SHA-256/SPKI:
`3982C36398918D077A417DDA02E6E7FF6C1F70622684DA4FB43673652E4C8FB6`.
Pública: `C:/Users/caioc/.cybersafe-keys/pap-r6-20261031/public.pem`.
Não regenerar o par nem ler a privada para relatórios. Não ativar trust sem
aprovação; freeze técnico não equivale a autorização criptográfica.

## O que já está implementado

- `scripts/release-signing.mjs` — assina/verifica os bytes canónicos de
  `packages/desktop/src/updater/manifest.ts`; recusa chave privada dentro do
  repositório (incluindo symlink) e nunca imprime material da chave.
- `packages/desktop/test/release-signing-compat.test.mjs` — prova que o
  assinador e o updater canonicalizam os mesmos bytes.
- `.github/workflows/release-sign.yml` — manual, environment `release-signing`,
  exige `RELEASE_ED25519_PRIVATE_KEY`, `RELEASE_ED25519_PUBLIC_KEY` e
  `RELEASE_ED25519_FINGERPRINT`. O `manifest_path` chega por `env`, nunca é
  interpolado no corpo do `run`; `--sign-manifest` confina-o ao repositório por
  realpath e exige ficheiro regular. Produz `update-manifest.signed.json` com o
  bloco `signature` que o updater lê (não um `.sig` destacado sem instrução de
  montagem) e verifica-o antes de exportar. Não publica, não cria Release e não
  executa instaladores.
- `.github/workflows/ci.yml` — build:all e testes; sem segredos. **Não é um
  build Windows+payload completo**: não builda o native-engine, não provisiona
  ClamAV/YARA, não gera NSIS nem mede o payload. Esses gates são locais/Windows
  com o freeze aprovado.

## Geração (offline, fora do repositório)

Executar num diretório fora do repo, idealmente offline e com o mínimo de
permissões. Não colar a chave privada em chats, issues, logs ou variáveis
persistentes.

```bash
mkdir -p "$HOME/.cybersafe-release-keys"
umask 077
openssl genpkey -algorithm ED25519 -out "$HOME/.cybersafe-release-keys/cybersafe-release-private.pem"
openssl pkey -in "$HOME/.cybersafe-release-keys/cybersafe-release-private.pem" \
  -pubout -out "$HOME/.cybersafe-release-keys/cybersafe-release-public.pem"
node scripts/release-signing.mjs --fingerprint "$HOME/.cybersafe-release-keys/cybersafe-release-public.pem"
```

O fingerprint devolvido é SHA-256 do DER SPKI, em maiúsculas. É esse valor que
o proprietário aprova, não a chave privada.

## Aprovação e ativação (humana)

1. O proprietário confirma o fingerprint e a origem da chave.
2. Guardar a privada num gestor de segredos/offline; nunca no repositório
   (`*.pem` e `*.key` já estão no `.gitignore`, mas isso não é o controlo).
3. Definir no GitHub, no environment `release-signing`:
   - secret `RELEASE_ED25519_PRIVATE_KEY` (PEM completo);
   - secret `RELEASE_ED25519_PUBLIC_KEY` (PEM público);
   - variable `RELEASE_ED25519_FINGERPRINT` (fingerprint aprovado).
4. Só depois da aprovação da chave E da infraestrutura/feed, atualizar
   `release-trust.json` com a chave pública, o fingerprint e `enabled: true`. A chave pública pode ser commitada; a
   privada nunca.
5. Correr o workflow `release-sign` com um manifesto revisto e verificar a
   assinatura com `--verify`. O updater continua em modo manual: a assinatura
   precede a disponibilidade, mas a instalação automática permanece bloqueada.

## Assinar e verificar localmente

```bash
# Forma preferida: manifesto completo com signature embutida (formato updater).
node scripts/release-signing.mjs --sign-manifest release/update-manifest.json \
  --key "$HOME/.cybersafe-release-keys/cybersafe-release-private.pem" \
  --fingerprint "<FINGERPRINT_APROVADO>" \
  --out release/update-manifest.signed.json
node scripts/release-signing.mjs --verify-embedded release/update-manifest.signed.json \
  --key "$HOME/.cybersafe-release-keys/cybersafe-release-public.pem"

# Variante destacada, só para inspeção local; não é o artefacto do workflow.
node scripts/release-signing.mjs --sign release/update-manifest.json \
  --key "$HOME/.cybersafe-release-keys/cybersafe-release-private.pem" \
  --out release/update-manifest.sig
node scripts/release-signing.mjs --verify release/update-manifest.json \
  --key "$HOME/.cybersafe-release-keys/cybersafe-release-public.pem" \
  --sig release/update-manifest.sig
```

## Rotação/revogação

- Gerar novo par, obter novo fingerprint e aprovação explícita.
- Atualizar `pinnedKeyFingerprint` e `publicKeyPem` numa release que ainda possa
  ser verificada pela chave antiga; documentar a janela de transição.
- O updater aceita UMA chave pinada; não há lista de chaves. Uma rotação sem
  essa janela deixa instalações antigas sem verificação — é uma decisão do
  proprietário, não do build.

## Limites

- Sem a chave aprovada, `release-trust.json` fica desativado e o updater
  `unconfigured`. Não substituir por chave de fixture.
- O CI atual não constrói nem mede o instalador; a assinatura do manifesto não
  substitui o packaging, o Authenticode nem a validação na VM.
- O certificado Authenticode continua separado da assinatura Ed25519; este
  runbook não cria nem instala certificados.
