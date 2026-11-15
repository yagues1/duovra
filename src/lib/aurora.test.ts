import { afterEach, expect, it, vi } from 'vitest';
import { createAurora } from './aurora';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

function setup(webgl2: boolean) {
  vi.useFakeTimers();
  const gl: Record<string, any> = {
    COMPILE_STATUS: 1, LINK_STATUS: 2, TIMEOUT_EXPIRED: 3, WAIT_FAILED: 4,
    createShader: vi.fn(() => ({})), createProgram: vi.fn(() => ({})), createBuffer: vi.fn(() => ({})),
    getShaderParameter: () => true, getProgramParameter: () => true, getUniformLocation: (_: unknown, name: string) => name,
    fenceSync: vi.fn(() => ({})), clientWaitSync: vi.fn(() => 5),
    readPixels: vi.fn((_x, _y, _w, _h, _f, _t, dest) => { if (dest instanceof Uint8Array) dest.set([10, 20, 30, 255]); }),
    getBufferSubData: vi.fn((_target, _offset, dest) => dest.set([10, 20, 30, 255])),
  };
  for (const method of ['shaderSource', 'compileShader', 'attachShader', 'linkProgram', 'useProgram', 'bindBuffer', 'bufferData',
    'enableVertexAttribArray', 'vertexAttribPointer', 'uniform1f', 'uniform2f', 'uniform3f', 'uniform4fv', 'uniform1fv',
    'drawArrays', 'viewport', 'deleteShader', 'deleteProgram', 'deleteBuffer', 'deleteSync', 'flush']) gl[method] = vi.fn();
  gl.getAttribLocation = () => 0;
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.set(++id, cb); return id; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('window', { innerWidth: 1360, innerHeight: 860, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    setTimeout, clearTimeout });
  vi.stubGlobal('document', { hidden: false, hasFocus: () => true, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  const canvas = { width: 0, height: 0, getContext: (name: string) => name === 'webgl2' && !webgl2 ? null : gl,
    addEventListener: vi.fn(), removeEventListener: vi.fn() };
  return { gl, frames, aurora: createAurora(canvas as unknown as HTMLCanvasElement)! };
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
