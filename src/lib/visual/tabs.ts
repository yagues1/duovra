import { useStore } from '../../state/store';
import { VISUAL_LABEL, type VisualSource } from './types';

export function openVisualTab(source: VisualSource, title = VISUAL_LABEL[source.kind]) {
  const state = useStore.getState();
  const existing = state.panel.tabs.find((tab) =>
    tab.kind === 'visual' && tab.title === title && tab.payload.conversationId === state.activeConversationId
    && tab.payload.source.kind === source.kind && tab.payload.source.text === source.text,
  );
  if (existing) {
    state.openTab(existing);
    return;
  }
  state.openTab({
    id: 'visual:' + crypto.randomUUID(),
    kind: 'visual',
    title,
    payload: { source, conversationId: state.activeConversationId, returnTo: state.panel.active },
  });
}
