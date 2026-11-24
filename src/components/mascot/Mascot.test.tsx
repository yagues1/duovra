import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Mascot } from './Mascot';
import { Brain } from './engine/brain';
import { fromActivity, STATES, type MascotState } from './engine/states';
import { ACTIVITIES } from '../../lib/activity';

describe('estados del personaje', () => {
  it('traduce cada actividad real de 1.0.6 a un estado del personaje', () => {
    const seen = ACTIVITIES.map((a) => fromActivity(a));
    expect(seen).toEqual(['idle', 'thinking', 'streaming', 'reading', 'editing', 'command', 'permission', 'done', 'error']);
    expect(fromActivity('thinking', { phase: 'starting' })).toBe('preparing');
    expect(fromActivity('tools', { stopping: true })).toBe('cancelled');
  });

  it('el permiso y el error mandan sobre cualquier reacción decorativa', () => {
    const decorative = Object.entries(STATES).filter(([, s]) => s.play > .5).map(([k]) => k as MascotState);
    for (const k of decorative) {
      expect(STATES.permission.priority).toBeGreaterThan(STATES[k].priority);
      expect(STATES.error.priority).toBeGreaterThan(STATES[k].priority);
    }
    expect(STATES.permission.play).toBe(0);
    expect(STATES.error.play).toBe(0);
  });
});

describe('cerebro', () => {
  const run = (b: Brain, seconds: number) => { let f = b.update(0); for (let t = 0; t < seconds; t += 1 / 60) f = b.update(1 / 60); return f; };

  it('con un permiso pendiente el clic solo reconoce, no juega', () => {
    const b = new Brain('claude', { autoSleep: false });
    b.setState('permission');
    run(b, 1);
    const before = run(b, 0).y;
    b.click();
    const after = run(b, .15);
    // El rebote del clic desplaza más de 1 unidad; el reconocimiento apenas mueve el cuerpo.
    expect(Math.abs(after.y - before)).toBeLessThan(1);
  });

  it('se duerme tras la inactividad solo en reposo y despierta con una señal real', () => {
    const b = new Brain('codex', { sleepAfter: 1 });
    run(b, 1.5);
    expect(b.state).toBe('sleep');
    b.setState('thinking');
    expect(b.state).toBe('thinking');
    run(b, 3);
    expect(b.state).toBe('thinking');
  });

  it('con movimiento reducido no hay bucles ambientales ni parpadeos', () => {
    const b = new Brain('claude', { reduced: true, autoSleep: false });
    const a = run(b, 2);
    const c = run(b, 1.3);
    expect(c.y).toBeCloseTo(a.y, 5);
    expect(c.blink).toBe(0);
  });
});

describe('componente', () => {
  it('expone el estado y es fijo por debajo de 40 px', () => {
    const small = renderToStaticMarkup(<Mascot agent="codex" state="idle" size={24} />);
    expect(small).toContain('data-s="idle"');
    expect(small).toContain('data-static');
    expect(small).toContain('aria-hidden="true"');
    const big = renderToStaticMarkup(<Mascot agent="claude" state="waiting" size={62} />);
    expect(big).toContain('data-s="permission"');
    expect(big).not.toContain('data-static');
  });

  it('acepta un estado decidido por el contenedor y una etiqueta accesible', () => {
    const html = renderToStaticMarkup(<Mascot agent="claude" state="idle" override="typing" size={150} label="Aura" />);
    expect(html).toContain('data-s="typing"');
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Aura"');
  });
});
