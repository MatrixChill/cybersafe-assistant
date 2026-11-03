set -u
export PATH="$HOME/.local/node/bin:$PATH"
export DISPLAY=:0

# Raízes de isolamento (nada toca o perfil pessoal nem a base Windows).
CS_DEV_ROOT="${CS_DEV_ROOT:-/tmp/cybersafe-linux-lite-dev}"
CS_SERVICE_DIR="${CS_SERVICE_DIR:-$HOME/.cybersafe-linux-lite-dev}"
CS_SOCKET="$CS_SERVICE_DIR/engine.sock"
CS_DB="$CS_DEV_ROOT/data/matrix.db"
CS_API_PORT="${CS_API_PORT:-4100}"

export CYBERSAFE_DEV_ISOLATION=1
export CYBERSAFE_DEV_ROOT="$CS_DEV_ROOT"
export CYBERSAFE_DEV_SERVICE_DIR="$CS_SERVICE_DIR"
export CYBERSAFE_DEV_PIPE_NAME="$CS_SOCKET"
export CYBERSAFE_DB_PATH="$CS_DB"
export CYBERSAFE_API_PORT="$CS_API_PORT"
export DATABASE_URL="file:$CS_DB"
unset CYBERSAFE_DEV_WINDOWS_READONLY CYBERSAFE_PIPE_TOKEN
mkdir -p "$CS_DEV_ROOT/data" "$CS_SERVICE_DIR"

# Segredo JWT próprio desta instalação de dev, gerado e guardado FORA do repositório.
[ -s "$CS_DEV_ROOT/jwt-secret" ] || node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" > "$CS_DEV_ROOT/jwt-secret"
chmod 600 "$CS_DEV_ROOT/jwt-secret"
export JWT_SECRET="$(cat "$CS_DEV_ROOT/jwt-secret")"

# Conta local sintética só para demonstrar o Dashboard; vive em /tmp, nunca no Git.
CS_DEV_EMAIL="dev@linux.local"
[ -s "$CS_DEV_ROOT/dev-password" ] || printf 'linux-lite-dev\n' > "$CS_DEV_ROOT/dev-password"
chmod 600 "$CS_DEV_ROOT/dev-password"
CS_DEV_SENHA="$(cat "$CS_DEV_ROOT/dev-password")"

cd "$HOME/cybersafe-linux-lite" || exit 1

RV=$(node -p "require('rolldown/package.json').version" 2>/dev/null || echo "")
if [ -n "$RV" ] && ! node -e "require('@rolldown/binding-linux-x64-gnu')" >/dev/null 2>&1; then
  npm install --no-save --no-audit --no-fund "@rolldown/binding-linux-x64-gnu@$RV" >/dev/null 2>&1
fi

(cd packages/api && npx prisma generate >/dev/null 2>&1 && npx prisma db push --skip-generate >/dev/null 2>&1) \
  && echo "esquema api: ok" || echo "esquema api: FALHOU"

rm -f /tmp/cs-evidence.log
npx concurrently -k \
  "npm run dev:service" \
  "npm run dev:api" \
  "npm run dev:app" \
  "cd packages/desktop && npx concurrently -k 'vite build --watch' 'wait-on dist/main.js && electron . --remote-debugging-port=9229 --no-sandbox'" \
  > /tmp/cs-evidence.log 2>&1 &
PILHA=$!
limpar() { kill -TERM "$PILHA" 2>/dev/null; pkill -f "electron \." 2>/dev/null; pkill -f "vite build --watch" 2>/dev/null; pkill -f "tsx watch src/index.ts" 2>/dev/null; pkill -f concurrently 2>/dev/null; }
trap limpar EXIT

esperar() { for _ in $(seq 1 40); do sleep 5; eval "$2" && return 0; grep -q "exited with code" /tmp/cs-evidence.log && return 1; done; return 1; }
esperar "CDP" "curl -sf http://127.0.0.1:9229/json/version >/dev/null" || { echo "CDP nao abriu"; tail -20 /tmp/cs-evidence.log; exit 1; }
echo "ligacao desktop->motor: $(grep -c 'Connected to pipe' /tmp/cs-evidence.log) | retentativas: $(grep -c 'Pipe not ready' /tmp/cs-evidence.log)"

