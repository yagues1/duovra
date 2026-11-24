import { memo } from 'react';
import type { ActivityView } from '../../hooks/useActivity';
import { AGENT_NAME } from '../../lib/format';
import type { AgentId } from '../../lib/types';
import { useTr } from '../../i18n';

/**
 * Estado del turno para lectores de pantalla. Desde 1.0.7 la parte visual (mascota y bocadillo) la
 * dibuja el anfitrión (`MascotHost`) fuera de la caja del compositor; aquí queda el anuncio accesible
 * y un respiro sobre el compositor.
 */
export const AgentActivity = memo(function AgentActivity({ view }: { view: ActivityView; idleAgent: AgentId }) {
  const tr = useTr();
  const { activity, agent, label } = view;
  const active = activity !== 'idle' && agent !== null;
  return (
    <div className="stage-slot stage-spacer" data-s={active ? activity : undefined}>
      <span className="sr-only" role="status" aria-atomic="true">
        {active ? `${AGENT_NAME[agent]} · ${label}` : tr('Listo para trabajar')}
      </span>
    </div>
  );
});
