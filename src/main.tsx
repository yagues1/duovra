import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/globals.css';
import App from './App';

// Chromium mantiene :focus-visible al pulsar un campo de texto o un control ya enfocado con Tab.
const root = document.documentElement;
window.addEventListener('pointerdown', () => {
  root.dataset.focusInput = 'pointer';
}, { capture: true, passive: true });
window.addEventListener('keydown', (event) => {
  if (root.dataset.focusInput !== 'pointer' || event.isComposing) return;
  if (['Alt', 'Control', 'Meta', 'Shift'].includes(event.key)) return;
  const target = event.target;
  const editing = target instanceof HTMLElement &&
    (target.isContentEditable || target.matches('textarea, input:not([type]), input[type="text"]'));
  // Escribir y mover el cursor tras un clic conserva el aspecto del campo.
  if (!editing || event.key === 'Tab' || event.key === 'Escape') delete root.dataset.focusInput;
}, true);

// Sin menú contextual nativo del WebView, salvo en campos de texto.
window.addEventListener('contextmenu', (e) => {
  const t = e.target as HTMLElement;
  if (!t.closest('input, textarea, .selectable')) e.preventDefault();
});

/** Barra de la ventana independiente de Live Preview (`?lp=<espacio>`): sin datos ni estado de Duovra. */
async function bootPreviewBar(space: string, lang: string | null) {
  const [{ LivePreviewBar }, { setLocale }] = await Promise.all([import('./components/livepreview/LivePreviewBar'), import('./i18n')]);
  setLocale(lang === 'en' ? 'en' : 'es');
  document.documentElement.dataset.surface = 'preview-bar';
  createRoot(document.getElementById('root')!).render(<StrictMode><LivePreviewBar space={space} /></StrictMode>);
}

async function boot() {
  const params = new URLSearchParams(location.search);
  const previewSpace = params.get('lp');
  if (previewSpace && /^[\w-]{1,64}$/.test(previewSpace)) return bootPreviewBar(previewSpace, params.get('lang'));
  // Solo en desarrollo: IPC simulado para revisar la interfaz en un navegador, o en el WebView2
  // real con `?mock` (QA visual y de rendimiento sin base de datos ni proveedores).
  const forceMock = new URLSearchParams(location.search).has('mock');
  const native = '__TAURI_INTERNALS__' in window;
  if (import.meta.env.VITE_DUOVRA_QA === '1' || (import.meta.env.DEV && (forceMock || !native))) {
    (await import('./dev/mockTauri')).install(native);
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
void boot();
