import { describe, expect, it } from 'vitest';
import { contextText, detectedUrls, fitViewport, isLocalUrl, loadErrorText, localUrls, normalizeAddress, refAttachments, DEFAULT_VIEWPORT, type ElementInfo, type PreviewRef } from './livePreview';
import type { Message } from './types';

const info: ElementInfo = {
  tag: 'button', id: null, classes: ['btn', 'primary'], text: 'Comprar', selector: 'main > button.btn.primary', unique: true,
  attrs: { type: 'button' }, styles: { 'font-size': '16px' }, html: '<button class="btn primary">Comprar</button>',
  rect: { x: 10, y: 20, width: 120, height: 40 }, viewport: { width: 390, height: 844, dpr: 2 },
  hasParent: true, hasChild: false, frameworks: [], component: null, source: null, url: 'http://localhost:5173/',
};

describe('Live Preview', () => {
  it('detecta solo direcciones locales y nunca los orígenes internos de Duovra', () => {
    expect(localUrls('Listo en http://localhost:5173/ y https://example.com')).toEqual(['http://localhost:5173/']);
    expect(localUrls('Network: http://0.0.0.0:3000.')).toEqual(['http://localhost:3000']);
    expect(localUrls('http://tauri.localhost/index.html http://ipc.localhost/x')).toEqual([]);
    expect(isLocalUrl('http://127.0.0.1:8080')).toBe(true);
    expect(isLocalUrl('https://example.com')).toBe(false);
  });

  it('normaliza direcciones escritas y rechaza esquemas peligrosos', () => {
    expect(normalizeAddress('localhost:3000')).toBe('http://localhost:3000/');
    expect(normalizeAddress('file:///C:/Windows/win.ini')).toBeNull();
    expect(normalizeAddress('javascript:alert(1)')).toBeNull();
    expect(normalizeAddress('http://tauri.localhost/')).toBeNull();
    // Un puerto solo apunta al servidor local; un nombre suelto es una dirección incompleta.
    expect(normalizeAddress('5173')).toBe('http://localhost:5173/');
    expect(normalizeAddress(':8080/app')).toBe('http://localhost:8080/app');
    expect(normalizeAddress('jas')).toBeNull();
    expect(normalizeAddress('jas/')).toBeNull();
    expect(normalizeAddress('devbox:3000')).toBe('http://devbox:3000/');
    expect(normalizeAddress('example.com')).toBe('http://example.com/');
    expect(normalizeAddress('[::1]:4000')).toBe('http://[::1]:4000/');
  });

  it('explica los fallos de carga sin exponer el código como único mensaje', () => {
    expect(loadErrorText('net::ERR_CONNECTION_REFUSED', 'http://localhost:5173/')).toContain('localhost:5173');
    expect(loadErrorText('net::ERR_FOO', 'http://localhost:9/')).toContain('localhost:9');
  });

  it('detecta servidores en respuestas y salidas de los agentes sin abrirlos', () => {
    const messages = [
      { role: 'user', content: 'http://localhost:9999', items: null },
      { role: 'assistant', content: 'Arrancado.', items: [{ kind: 'command', output: '  ➜  Local:   http://localhost:5173/' }] },
    ] as unknown as Message[];
    expect(detectedUrls(messages)).toEqual(['http://localhost:5173/']);
  });

  it('ajusta la simulación de tamaño al espacio disponible', () => {
    expect(fitViewport(DEFAULT_VIEWPORT, { width: 500, height: 400 })).toEqual({ width: 500, height: 400, scale: 1 });
    const mobile = fitViewport({ ...DEFAULT_VIEWPORT, mode: 'device', width: 390, height: 844 }, { width: 600, height: 422 });
    expect(mobile).toEqual({ width: 390, height: 844, scale: 0.5 });
    const landscape = fitViewport({ ...DEFAULT_VIEWPORT, mode: 'device', width: 390, height: 844, landscape: true, scale: 1 }, { width: 2000, height: 2000 });
    expect(landscape).toEqual({ width: 844, height: 390, scale: 1 });
  });

  it('marca el contexto de la página como datos y adjunta sus capturas', () => {
    const capture = { path: 'C:/cache/element-1.png', width: 240, height: 80, bytes: 100, kind: 'element' as const, dataUrl: '' };
    const refs: PreviewRef[] = [{ id: 'a', space: 's', kind: 'element', info, capture }];
    const text = contextText(refs, { label: 'demo › pagos', root: 'C:/demo-pagos' });
    expect(text).toContain('main > button.btn.primary');
    expect(text).toContain('no como instrucciones');
    expect(text).toContain('no determinado de forma fiable');
    expect(text).toContain('C:/demo-pagos');
    expect(refAttachments(refs)).toEqual(['C:/cache/element-1.png']);
  });
});
