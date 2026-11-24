import { motion } from 'motion/react';
import { ChevronRight, CircleAlert, Layers } from 'lucide-react';
import { useContext, useEffect, useMemo, useState } from 'react';
import type { RunView, TimelineItem } from '../../lib/types';
import { activityLabel, deriveActivity } from '../../lib/activity';
import { groupHeadline, pinned, summarizeActivity } from '../../lib/turnActivity';
import { fmtDuration } from '../../lib/format';
import { FindSelection, RevealStep, findId } from '../../lib/conversationFind';
import { SPRING } from '../../lib/motion';
import { TimelineEntry } from './TimelineItems';
import { tr } from '../../i18n';

/**
 * Grupo compacto de operaciones técnicas consecutivas, igual para Claude Code y Codex. Los mensajes
 * de progreso del agente no entran aquí: se muestran en la conversación, entre los grupos.
 * - Contraído por defecto: un resumen («3 archivos consultados», «1 archivo modificado · 2 comandos ejecutados»).
 * - Si es el último tramo de un turno en curso: «Trabajando · Editando archivos» y la operación actual debajo.
 * - Los fallos y los rechazos se ven siempre, aunque el grupo esté contraído.
 * - Al desplegar: todas las entradas reales en orden, con salidas, diffs, duraciones y errores.
 *
 * `run` solo lo recibe el grupo que está en curso; `turnLive` indica que el turno sigue activo.
 */
export function TurnActivity({ items, run, turnLive = !!run, messageId }: { items: TimelineItem[]; run?: RunView; turnLive?: boolean; messageId: string }) {
  const live = !!run;
  const selection = useContext(FindSelection);
  const reveal = selection !== null && items.some((item) => findId(messageId, item.id) === selection);
  const [open, setOpen] = useState(false);
  const summary = useMemo(() => summarizeActivity(items), [items]);
  // Al terminar el turno los grupos vuelven a su resumen; mientras sigue, lo que el usuario abrió se respeta.
  useEffect(() => { if (!turnLive) setOpen(false); }, [turnLive]);
  if (!items.length && !live) return null;

  const expanded = open || reveal;
  const current = live ? items[items.length - 1] : undefined;
  const status = live && run ? activityLabel(run, deriveActivity(run, undefined, 0)).label : null;
  // Contraída: en curso se ve la última entrada; terminada, solo lo que no debe quedar oculto.
  const visible = expanded ? items : items.filter((item) => pinned(item) || (live && item === current));
  const failed = summary.failed + summary.declined;
  return (
    <div className="activity" data-live={live || undefined} data-open={expanded || undefined}>
      <button type="button" className="activity-head" onClick={() => setOpen((value) => !value)} aria-expanded={expanded}
        disabled={!items.length}>
        <span className="activity-ic" aria-hidden>{live ? <span className="activity-pulse" /> : <Layers size={13} />}</span>
        <span className="activity-title">
          {live ? <><strong className="live-text">{tr('Trabajando')}</strong>{status && <span> · {status}</span>}</>
            : <strong>{groupHeadline(summary)}</strong>}
        </span>
        {live && summary.operations > 0 && <span className="activity-count">{summary.operations === 1 ? tr('1 operación') : tr('{n} operaciones', { n: summary.operations })}</span>}
        {failed > 0 && <span className="activity-alert"><CircleAlert size={12} aria-hidden /> {failed === 1 ? tr('1 incidencia') : tr('{n} incidencias', { n: failed })}</span>}
        {!live && summary.durationMs ? <span className="activity-meta">{fmtDuration(summary.durationMs)}</span> : null}
        {items.length > 0 && <ChevronRight size={13} className="activity-chev" aria-hidden />}
      </button>
      {visible.length > 0 && (
        <motion.div layout="position" transition={reveal ? { duration: 0 } : SPRING.surface} className="activity-list">
          {visible.map((item) => (
            <div className="find-step" key={item.id} data-find-id={findId(messageId, item.id)}>
              <RevealStep.Provider value={selection === findId(messageId, item.id)}>
                <TimelineEntry item={item} live={turnLive} />
              </RevealStep.Provider>
            </div>
          ))}
        </motion.div>
      )}
    </div>
  );
}