SENHA="$CS_DEV_SENHA" REG=$(curl -s -X POST "http://127.0.0.1:$CS_API_PORT/auth/register" -H 'Content-Type: application/json' \
  -d "{\"name\":\"Dev Linux\",\"email\":\"$CS_DEV_EMAIL\",\"password\":\"$SENHA\",\"type\":\"personal\"}")
echo "registo: $(printf '%s' "$REG" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);console.log(j.user?('ok id='+j.user.id+' role='+j.user.role):(j.error||j.message||'sem user no corpo'))}catch{console.log((d||'sem resposta').slice(0,140))}})")"

CS_DEV_EMAIL="$CS_DEV_EMAIL" CS_DEV_SENHA="$CS_DEV_SENHA" node --input-type=module - <<'EOF'
const email = process.env.CS_DEV_EMAIL, senha = process.env.CS_DEV_SENHA;
const alvo = (await (await fetch("http://127.0.0.1:9229/json/list")).json())
  .find((t) => t.type === "page" && /localhost:5173/.test(t.url));
if (!alvo) { console.log("sem alvo do renderer"); process.exit(1); }
const ws = new WebSocket(alvo.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
let seq = 0; const pend = new Map();
ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); const p = pend.get(m.id); if (p) { pend.delete(m.id); p(m); } });
const call = (method, params = {}) => new Promise((res) => { const id = ++seq; pend.set(id, (m) => res(m.result ?? m.error)); ws.send(JSON.stringify({ id, method, params })); });
const avalia = async (expr) => { const r = await call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); return r.result?.value ?? r; };

const ESTADO = `(() => {
  const cs = getComputedStyle(document.body);
  const limpar = (s) => (s || "").replace(/\\s+/g, " ").trim();
  return {
    url: location.href, titulo: document.title, tema: document.documentElement.className,
    fundo: cs.backgroundColor,
    nav: Array.from(document.querySelectorAll("nav a, nav button, aside a, aside button")).map(e => limpar(e.textContent)).filter(Boolean).slice(0, 30),
    titulos: Array.from(document.querySelectorAll("h1,h2,h3")).map(e => limpar(e.textContent)).slice(0, 12),
    texto: (document.body.innerText || "").slice(0, 1500)
  };
})()`;

console.log("=== ANTES ===");
console.log(JSON.stringify(await avalia(ESTADO), null, 1).slice(0, 1800));

// Escreve com o teclado real do Chromium: o React só vê eventos nativos, por isso
// um `value` atribuído por script não chega ao estado da aplicação.
const escrever = async (seletor, texto) => {
  await call("Runtime.evaluate", { expression: `(() => { const e = document.querySelector(${seletor}); if (e) e.focus(); return !!e; })()` });
  for (const ch of texto) {
    await call("Input.dispatchKeyEvent", { type: "keyDown", key: ch === " " ? "Space" : ch, text: ch, unmodifiedText: ch });
    await call("Input.dispatchKeyEvent", { type: "keyUp", key: ch === " " ? "Space" : ch, text: ch, unmodifiedText: ch });
  }
};
await escrever("input[type=email], input", email);
await escrever("input[type=password]", senha);
await new Promise((r) => setTimeout(r, 700));
const submeter = await avalia(`(() => {
  const b = Array.from(document.querySelectorAll("button")).find((x) => /entrar|iniciar sess/i.test(x.textContent || ""));
  if (!b) return "botao Entrar ausente";
  b.click();
  return "clicado";
})()`);
console.log("submeter:", submeter);
await new Promise((r) => setTimeout(r, 7000));
console.log("=== DEPOIS ===");
console.log(JSON.stringify(await avalia(ESTADO), null, 1).slice(0, 2600));
await call("Page.enable");
const shot = await call("Page.captureScreenshot", { format: "png" });
if (shot?.data) {
  const fs = await import("node:fs");
  const buf = Buffer.from(shot.data, "base64");
  fs.writeFileSync("/mnt/c/Users/caioc/.cybersafe-integration/qoder-linux-lite/artifacts/cybersafe-linux-dashboard.png", buf);
  console.log("SCREENSHOT_OK bytes=" + buf.length);
} else console.log("sem screenshot");
ws.close();
EOF

echo "=== erros relevantes ==="
grep -iE "ERROR:|Uncaught|Failed to load|net::|EACCES" /tmp/cs-evidence.log | grep -v Autofill | tail -8
limpar
true
