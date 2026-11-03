set -u
export PATH="$HOME/.local/node/bin:$PATH"
REPO="${REPO:-$HOME/cybersafe-linux-lite}"
SRCDIR="/mnt/c/Users/caioc/.cybersafe-integration/qoder-linux-lite/repo"

sleep 900 & A=$!
sleep 901 & B=$!
echo "benign_alvo=$A benign_irmao=$B"

cp "$SRCDIR/scripts/linux-lite/wsl-p1-ticket-inproc.mjs" "$REPO/packages/service/cs-ticket-inproc.mjs"
node "$REPO/packages/service/cs-ticket-inproc.mjs" "$A" "$B"
echo "inproc_exit=$?"
rm -f "$REPO/packages/service/cs-ticket-inproc.mjs"
kill $A $B 2>/dev/null
