// Verifica en Edge (mismo motor que WebView2) que el pase por columnas de Aurora produce
// exactamente los mismos píxeles que el cálculo por píxel, en WebGL2 y en el fallback WebGL1,
// con y sin lentes de cristal, y que la aurora vuelve a dibujar tras perder y restaurar el
// contexto WebGL. No usa datos del usuario ni proveedores.
//
//   node scripts/perf/aurora-equivalence.mjs
//
// Resultado: output/perf/aurora-equivalence.json
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { chromium } from 'playwright-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const out = join(root, 'output/perf/aurora-eq');
mkdirSync(out, { recursive: true });

await build({
  root,
  logLevel: 'warn',
  configFile: false,
  build: {
    outDir: out,
    emptyOutDir: true,
    minify: false,
    lib: { entry: join(root, 'src/lib/aurora.ts'), name: 'AuroraLib', formats: ['iife'], fileName: () => 'aurora.js' },
  },
});
const lib = readFileSync(join(out, 'aurora.js'), 'utf8');

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1360, height: 780 }, deviceScaleFactor: 1 });
page.on('console', (m) => console.log('[page]', m.text()));
page.setDefaultTimeout(60000);
await page.setContent('<!doctype html><body style="margin:0;background:#000"></body>');
await page.addScriptTag({ content: lib });

const result = await page.evaluate(async () => {
  const { createAurora } = window.AuroraLib;
  const rect = [100, 120, 420, 300];
  const lensSource = (on) => ({
    max: 4,
    read(rects, radii) {
      rects.fill(0);
      radii.fill(0);
      if (!on) return 0;
      rects.set(rect, 0);
      radii[0] = 24;
      return 1;
    },
    subscribe: () => () => undefined,
  });
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));

  const render = async (version, columnPass, lens) => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    if (version === 1) {
      const orig = canvas.getContext.bind(canvas);
      canvas.getContext = (type, opts) => (type === 'webgl2' ? null : orig(type, opts));
    }
    const a = createAurora(canvas, lensSource(lens), { columnPass });
    if (!a) return null;
    const gl = canvas.getContext(version === 2 ? 'webgl2' : 'webgl');
    if (lens) {
      a.setLens(1);
      await frame();
    }
    // sample() dibuja de forma síncrona; la lectura se hace en la misma tarea.
    a.sample([[10, 10]], () => undefined);
    const px = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const ext = version === 2 ? gl.getExtension('EXT_color_buffer_float') : gl.getExtension('OES_texture_float') && gl.getExtension('WEBGL_color_buffer_float');
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const info = { width: canvas.width, height: canvas.height, floatTargets: !!ext, renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) };
    a.destroy();
    canvas.remove();
    return { px, info };
  };

  const cases = [];
  for (const version of [2, 1]) {
    for (const lens of [false, true]) {
      console.log('caso', version, lens);
      const ref = await render(version, false, lens);
      const col = await render(version, true, lens);
      if (!ref || !col) {
        cases.push({ version, lens, error: 'sin contexto' });
        continue;
      }
      let diff = 0;
      let maxDelta = 0;
      for (let i = 0; i < ref.px.length; i++) {
        const d = Math.abs(ref.px[i] - col.px[i]);
        if (d) diff++;
        if (d > maxDelta) maxDelta = d;
      }
      let lit = 0;
      for (let i = 0; i < ref.px.length; i += 4) if (ref.px[i] + ref.px[i + 1] + ref.px[i + 2] > 60) lit++;
      cases.push({ version: `WebGL${version}`, lens, ...col.info, bytes: ref.px.length, differentBytes: diff, maxDelta, litPixels: lit });
    }
  }

  // Pérdida y restauración real del contexto (WEBGL_lose_context).
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  const a = createAurora(canvas, lensSource(false));
  const gl = canvas.getContext('webgl2');
  const lose = gl.getExtension('WEBGL_lose_context');
  const readCenter = () => {
    const px = new Uint8Array(4);
    a.sample([[10, 10]], () => undefined);
    gl.readPixels(canvas.width >> 1, canvas.height >> 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return Array.from(px);
  };
  console.log('restauración');
  const before = readCenter();
  const lost = new Promise((r) => canvas.addEventListener('webglcontextlost', () => r(), { once: true }));
  lose.loseContext();
  await lost;
  // restoreContext solo se admite cuando el evento de pérdida ha terminado de despacharse.
  await new Promise((r) => setTimeout(r, 50));
  const restored = new Promise((r) => canvas.addEventListener('webglcontextrestored', () => r(), { once: true }));
  console.log('perdido');
  lose.restoreContext();
  await restored;
  console.log('restaurado');
  await frame();
  const after = readCenter();
  // Sigue animándose tras restaurar.
  a.setFps(30);
  for (let i = 0; i < 20; i++) await frame();
  // Con el bucle activo, la muestra llega por el callback (lectura diferida con fence).
  const viaSample = () => new Promise((r) => a.sample([[680, 390]], (rgb) => r(rgb[0])));
  const animated = await viaSample();
  for (let i = 0; i < 30; i++) await frame();
  const animatedLater = await viaSample();
  a.destroy();
  return {
    cases,
    contextRestore: { before, afterRestore: after, afterAnimating: animated, afterAnimatingLater: animatedLater, keepsAnimating: animated.join() !== animatedLater.join(), isContextLost: gl.isContextLost(), drawsAfterRestore: after.some((v, i) => i < 3 && v > 0) },
  };
});

await browser.close();
const file = join(root, 'output/perf/aurora-equivalence.json');
writeFileSync(file, JSON.stringify({ when: new Date().toISOString(), browser: 'msedge headless', ...result }, null, 2));
console.log(JSON.stringify(result, null, 2));
const ok = result.cases.every((c) => c.differentBytes === 0 && c.litPixels > 0) && result.contextRestore.drawsAfterRestore && result.contextRestore.afterAnimating.some((v) => v > 0) && !result.contextRestore.isContextLost;
console.log(ok ? 'OK: salida idéntica y restauración correcta' : 'FALLO');
process.exitCode = ok ? 0 : 1;
