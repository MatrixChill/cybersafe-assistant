// Renderer entry point - loads the React app
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from '../app/src/App';

// Mount React app
const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(React.createElement(App));
}

console.log('[Renderer] CyberSafe Antivirus loaded');
