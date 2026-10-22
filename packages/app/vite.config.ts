import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs'
import { execSync } from 'child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Identidade REAL do build (P0-7): versao do renderer + carimbo de compilacao + commit.
// Falha de leitura NAO parte o build — cai em valores declarados, nunca fingidos.
let appVersion = 'desconhecida'
try { appVersion = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf8')).version ?? appVersion } catch { /* mantem */ }
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
