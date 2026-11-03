set -u
export PATH="$HOME/.local/node/bin:$PATH"
R="$HOME/cybersafe-linux-lite"
echo "ocorrencias_na_fonte:"
grep -rn "Versão do protocolo do pipe" "$R/packages" --include=*.ts | head -5
echo "ocorrencias_no_dist:"
grep -rln "Versão do protocolo do pipe" "$R/packages/service/dist" | head -5
echo "contexto_no_dist:"
grep -rn "Versão do protocolo do pipe" "$R/packages/service/dist"/*.js 2>/dev/null | head -3
grep -rn "Versão do protocolo do pipe" "$R/packages/service/dist"/**/*.js 2>/dev/null | head -3
echo "constantes_de_versao_no_dist:"
grep -rn "PIPE_AUTH_VERSION" "$R/packages/service/dist/engine.js" | head -6
echo "valores_de_versao_em_cada_modulo:"
grep -rn "PIPE_AUTH_VERSION = " "$R/packages"/*/dist/*.js 2>/dev/null | head -6
grep -rn "PIPE_AUTH_VERSION = " "$R/node_modules/@cybersafe"/*/dist/*.js 2>/dev/null | head -6
