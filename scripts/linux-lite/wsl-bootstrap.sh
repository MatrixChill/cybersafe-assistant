set -euo pipefail
export PATH="$HOME/.local/node/bin:$PATH"

if [ ! -x "$HOME/.local/node/bin/node" ]; then
  mkdir -p "$HOME/.local"
  cd "$HOME/.local"
  FILE=$(curl -fsSL https://nodejs.org/dist/latest-v22.x/ | grep -oE 'node-v[0-9.]+-linux-x64\.tar\.xz' | head -1)
  [ -n "$FILE" ] || { echo "ERRO: nome de ficheiro nao encontrado"; exit 1; }
  echo "getting $FILE"
  curl -fsSLO "https://nodejs.org/dist/latest-v22.x/$FILE"
  tar -xf "$FILE"
  ln -sfn "$HOME/.local/${FILE%.tar.xz}" "$HOME/.local/node"
fi
echo "node=$(node -v)"
echo "npm=$(npm -v)"

SRC="/mnt/c/Users/caioc/.cybersafe-integration/qoder-linux-lite/repo"
DST="$HOME/cybersafe-linux-lite"
git config --global --add safe.directory "$SRC" >/dev/null 2>&1 || true
git config --global --add safe.directory "$DST" >/dev/null 2>&1 || true
if [ ! -d "$DST" ]; then
  git clone -b experimental/linux-lite-qoder "$SRC" "$DST"
else
  git -C "$DST" fetch origin experimental/linux-lite-qoder:experimental/linux-lite-qoder 2>/dev/null || true
  git -C "$DST" checkout experimental/linux-lite-qoder 2>/dev/null || true
  git -C "$DST" pull --ff-only || true
fi
echo "branch=$(git -C "$DST" rev-parse --abbrev-ref HEAD)"
echo "head=$(git -C "$DST" log --oneline -1)"
