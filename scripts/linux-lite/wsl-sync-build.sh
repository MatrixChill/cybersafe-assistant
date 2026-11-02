set -u
# Sincroniza a área de trabalho do Windows para o clone WSL, compila e mede.
# Ficheiro em vez de linha de comando embutida: as três camadas de citação
# (Git Bash -> wsl.exe -> bash -lc) já partiram variáveis em chamadas anteriores,
# e uma medição com caminhos vazios não mede nada.
S=/mnt/c/Users/caioc/.cybersafe-integration/qoder-linux-lite/repo
D="$HOME/cybersafe-linux-lite"
export PATH="$HOME/.local/node/bin:$PATH"

FICHEIROS="packages/core/src/process-provider-posix.ts packages/core/src/index.ts packages/service/src/engine.ts packages/core/test/process-provider-posix.test.js scripts/linux-lite/wsl-p1-listing.sh scripts/linux-lite/wsl-p1-diag.sh"
for f in $FICHEIROS; do
  if tr -d '\015' < "$S/$f" > "$D/$f.novo"; then
    mv "$D/$f.novo" "$D/$f"
    echo "sinc $f ok"
  else
    rm -f "$D/$f.novo"
    echo "sinc $f FALHOU"
  fi
done

cd "$D" || exit 1
for pacote in @cybersafe/core @cybersafe/service; do
  if npm run build -w "$pacote" > "/tmp/build-${pacote##*/}.log" 2>&1; then
    echo "build $pacote ok"
  else
    echo "build $pacote FALHOU"
    tail -20 "/tmp/build-${pacote##*/}.log"
    exit 1
  fi
done

echo "===================== DIAGNÓSTICO ====================="
bash scripts/linux-lite/wsl-p1-diag.sh
echo "===================== PROVA P1 ======================="
bash scripts/linux-lite/wsl-p1-listing.sh
