import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { ActivityView } from '../../hooks/useActivity';
import { TURN_LABEL } from '../../lib/activity';
import type { AgentId } from '../../lib/types';
import { useTr } from '../../i18n';
import { Mascot } from './Mascot';
import type { Brain } from './engine/brain';
import { fromActivity, STATES, type MascotState } from './engine/states';

/** Tamaño de la mascota en la conversación vacía (debe coincidir con `.mascot-hero-anchor`). */
export const HERO_SIZE = 176;
const STAGE_MAX = 150;
const STAGE_MIN = 96;
const PERCH = 84;
/** Fracción del alto del SVG en la que el personaje apoya los pies (y ≈ 108/120). */
const FEET = .905;

/**
 * Anfitrión (1.0.7): una sola mascota viva y grande por conversación.
 * - Conversación vacía: preside el centro, sobre el hueco `[data-mascot-anchor]` del estado vacío.
 * - Con mensajes: vive en un escenario a la derecha del compositor, de pie sobre un suelo de luz del
 *   color del estado, y cuenta lo que hace en un bocadillo. Si no hay sitio (ventana estrecha o
 *   Workbench abierto), se posa en el borde del compositor.
 * La posición se escribe en el DOM (sin renders de React por movimiento) y viaja con un muelle CSS.
 * Todo lo que dice sale de la actividad real; la escritura del usuario y la selección de agente son
 * señales locales del compositor.
 */
export function MascotHost({ view, agent, empty, stage, input }: {
  view: ActivityView;
  agent: AgentId;
  empty: boolean;
  stage: RefObject<HTMLElement | null>;
  input: RefObject<HTMLTextAreaElement | null>;
}) {
  const tr = useTr();
  const layer = useRef<HTMLDivElement>(null);
  const actor = useRef<HTMLDivElement>(null);
  const floor = useRef<HTMLDivElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const brain = useRef<Brain | null>(null);
  const [typing, setTyping] = useState(false);
  const [selected, setSelected] = useState(false);
  const [size, setSize] = useState(empty ? HERO_SIZE : STAGE_MAX);

  const active = view.activity !== 'idle' && view.agent !== null;
  const who = active ? view.agent! : agent;
  const state: MascotState = active
    ? fromActivity(view.activity, { phase: view.label === TURN_LABEL.preparing ? 'starting' : undefined, stopping: view.stopping })
    : selected ? 'selected' : typing ? 'typing' : 'idle';
  const tone = STATES[state].tone;
  const speech = active ? { label: view.label, detail: view.detail } : typing ? { label: tr('Te escucho…'), detail: null } : null;

  // Escritura del usuario: atención y un asentimiento de vez en cuando.
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    let timer = 0;
    const onInput = () => {
      brain.current?.keystroke();
      setTyping(el.value.trim().length > 0);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setTyping(false), 1600);
    };
    el.addEventListener('input', onInput);
    return () => { el.removeEventListener('input', onInput); window.clearTimeout(timer); };
  }, [input]);

  // Cambio de agente en el compositor: saludo breve del recién elegido.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    setSelected(true);
    const timer = window.setTimeout(() => setSelected(false), 900);
    return () => window.clearTimeout(timer);
  }, [agent]);

  // Colocación
  const sizeRef = useRef(size);
  useLayoutEffect(() => {
    const root = stage.current;
    if (!root) return;
    let frame = 0;
    const place = () => {
      frame = 0;
      const el = actor.current, fl = floor.current, bb = bubble.current;
      const composer = root.querySelector<HTMLElement>('.composer');
      if (!el || !fl || !bb || !composer) return;
      const sr = root.getBoundingClientRect();
      const cr = composer.getBoundingClientRect();
      const anchor = empty ? root.querySelector<HTMLElement>('[data-mascot-anchor]') : null;
      let s: number, x: number, y: number, ground = true;
      if (anchor) {
        const ar = anchor.getBoundingClientRect();
        s = HERO_SIZE;
        x = ar.left - sr.left + (ar.width - s) / 2;
        y = ar.top - sr.top + (ar.height - s) / 2;
      } else {
        const room = sr.right - cr.right;
        if (room >= STAGE_MIN + 28) {
          s = Math.min(STAGE_MAX, room - 28);
          x = cr.right - sr.left + (room - s) / 2;
          y = cr.bottom - sr.top - s * FEET;
        } else {
          s = PERCH;
          x = cr.right - sr.left - s - 18;
          y = cr.top - sr.top - s * FEET;
          ground = false;
        }
      }
      el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
      if (s !== sizeRef.current) { sizeRef.current = s; setSize(s); }
      fl.hidden = !ground;
      fl.style.width = `${Math.round(s * 1.7)}px`;
      fl.style.transform = `translate(${Math.round(x + s / 2 - s * .85)}px, ${Math.round(y + s * FEET - 13)}px)`;
      bb.style.right = `${Math.round(sr.width - (x + s * .3))}px`;
      bb.style.top = `${Math.round(y + s * .12)}px`;
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(place); };
    // Primera colocación sin viaje: la mascota aparece en su sitio, no cruza desde la esquina.
    const els = [actor.current, floor.current, bubble.current];
    for (const e of els) if (e) e.style.transition = 'none';
    place();
    const restore = requestAnimationFrame(() => requestAnimationFrame(() => { for (const e of els) if (e) e.style.transition = ''; }));
    const ro = new ResizeObserver(schedule);
    ro.observe(root);
    const composer = root.querySelector('.composer');
    if (composer) ro.observe(composer);
    const scroller = root.querySelector('.chat-scroll');
    scroller?.addEventListener('scroll', schedule, { passive: true });
    return () => { ro.disconnect(); scroller?.removeEventListener('scroll', schedule); cancelAnimationFrame(frame); cancelAnimationFrame(restore); };
  }, [stage, empty]);

  return (
    <div ref={layer} className="mascot-host" data-agent={who} data-tone={tone} data-empty={empty || undefined} aria-hidden>
      <div ref={floor} className="mascot-floor" style={{ opacity: active ? 1 : state === 'idle' ? .55 : .7 }} />
      <div ref={actor} className="mascot-actor">
        <Mascot key={who} agent={who} state="idle" override={state} size={size} brainRef={brain} />
      </div>
      <div ref={bubble} className="mascot-bubble" data-empty={speech ? undefined : ''}>
        {speech && <strong>{speech.label}</strong>}
        {speech?.detail && <span>{speech.detail}</span>}
      </div>
    </div>
  );
}
