import { Component, type ErrorInfo, type ReactNode } from 'react';
import { RotateCcw, TriangleAlert } from 'lucide-react';

interface Props {
  /** Nombre legible de la zona protegida («Modelos», «Conversación»…). */
  area: string;
  children: ReactNode;
  /** Cambiar esta clave restablece la zona (p. ej., al cambiar de sección). */
  resetKey?: unknown;
  compact?: boolean;
}

interface State {
  error: Error | null;
}

/**
 * Aísla un fallo de renderizado en su zona. Sin esto, React desmonta el árbol completo y la
 * ventana queda vacía (AUD-001). La barra superior, la lateral y el resto de vistas siguen vivas.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Queda en la consola de WebView2 para diagnóstico; no se envía a ningún servicio.
    console.error(`[${this.props.area}]`, error, info.componentStack);
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className={`error-surface ${this.props.compact ? 'm-3' : 'm-auto max-w-[460px]'}`} role="alert">
        <div className="flex items-start gap-3">
          <span className="error-surface-icon" aria-hidden>
            <TriangleAlert size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-medium" style={{ color: 'var(--text-strong)' }}>
              No se pudo mostrar {this.props.area}
            </div>
            <p className="mb-0 mt-1 text-[12.5px] leading-relaxed muted">
              El resto de la aplicación sigue disponible. Tus conversaciones y ajustes no se han modificado.
            </p>
            <code className="selectable mt-2 block break-words font-mono text-[11.5px] faint">{error.message}</code>
            <button className="btn mt-3" onClick={() => this.setState({ error: null })}>
              <RotateCcw size={13} /> Reintentar
            </button>
          </div>
        </div>
      </div>
    );
  }
}
