import { StrictMode, Profiler } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { applyAppearance } from './lib/appearance'
// >>> CS-THEME-PROBE (medicao dev-only; remover junto com lib/themeProbe.ts) >>>
import { installThemeProbe, onRootRender } from './lib/themeProbe'
const CS_THEME_PROBE = import.meta.env.DEV
if (CS_THEME_PROBE) installThemeProbe()
// <<< CS-THEME-PROBE <<<

try {
  applyAppearance()
} catch (e) {
  console.error("[CyberSafe] Failed to apply appearance:", e)
}

const root = document.getElementById('root');
if (root) {
  const tree = (
    <StrictMode>
      <App />
    </StrictMode>
  )
  createRoot(root).render(
    CS_THEME_PROBE ? <Profiler id="cs-root" onRender={onRootRender}>{tree}</Profiler> : tree,
  );
} else {
  document.body.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;height:100vh;background:#0a0a0f;color:#e0e0e0;font-family:monospace;text-align:center;padding:2rem;">
      <div>
        <h1 style="font-size:1.5rem;margin-bottom:1rem;">CyberSafe</h1>
        <p style="color:#888;">Elemento raiz não encontrado. Verifique se o index.html está correto.</p>
      </div>
    </div>
  `;
}
