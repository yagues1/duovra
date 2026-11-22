import { useEffect, useState } from 'react';
import { renderVisual, type VisualResult } from '../../lib/visual/render';
import type { VisualKind } from '../../lib/visual/types';

export function useVisual(kind: VisualKind, source: string, enabled: boolean, revision = 0) {
  const [snapshot, setSnapshot] = useState<{ kind: VisualKind; source: string; revision: number; result: VisualResult }>();
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void renderVisual(kind, source, revision > 0).then((result) => {
      if (active) setSnapshot({ kind, source, revision, result });
    });
    return () => { active = false; };
  }, [kind, source, enabled, revision]);
  return snapshot?.kind === kind && snapshot.source === source && snapshot.revision === revision ? snapshot.result : undefined;
}
