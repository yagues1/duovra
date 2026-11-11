import type { AgentId } from '../../lib/types';

/**
 * Identificador de proveedor. Duovra no incluye los logotipos de Anthropic ni de OpenAI: sus
 * directrices exigen permiso para usarlos en productos de terceros y no forman parte de la
 * licencia MIT del proyecto. Cada agente se reconoce por un glifo propio y neutral, su color y
 * su nombre en texto (ver THIRD_PARTY_NOTICES.md).
 *
 * - Claude Code: indicador de terminal «›_» (es una CLI), en tono cálido.
 * - Codex: llaves «{ }», en tono aguamarina.
 */
export function AgentGlyph({ agent, size = 26, active = false }: { agent: AgentId; size?: number; active?: boolean }) {
  return (
    <span className="agent-glyph" data-agent={agent} data-active={active || undefined} style={{ width: size, height: size, borderRadius: size * 0.34 }} aria-hidden>
      <svg viewBox="0 0 24 24" width={size * 0.62} height={size * 0.62} fill="none" stroke="currentColor" strokeWidth={2.1} strokeLinecap="round" strokeLinejoin="round">
        {agent === 'claude' ? (
          <>
            <path d="M5 7.5l4.5 4.5L5 16.5" />
            <path d="M12.5 17h6.5" />
          </>
        ) : (
          <>
            <path d="M8.5 4.5c-2 0-2.5 1-2.5 2.6v2.3c0 1.3-.7 2.1-2 2.6 1.3.5 2 1.3 2 2.6v2.3c0 1.6.5 2.6 2.5 2.6" />
            <path d="M15.5 4.5c2 0 2.5 1 2.5 2.6v2.3c0 1.3.7 2.1 2 2.6-1.3.5-2 1.3-2 2.6v2.3c0 1.6-.5 2.6-2.5 2.6" />
          </>
        )}
      </svg>
    </span>
  );
}
