set -euo pipefail
export PATH="$HOME/.local/node/bin:$PATH"
cd "$HOME/cybersafe-linux-lite"
echo "== npm ci =="
npm ci --no-audit --no-fund 2>&1 | tail -3
for w in @cybersafe/shared-types @cybersafe/core @cybersafe/native-windows @cybersafe/service; do
  echo "== build $w =="
  npm run build -w "$w" 2>&1 | tail -2
done
echo BUILD_OK
