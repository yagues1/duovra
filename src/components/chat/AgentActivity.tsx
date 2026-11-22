import { memo } from 'react';
import type { ActivityView } from '../../hooks/useActivity';
import { TURN_LABEL } from '../../lib/activity';
import { AGENT_NAME } from '../../lib/format';
import type { AgentId } from '../../lib/types';
import { Mascot } from '../mascot/Mascot';

/** El estado y el agente proceden del turno. En reposo, la selección queda en el compositor. */
export const AgentActivity = memo(function AgentActivity({ view, idleAgent }: { view: ActivityView; idleAgent: AgentId }) {
  const { activity, agent, label, detail, stopping } = view;
  const starting = label === TURN_LABEL.preparing;
  const active = activity !== 'idle' && agent !== null;
  const pose = active && !stopping ? activity : 'idle';
  const mascotAgent = active ? agent : idleAgent;
  return (
    <div className="stage-slot">
      <span className="sr-only" role="status" aria-atomic="true">
        {active ? `${AGENT_NAME[agent]} · ${label}` : 'Listo para trabajar'}
      </span>
      <div className={active ? 'stage agent-activity' : 'stage-idle'}
        data-agent={active ? agent : undefined} data-s={active ? activity : undefined} data-stopping={stopping || undefined}>
        {active ? (
          <div className="stage-plate">
            <div className="stage-line" aria-hidden>
              <strong className="stage-label agent-activity-label">{label}</strong>
              <span className="stage-agent">{AGENT_NAME[agent]}</span>
            </div>
            {detail && <span className="stage-detail" title={detail}>{detail}</span>}
          </div>
        ) : <span aria-hidden>Listo para trabajar</span>}
        <div className={active ? 'stage-mascot' : 'stage-idle-mascot'} data-agent={mascotAgent} data-s={pose} aria-hidden>
          <Mascot key={mascotAgent} agent={mascotAgent} state={pose} size={62} animated={!stopping}
            phase={starting ? 'starting' : undefined} />
        </div>
      </div>
    </div>
  );
});
