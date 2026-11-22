/* Partes Copyright (c) 2026 Leonxlnx, MIT. Véase public/licenses/Visual-effects-MIT.txt. */
/**
 * Campos de luz fuera del hilo principal. Un único worker dibuja todos los campos de
 * la página (la conversación, la vista previa de Apariencia y las miniaturas de los presets), cada
 * uno en su OffscreenCanvas y con su id. La página envía tamaños, apariencia, puntero y si cada campo
 * puede moverse; el worker solo responde «primer fotograma» y los cambios de calidad.
 * Duovra conserva su semántica: un campo detenido redibuja un fotograma al instante al cambiar
 * de apariencia (vista previa inmediata sin bucle).
 */
import { FieldEngine, type DitherTexture, type FieldBeat, type Look, type Metrics } from './field';

export type FieldMessage =
  | { type: 'init'; id: number; canvas: OffscreenCanvas; look: Look; texture: DitherTexture }
  | { type: 'resize'; id: number; metrics: Metrics; texture: DitherTexture; atlas?: ImageBitmap }
  | { type: 'look'; id: number; look: Look }
  | { type: 'beat'; id: number; kind: FieldBeat; x: number; y: number; strength: number }
  | { type: 'state'; id: number; running: boolean }
  | { type: 'rest'; id: number; rest: boolean }
  | { type: 'pressure'; id: number; ms: number }
  | { type: 'pointer'; id: number; p: [number, number] | null }
  | { type: 'dispose'; id: number };

export type FieldReply = { id: number; type: 'ready' } | { id: number; type: 'quality'; level: number };

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<FieldMessage>) => void) | null;
  postMessage: (reply: FieldReply) => void;
};
const engines = new Map<number, { engine: FieldEngine; running: boolean }>();

scope.onmessage = ({ data }) => {
  if (data.type === 'init') {
    const { id } = data;
    const engine = FieldEngine.create(data.canvas, data.texture, data.look, {
      frame: (first) => { if (first) scope.postMessage({ id, type: 'ready' }); },
      quality: (level) => scope.postMessage({ id, type: 'quality', level }),
    });
    if (!engine) throw new Error('Canvas 2D no disponible en el worker');
    engines.set(id, { engine, running: false });
    return;
  }
  const entry = engines.get(data.id);
  if (!entry) return;
  const { engine } = entry;
  switch (data.type) {
    case 'resize': engine.resize(data.metrics, data.atlas, data.texture); break;
    case 'look': engine.setLook(data.look, !entry.running); break;
    case 'beat': engine.beat(data.kind, data.x, data.y, data.strength); break;
    case 'state': entry.running = data.running; engine.setState(data.running, data.running); break;
    case 'rest': engine.setRest(data.rest); break;
    case 'pressure': engine.setPressure(data.ms); break;
    case 'pointer': engine.setPointer(data.p); break;
    case 'dispose': engine.dispose(); engines.delete(data.id); break;
  }
};
