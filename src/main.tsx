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
  // Solo en desarrollo: IPC simulado para revisar la interfaz en un navegador, o en el WebView2
  // real con `?mock` (QA visual y de rendimiento sin base de datos ni proveedores).
  const forceMock = new URLSearchParams(location.search).has('mock');
  if (import.meta.env.DEV && (forceMock || !('__TAURI_INTERNALS__' in window))) (await import('./dev/mockTauri')).install();
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
void boot();
