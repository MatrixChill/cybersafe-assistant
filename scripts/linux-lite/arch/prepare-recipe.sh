#!/usr/bin/env bash
set -euo pipefail
if [[ $# != 1 ]]; then
  echo "Uso: bash scripts/linux-lite/arch/prepare-recipe.sh <novo-diretorio>" >&2
  exit 2
fi

root=$(git rev-parse --show-toplevel)
commit=$(git -C "$root" rev-parse HEAD)
version=$(git -C "$root" show "$commit:product-version.json" | node -p 'JSON.parse(require("fs").readFileSync(0)).version')
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "A receita Arch requer uma versão canónica estável." >&2
  exit 1
fi

mkdir -- "$1"
git -C "$root" archive --prefix=cybersafe/ --format=tar.gz "$commit" > "$1/cybersafe-source.tar.gz"
read -r hash _ < <(sha256sum -- "$1/cybersafe-source.tar.gz")
git -C "$root" show "$commit:scripts/linux-lite/arch/PKGBUILD.in" |
  sed -e "s/@VERSION@/$version/g" -e "s/@SHA256@/$hash/g" > "$1/PKGBUILD"
printf 'commit=%s\nversion=%s\nsource_sha256=%s\n' "$commit" "$version" "$hash" > "$1/SOURCE-IDENTITY"
