import { getCurrentWindow } from '@tauri-apps/api/window';
import { useEffect, useState } from 'react';

/** Controles de ventana de Windows dibujados a medida (la ventana no tiene marco nativo). */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    const w = getCurrentWindow();
    void w.isMaximized().then(setMaximized);
    const un = w.onResized(() => void w.isMaximized().then(setMaximized));
    return () => {
      void un.then((f) => f());
    };
  }, []);
  const w = getCurrentWindow();
  return (
    <div className="flex h-full items-stretch">
      <button className="win-btn" aria-label="Minimizar" onClick={() => void w.minimize()}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M0 5.5h10" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
      <button
        className="win-btn"
        aria-label={maximized ? 'Restaurar' : 'Maximizar'}
        onClick={() => void w.toggleMaximize()}
      >
        {maximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden fill="none" stroke="currentColor">
            <rect x="0.5" y="2.5" width="7" height="7" rx="1.2" />
            <path d="M2.5 2.5V1.7a1.2 1.2 0 0 1 1.2-1.2h4.6a1.2 1.2 0 0 1 1.2 1.2v4.6a1.2 1.2 0 0 1-1.2 1.2H7.5" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden fill="none" stroke="currentColor">
            <rect x="0.5" y="0.5" width="9" height="9" rx="1.5" />
          </svg>
        )}
      </button>
      <button className="win-btn win-close" aria-label="Cerrar" onClick={() => void w.close()}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
    </div>
  );
}
