import { useEffect } from 'react';
import type { AgentId } from '../lib/types';
import { ensureCatalog, useStore } from '../state/store';

export function useAgentCatalog(agent: AgentId, enabled = true) {
  const catalog = useStore((s) => s.catalogs[agent]);
  useEffect(() => {
    if (enabled) ensureCatalog(agent);
  }, [agent, enabled]);
  return catalog;
}
