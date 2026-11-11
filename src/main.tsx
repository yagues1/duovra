import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/globals.css';
import App from './App';

// Sin menú contextual nativo del WebView, salvo en campos de texto.
window.addEventListener('contextmenu', (e) => {
  const t = e.target as HTMLElement;
  if (!t.closest('input, textarea, .selectable')) e.preventDefault();
});

async function boot() {
  // Solo en desarrollo y fuera de Tauri: IPC simulado para revisar la interfaz en un navegador.
  if (import.meta.env.DEV && !('__TAURI_INTERNALS__' in window)) (await import('./dev/mockTauri')).install();
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
void boot();
