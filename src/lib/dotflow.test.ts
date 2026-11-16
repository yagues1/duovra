import { afterEach, expect, it, vi } from 'vitest';
import { createDotFlow, FLOW, gridFor, pruneWaves, WAVE_PRESETS, waveRadius } from './dotflow';
import type { GlassSource, ReadingSource } from './background';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('el frente de la onda crece siempre y frena hacia el final', () => {
  const p = WAVE_PRESETS.normal;
  let last = -1;
  let lastStep = Infinity;
  for (let i = 1; i <= 40; i++) {
    const a = (p.duration * i) / 40;
    const r = waveRadius(a, p);
    expect(r).toBeGreaterThan(last);
    const step = r - last;
    if (i > 1) expect(step).toBeLessThanOrEqual(lastStep + 1e-9);
    lastStep = step;
    last = r;
  }
  expect(waveRadius(-1, p)).toBe(0);
  expect(waveRadius(p.duration * 3, p)).toBe(waveRadius(p.duration, p));
});

it('Sutil, Media y Viva escalan todos los rasgos de la onda en el mismo sentido', () => {
  const keys = ['speed', 'band', 'duration', 'accent', 'wake', 'push', 'bright'] as const;
  for (const k of keys) {
    expect(WAVE_PRESETS.subtle[k]).toBeLessThan(WAVE_PRESETS.normal[k]);
    expect(WAVE_PRESETS.normal[k]).toBeLessThan(WAVE_PRESETS.vivid[k]);
  }
});

it('la matriz usa píxeles enteros del dispositivo y cubre la ventana con margen', () => {
  for (const dpr of [1, 1.25, 1.5, 2]) {
    const g = gridFor(1440, 900, dpr);
    expect(Number.isInteger(g.pitchDev)).toBe(true);
    expect(g.cols * g.pitchDev).toBeGreaterThanOrEqual(1440 * dpr + g.pitchDev);
    expect(g.rows * g.pitchDev).toBeGreaterThanOrEqual(900 * dpr + g.pitchDev);
  }
  expect(gridFor(1440, 900, 1).pitchDev).toBe(FLOW.pitch);
});

it('las ondas terminadas se descartan y nunca hay más de las permitidas', () => {
  const waves = Array.from({ length: 12 }, (_, i) => ({ t0: i * 0.1 }));
  const alive = pruneWaves(waves, 1.15, 3, FLOW.maxWaves);
  expect(alive.length).toBe(FLOW.maxWaves);
  expect(alive.at(-1)!.t0).toBeCloseTo(1.1);
  expect(pruneWaves(waves, 10, 3)).toEqual([]);
});

const glass: GlassSource = { max: 12, read: () => 0, tracking: () => false, near: () => false, subscribe: () => () => undefined };
const reading: ReadingSource = { read: () => null, subscribe: () => () => undefined };

function setup() {
  let now = 1000;
  vi.stubGlobal('performance', { now: () => now });
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frames.set(++id, cb);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (i: number) => frames.delete(i));
  vi.stubGlobal('window', { innerWidth: 1200, innerHeight: 800, devicePixelRatio: 1, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('document', { hidden: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  const gl: Record<string, any> = {
    COMPILE_STATUS: 1, LINK_STATUS: 2, getShaderParameter: () => true, getProgramParameter: () => true,
    getUniformLocation: (_: unknown, n: string) => n, createShader: () => ({}), createProgram: () => ({}),
    createBuffer: () => ({}), createVertexArray: () => ({}), createTexture: () => ({}), createFramebuffer: () => ({}),
  };
  for (const m of ['shaderSource', 'compileShader', 'attachShader', 'bindAttribLocation', 'linkProgram', 'useProgram', 'bindVertexArray',
    'bindBuffer', 'bufferData', 'enableVertexAttribArray', 'vertexAttribPointer', 'bindTexture', 'texParameteri', 'texImage2D',
    'bindFramebuffer', 'framebufferTexture2D', 'drawBuffers', 'viewport', 'uniform1i', 'uniform1f', 'uniform2f', 'uniform3f', 'uniform4f',
    'uniform4fv', 'activeTexture', 'drawArrays', 'deleteTexture', 'deleteFramebuffer', 'deleteBuffer', 'deleteVertexArray', 'deleteProgram',
    'deleteShader']) gl[m] = vi.fn();
  const canvas = { width: 0, height: 0, getContext: (n: string) => (n === 'webgl2' ? gl : null), addEventListener: vi.fn(), removeEventListener: vi.fn() };
  const flow = createDotFlow(canvas as unknown as HTMLCanvasElement, { glass, reading })!;
  const run = (ms: number) => {
    // Ejecuta los fotogramas pendientes avanzando el reloj 16 ms por fotograma.
    let n = 0;
    for (let t = 0; t < ms; t += 16) {
      now += 16;
      const pending = [...frames.entries()];
      frames.clear();
      for (const [, cb] of pending) {
        cb(now);
        n++;
      }
    }
    return n;
  };
  return { gl, flow, frames, run };
}

it('en reposo no dibuja: un fotograma al crearse y ninguno más', () => {
  const { gl, frames, run, flow } = setup();
  flow.setFps(60);
  const draws = gl.drawArrays.mock.calls.length;
  run(200);
  expect(frames.size).toBe(0);
  // setFps solo programa un fotograma para aplicar el estado.
  expect(gl.drawArrays.mock.calls.length - draws).toBeLessThanOrEqual(2);
  flow.destroy();
});

it('un clic anima la onda y el bucle se detiene solo cuando termina', () => {
  const { gl, frames, run, flow } = setup();
  flow.setFps(60);
  run(100);
  flow.pulse(400, 300);
  const before = gl.drawArrays.mock.calls.length;
  const n = run(WAVE_PRESETS.normal.duration * 1000 + 300);
  expect(n).toBeGreaterThan(150);
  expect(gl.drawArrays.mock.calls.length - before).toBe(n * 2); // dos pasadas por fotograma
  expect(frames.size).toBe(0);
  flow.destroy();
});

it('con el fondo animado apagado los clics no animan nada', () => {
  const { frames, run, flow } = setup();
  flow.setFps(0);
  run(50);
  flow.pulse(400, 300);
  expect(run(500)).toBe(0);
  expect(frames.size).toBe(0);
  flow.destroy();
});

it('sin WebGL 2 no hay renderizador (Background usa la matriz CSS)', () => {
  vi.stubGlobal('window', { innerWidth: 100, innerHeight: 100, addEventListener: vi.fn() });
  const canvas = { getContext: () => null };
  expect(createDotFlow(canvas as unknown as HTMLCanvasElement, { glass, reading })).toBeNull();
});
