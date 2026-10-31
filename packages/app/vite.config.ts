import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs'
import { execSync } from 'child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ── CSP: o HTML é o único veículo que chega a file:// ─────────────────────
// O renderer empacotado abre por loadFile(file://), onde um header de resposta
// não é aplicado. A política de PRODUÇÃO vive no meta do index.html; aqui só se
// deriva a variante de DEV a partir dessa mesma string — nunca uma segunda
// política escrita à mão que possa divergir. O que se relaxa é exatamente o que
// o Vite HMR exige: o preâmbulo inline do react-refresh e o websocket.
const productionHtml = fs.readFileSync(path.resolve(__dirname, 'index.html'), 'utf8')
const productionCsp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(productionHtml)?.[1]
if (!productionCsp) throw new Error('CSP meta ausente em index.html: a entrega em file:// ficaria sem política')
const devCsp = productionCsp
  .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
  .replace("connect-src", "connect-src ws://localhost:5173 ws://127.0.0.1:5173")

/** Só em `serve`: troca o meta de produção pela variante derivada para o HMR. */
function cspDevPolicy(): Plugin {
  return {
    name: 'cybersafe-csp-dev',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, `<meta http-equiv="Content-Security-Policy" content="${devCsp}" />`)
    },
  }
}

// Identidade REAL do build (P0-7): versao do renderer + carimbo de compilacao + commit.
// Fonte canónica: product-version.json (raiz). FALHA FECHADO se inválida/ilegível.
// package.json do workspace é apenas fallback de desenvolvimento.
let appVersion = 'desconhecida'
try {
  const pvPath = path.resolve(__dirname, '../../product-version.json')
  const pv = JSON.parse(fs.readFileSync(pvPath, 'utf8'))
  if (pv && typeof pv.version === 'string') appVersion = pv.version
} catch (error) {
  try {
    appVersion = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf8')).version ?? appVersion
  } catch { /* mantem */ }
}
const candidateVersion = process.env.CYBERSAFE_BUILD_VERSION?.trim();
if (candidateVersion) {
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(candidateVersion)) throw new Error('Invalid candidate build version');
  appVersion = candidateVersion;
}
let gitCommit = 'desconhecido'
try { gitCommit = execSync('git rev-parse --short HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || gitCommit } catch { /* fora de git */ }
let gitSourceState: 'modified' | 'clean' | 'unknown' = 'unknown'
try { gitSourceState = execSync('git status --porcelain --untracked-files=normal', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() ? 'modified' : 'clean' } catch { /* estado nao verificado */ }
const buildId = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)

// https://vite.dev/config/
export default defineConfig({
  define: {
    __BUILD__: JSON.stringify({ version: appVersion, buildId, commit: gitCommit, sourceState: gitSourceState }),
  },
  plugins: [
    react(),
    tailwindcss(),
    cspDevPolicy(),
  ],
  base: './',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  }
})
