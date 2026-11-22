import { BACKGROUND_KEY, backgroundImageId, backgroundPreferences, type BackgroundPreferences } from '../lib/background';
import { releaseBackgroundImages } from '../lib/backgroundImages';
import { api, errorText } from '../lib/ipc';
import { useStore } from './store';

function imageIds({ active, presets }: BackgroundPreferences) {
  return [active.config, ...presets.map((preset) => preset.config)].flatMap((config) => {
    const id = backgroundImageId(config);
    return id ? [id] : [];
  });
}

export async function releaseBackgroundDrafts(ids: readonly string[]) {
  if (!ids.length) return;
  try {
    await releaseBackgroundImages([...new Set(ids)]);
  } catch (error) {
    useStore.getState().toast(`No se pudo liberar una copia de fondo. ${errorText(error)}`, 'error');
  }
}

let pending = Promise.resolve();

/** Publica el estado en la interfaz cuando SQLite confirma el cambio. */
export function saveBackgroundPreferences(update: (current: BackgroundPreferences) => BackgroundPreferences) {
  const write = pending.then(async () => {
    const previous = backgroundPreferences(useStore.getState().settings);
    const next = update(previous);
    await api.setSetting(BACKGROUND_KEY, next);
    useStore.setState((state) => ({ settings: { ...state.settings, [BACKGROUND_KEY]: next }, savedPulse: state.savedPulse + 1 }));
    const retained = new Set(imageIds(next));
    void releaseBackgroundDrafts(imageIds(previous).filter((id) => !retained.has(id)));
    return next;
  });
  pending = write.then(() => {}, () => {});
  return write;
}
