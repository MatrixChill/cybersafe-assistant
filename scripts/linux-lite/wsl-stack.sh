set -u
export PATH="$HOME/.local/node/bin:$PATH"
export DISPLAY=:0

CS_DEV_ROOT="${CS_DEV_ROOT:-/tmp/cybersafe-linux-lite-dev}"
CS_SERVICE_DIR="${CS_SERVICE_DIR:-$HOME/.cybersafe-linux-lite-dev}"
CS_DB="$CS_DEV_ROOT/data/matrix.db"
export CS_API_PORT="${CS_API_PORT:-4100}"
export CYBERSAFE_API_PORT="$CS_API_PORT"

export CYBERSAFE_DEV_ISOLATION=1
export CYBERSAFE_DEV_ROOT="$CS_DEV_ROOT"
export CYBERSAFE_DEV_SERVICE_DIR="$CS_SERVICE_DIR"
export CYBERSAFE_DEV_PIPE_NAME="$CS_SERVICE_DIR/engine.sock"
export CYBERSAFE_DB_PATH="$CS_DB"
export DATABASE_URL="file:$CS_DB"
unset CYBERSAFE_DEV_WINDOWS_READONLY CYBERSAFE_PIPE_TOKEN
mkdir -p "$CS_DEV_ROOT/data" "$CS_SERVICE_DIR"

[ -s "$CS_DEV_ROOT/jwt-secret" ] || node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" > "$CS_DEV_ROOT/jwt-secret"
chmod 600 "$CS_DEV_ROOT/jwt-secret"
export JWT_SECRET="$(cat "$CS_DEV_ROOT/jwt-secret")"
[ -s "$CS_DEV_ROOT/dev-password" ] || printf 'linux-lite-dev\n' > "$CS_DEV_ROOT/dev-password"
chmod 600 "$CS_DEV_ROOT/dev-password"

cd "$HOME/cybersafe-linux-lite" || exit 1
RV=$(node -p "require('rolldown/package.json').version" 2>/dev/null || echo "")
if [ -n "$RV" ] && ! node -e "require('@rolldown/binding-linux-x64-gnu')" >/dev/null 2>&1; then
  npm install --no-save --no-audit --no-fund "@rolldown/binding-linux-x64-gnu@$RV" >/dev/null 2>&1
fi
(cd packages/api && npx prisma generate >/dev/null 2>&1 && npx prisma db push --skip-generate >/dev/null 2>&1) && echo "esquema api: ok"

rm -f /tmp/cs-evidence.log
npx concurrently -k \
  "npm run dev:service" \
  "npm run dev:api" \
  "npm run dev:app" \
  "cd packages/desktop && npx concurrently -k 'vite build --watch' 'wait-on dist/main.js && electron . --remote-debugging-port=9229 --no-sandbox'" \
  > /tmp/cs-evidence.log 2>&1 &
PILHA=$!
echo "pilha=$PILHA"
for _ in $(seq 1 40); do sleep 5; curl -sf http://127.0.0.1:9229/json/version >/dev/null && break; done
curl -sf http://127.0.0.1:9229/json/version >/dev/null && echo "CDP: pronto" || echo "CDP: indisponivel"
echo "ligacao desktop->motor: $(grep -c 'Connected to pipe' /tmp/cs-evidence.log)"
wait "$PILHA"
