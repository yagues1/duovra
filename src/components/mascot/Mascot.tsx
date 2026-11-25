import { memo, useEffect, useRef, type CSSProperties, type RefObject } from 'react';
import type { AgentId } from '../../lib/types';
import type { Activity } from '../../lib/activity';
import { Brain } from './engine/brain';
import { createCharacter, fixedCharacter } from './engine/characters';
import { changed, register, unregister, type Live } from './engine/loop';
import { fromActivity, type MascotState } from './engine/states';

/**
 * Mascotas 2.0 (1.0.7): Aura (Claude Code) y Flujo (Codex).
 *
 * React solo monta el SVG una vez por agente y le pasa el estado; el bucle de `engine/loop` escribe
 * los atributos por fotograma, sin renders de React. Por debajo de 40 px, o con `animated={false}`,
 * la pose es fija y la mascota no entra en el bucle.
 */
export const Mascot = memo(function Mascot({ agent, state, size, animated = true, className, label, phase, stopping, override, brainRef, style }: {
  agent: AgentId;
  state: Activity;
  size: number;
  animated?: boolean;
  className?: string;
  label?: string;
  /** Fase real del turno que matiza la pose (p. ej. `starting` mientras se prepara la ejecución). */
  phase?: 'starting';
  /** El usuario ha pedido detener el turno. */
  stopping?: boolean;
  /** Estado del personaje cuando lo decide el contenedor (escritura del usuario, selección…). */
  override?: MascotState;
  /** Acceso al cerebro para reacciones locales (pulsaciones del compositor). */
  brainRef?: RefObject<Brain | null>;
  style?: CSSProperties;
}) {
  const host = useRef<HTMLSpanElement>(null);
  const liveRef = useRef<Live | null>(null);
  const target = override ?? fromActivity(state, { phase, stopping });
  const fixed = !animated || size < 40;
  const targetRef = useRef(target);
  targetRef.current = target;
  const sizeRef = useRef(size);
  sizeRef.current = size;

  useEffect(() => {
    if (!fixed || !host.current) return;
    const svg = fixedCharacter(agent, target, size);
    host.current.appendChild(svg);
    return () => svg.remove();
  }, [agent, fixed, size, target]);

  useEffect(() => {
    const el = host.current;
    if (!el || fixed) return;
    const char = createCharacter(agent);
    const brain = new Brain(agent);
    brain.setState(targetRef.current, true);
    char.setLOD(sizeRef.current);
    el.appendChild(char.svg);
    const m = register(char, brain);
    liveRef.current = m;
    if (brainRef) brainRef.current = brain;
    const click = () => { brain.click(); changed(m); };
    char.svg.addEventListener('click', click);
    return () => {
      char.svg.removeEventListener('click', click);
      unregister(m);
      char.svg.remove();
      liveRef.current = null;
      if (brainRef?.current === brain) brainRef.current = null;
    };
  }, [agent, fixed, brainRef]);

  useEffect(() => {
    const m = liveRef.current;
    if (!m) return;
    m.brain.setState(target);
    changed(m);
  }, [target]);

  useEffect(() => { liveRef.current?.char.setLOD(size); }, [size]);

  return (
    <span ref={host} className={['mascot', className].filter(Boolean).join(' ')} data-agent={agent} data-s={target}
      data-static={fixed ? '' : undefined} style={{ width: size, height: size, ...style }}
      role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} />
  );
});
