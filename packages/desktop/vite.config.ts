import { defineConfig } from 'vite';
import electron from 'vite-plugin-electron';
import renderer from 'vite-plugin-electron-renderer';
import path from 'path';
import { cpSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Electron loads tray/splash assets from dist/assets at runtime, but Vite only
// emits bundled JS — so copy static assets from src/assets into dist/assets
// on every build (fixes the invisible tray icon in dev).
function copyAssets() {
  return {
    name: 'cybersafe-copy-assets',
    writeBundle() {
      const src = path.resolve(__dirname, 'src', 'assets');
      const dst = path.resolve(__dirname, 'dist', 'assets');
      if (existsSync(src)) cpSync(src, dst, { recursive: true });
    },
  };
}

export default defineConfig({
  plugins: [
    electron([
      {
        entry: 'src/main.ts',
        vite: {
          build: {
            ssr: true,
            minify: false,
            outDir: 'dist',
            rollupOptions: {
              external: ['electron', 'node:net', 'node:path', 'node:url', 'node:child_process', '@cybersafe/core', '@cybersafe/shared-types'],
              output: {
                format: 'esm'
              }
            }
          },
          plugins: [copyAssets()]
        }
      },
      {
        entry: 'src/preload.ts',
        vite: {
          build: {
            outDir: 'dist',
            minify: false,
            rollupOptions: {
              external: ['electron'],
              output: {
                format: 'cjs',
                entryFileNames: '[name].cjs'
              }
            }
          }
        }
      }
    ]),
    renderer()
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src')
    }
  },
  server: {
    port: 5174,
    // Desktop is a passive wrapper in dev; don't fail if 5174 is taken.
    strictPort: false
  },
  build: {
    rollupOptions: {
      output: {
        entryFileNames: '[name].js'
      }
    }
  }
});
