import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { initAuth } from './api';
import { start } from './store';
import { applyTheme } from './theme';
import { App } from './App';
// fonts ship with the app: no third-party requests, and the always-on box works offline
import '@fontsource-variable/inter/opsz.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import './styles.css';

initAuth();
applyTheme();
start();

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => { /* optional */ }); });
}
