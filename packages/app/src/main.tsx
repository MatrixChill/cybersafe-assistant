import { StrictMode, Profiler } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
// Camada de identidade V2. Depois de `index.css` porque é a fonte que vence —
// não por ordem de ficheiro, mas pela especificidade própria de
// `src/v2/bridge.css` sobre os blocos de tema de V1.
import './v2/tokens.css'
import './v2/bridge.css'
import './v2/primitives.css'
import './v2/shell.css'
import './v2/scanner/scanner-v2.css'
import './v2/quarantine/quarantine-v2.css'
import './v2/history/history-v2.css'
import './v2/dashboard/effects/Aurora.css'
import './v2/dashboard/effects/SpotlightCard.css'
import './v2/lab-sidebar.css'
import './v2/dashboard/lab-dashboard.css'
import './v2/dashboard/production-controls.css'
import App from './App.tsx'
import { applyAppearance } from './lib/appearance'
import { applyV2Appearance } from './v2/theme'
// >>> CS-THEME-PROBE (medicao dev-only; remover junto com lib/themeProbe.ts) >>>
import { installThemeProbe, onRootRender } from './lib/themeProbe'
const CS_THEME_PROBE = import.meta.env.DEV
if (CS_THEME_PROBE) installThemeProbe()
// <<< CS-THEME-PROBE <<<

try {
  // A projeção de V1 primeiro, os atributos V2 depois: no primeiro pixel o que
  // pinta é a camada V2, e o AppearanceProvider torna os dois coerentes no
  // primeiro commit.
  applyAppearance()
  applyV2Appearance()
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
