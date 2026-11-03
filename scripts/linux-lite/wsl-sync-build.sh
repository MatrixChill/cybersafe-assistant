set -u
# Sincroniza o clone WSL com a branch experimental, compila e mede.
# Ficheiro em vez de linha de comando embutida: Git Bash -> wsl.exe -> bash
# expande variáveis dentro de aspas duplas e já partiu o PATH e os caminhos da
# chamada. Uma medição com caminhos vazios não mede nada.
D="$HOME/cybersafe-linux-lite"
RAMA=experimental/linux-lite-qoder
export PATH="$HOME/.local/node/bin:$PATH"

echo "== estado do clone antes de sincronizar =="
git -C "$D" rev-parse --abbrev-ref HEAD
git -C "$D" log --oneline -1
git -C "$D" status --porcelain
echo "-- diff (o que é descartado são cópias minhas, já commitadas na origem) --"
git -C "$D" diff --stat | tail -5

git -C "$D" fetch origin "$RAMA" || { echo "FETCH_FALHOU"; exit 1; }
git -C "$D" checkout "$RAMA" || { echo "CHECKOUT_FALHOU"; exit 1; }
git -C "$D" reset --hard FETCH_HEAD || { echo "RESET_FALHOU"; exit 1; }
echo "head_depois=$(git -C "$D" log --oneline -1)"

cd "$D" || exit 1
for pacote in @cybersafe/core @cybersafe/service; do
  nome=${pacote##*/}
  if npm run build -w "$pacote" > "/tmp/build-$nome.log" 2>&1; then
    echo "build $pacote ok"
  else
    echo "build $pacote FALHOU"
    tail -25 "/tmp/build-$nome.log"
    exit 1
  fi
done

echo "== o serviço compilado tem o ramo POSIX? =="
grep -c "posixProcessProvider" packages/service/dist/engine.js || echo "0 ocorrencias"

echo "===================== DIAGNÓSTICO ====================="
bash scripts/linux-lite/wsl-p1-diag.sh
echo "===================== PROVA P1 ======================="
bash scripts/linux-lite/wsl-p1-listing.sh
