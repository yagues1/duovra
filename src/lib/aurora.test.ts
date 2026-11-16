import { afterEach, expect, it, vi } from 'vitest';
import { createAurora } from './aurora';
import type { GlassSource } from './background';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const lenses: GlassSource = { max: 12, read: () => 0, tracking: () => false, near: () => false, subscribe: () => () => undefined };

function setup(webgl2: boolean, floatTargets = false) {
  vi.useFakeTimers();
  const gl: Record<string, any> = {
    COMPILE_STATUS: 1, LINK_STATUS: 2, TIMEOUT_EXPIRED: 3, WAIT_FAILED: 4, FRAMEBUFFER: 5, FRAMEBUFFER_COMPLETE: 6,
    getExtension: vi.fn(() => (floatTargets ? {} : null)), checkFramebufferStatus: () => 6,
    createTexture: vi.fn(() => ({})), createFramebuffer: vi.fn(() => ({})),
    createShader: vi.fn(() => ({})), createProgram: vi.fn(() => ({})), createBuffer: vi.fn(() => ({})),
    getShaderParameter: () => true, getProgramParameter: () => true, getUniformLocation: (_: unknown, name: string) => name,
    fenceSync: vi.fn(() => ({})), clientWaitSync: vi.fn(() => 5),
    readPixels: vi.fn((_x, _y, _w, _h, _f, _t, dest) => { if (dest instanceof Uint8Array) dest.set([10, 20, 30, 255]); }),
    getBufferSubData: vi.fn((_target, _offset, dest) => dest.set([10, 20, 30, 255])),
  };
  for (const method of ['shaderSource', 'compileShader', 'attachShader', 'linkProgram', 'useProgram', 'bindBuffer', 'bufferData',
    'enableVertexAttribArray', 'vertexAttribPointer', 'uniform1f', 'uniform2f', 'uniform3f', 'uniform4fv', 'uniform1fv',
    'drawArrays', 'viewport', 'deleteShader', 'deleteProgram', 'deleteBuffer', 'deleteSync', 'flush', 'bindAttribLocation', 'uniform1i',
    'bindTexture', 'activeTexture', 'texParameteri', 'texImage2D', 'bindFramebuffer', 'framebufferTexture2D', 'deleteTexture',
    'deleteFramebuffer']) gl[method] = vi.fn();
  gl.getAttribLocation = () => 0;
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.set(++id, cb); return id; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('window', { innerWidth: 1360, innerHeight: 860, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    setTimeout, clearTimeout });
  vi.stubGlobal('document', { hidden: false, hasFocus: () => true, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  const listeners = new Map<string, (e: Event) => void>();
  const canvas = { width: 0, height: 0, getContext: (name: string) => name === 'webgl2' && !webgl2 ? null : gl,
    addEventListener: vi.fn((type: string, cb: (e: Event) => void) => listeners.set(type, cb)),
    removeEventListener: vi.fn((type: string) => listeners.delete(type)) };
  const fire = (type: string) => listeners.get(type)?.({ preventDefault: vi.fn() } as unknown as Event);
  return { gl, frames, fire, listeners, aurora: createAurora(canvas as unknown as HTMLCanvasElement, lenses)! };
}

it('lee los mismos canales por WebGL1, sin exigir WebGL2', () => {
  const { aurora } = setup(false);
  const cb = vi.fn();
  aurora.sample([[100, 100]], cb);
  expect(cb).toHaveBeenCalledWith([[10, 20, 30]]);
  aurora.destroy();
});

it('no espera a la GPU y entrega la muestra solo después de la señal', () => {
  const { gl, aurora } = setup(true);
  const cb = vi.fn();
  gl.clientWaitSync.mockReturnValueOnce(gl.TIMEOUT_EXPIRED);
  aurora.sample([[100, 100]], cb);
  expect(typeof gl.readPixels.mock.calls[0][6]).toBe('number');
  expect(cb).not.toHaveBeenCalled();
  vi.advanceTimersByTime(16);
  expect(gl.getBufferSubData).not.toHaveBeenCalled();
  expect(gl.clientWaitSync.mock.calls[0].slice(1)).toEqual([0, 0]);
  vi.advanceTimersByTime(16);
  expect(cb).toHaveBeenCalledWith([[10, 20, 30]]);
  aurora.destroy();
});

it('libera recursos, el muestreo pendiente y el redraw al desmontar', () => {
  const { gl, aurora, frames } = setup(true);
  const cb = vi.fn();
  aurora.sample([[10, 10]], cb);
  aurora.setLens(1);
  expect(frames.size).toBe(1);
  aurora.destroy();
  vi.runAllTimers();
  expect(frames.size).toBe(0);
  expect(cb).not.toHaveBeenCalled();
  expect(gl.deleteShader).toHaveBeenCalledTimes(2);
  expect(gl.deleteProgram).toHaveBeenCalledTimes(1);
  expect(gl.deleteBuffer).toHaveBeenCalledTimes(2);
  expect(gl.deleteSync).toHaveBeenCalledTimes(1);
});

it('recrea los recursos y vuelve a dibujar al restaurarse el contexto WebGL', () => {
  const { gl, frames, fire, aurora } = setup(true);
  aurora.setFps(30);
  expect(frames.size).toBe(1);
  fire('webglcontextlost');
  expect(frames.size).toBe(0);
  const programs = gl.createProgram.mock.calls.length;
  const draws = gl.drawArrays.mock.calls.length;
  // Mientras está perdido no se dibuja ni se reanuda el bucle.
  aurora.setLook({ palette: 'glaciar', gain: 1, speed: 1 });
  expect(gl.drawArrays.mock.calls.length).toBe(draws);
  fire('webglcontextrestored');
  expect(gl.createProgram.mock.calls.length).toBe(programs + 1);
  expect(gl.drawArrays.mock.calls.length).toBe(draws + 1);
  expect(frames.size).toBe(1);
  // El aspecto elegido durante la pérdida se conserva tras restaurar.
  expect(gl.uniform3f).toHaveBeenCalledWith('uK1a', 0.3, 0.85, 1.0);
  aurora.destroy();
});

it('usa el pase por columnas con texturas flotantes y lo libera al desmontar', () => {
  const { gl, aurora, listeners } = setup(true, true);
  // Programa principal + pase por columnas; dos dibujos por fotograma.
  expect(gl.createProgram).toHaveBeenCalledTimes(2);
  expect(gl.drawArrays).toHaveBeenCalledTimes(2);
  expect(gl.uniform1f).toHaveBeenCalledWith('uUseCol', 1);
  aurora.destroy();
  expect(gl.deleteProgram).toHaveBeenCalledTimes(2);
  expect(gl.deleteShader).toHaveBeenCalledTimes(4);
  expect(gl.deleteTexture).toHaveBeenCalledTimes(1);
  expect(gl.deleteFramebuffer).toHaveBeenCalledTimes(1);
  expect(listeners.size).toBe(0);
});

it('sin texturas flotantes renderizables calcula todo por píxel', () => {
  const { gl, aurora } = setup(false, false);
  expect(gl.createProgram).toHaveBeenCalledTimes(1);
  expect(gl.drawArrays).toHaveBeenCalledTimes(1);
  expect(gl.uniform1f).not.toHaveBeenCalledWith('uUseCol', 1);
  aurora.destroy();
});
