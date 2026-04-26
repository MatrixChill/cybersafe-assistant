import { defineConfig } from 'vite';
import electron from 'vite-plugin-electron';
import renderer from 'vite-plugin-electron-renderer';
import path from 'path';

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
              external: ['electron', 'node:net', 'node:path', 'node:url', 'node:child_process'],
              output: {
                format: 'esm'
              }
            }
          }
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
