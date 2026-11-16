#!/usr/bin/env node
// Capturas del README con datos de demostración (IPC simulado de src/dev/mockTauri.ts): sin
// conversaciones reales, rutas privadas ni cuentas. Motor: Microsoft Edge (Chromium, como WebView2).
//
// 1. npx vite --port 1420 --strictPort
// 2. node scripts/qa/readme-shots.mjs [carpeta] [url]
// Genera JPEG para el README y, con ffmpeg en el PATH, una animación WebP corta de Dot Matrix Flow.
// mockTauri admite `?backdrop=dots|aurora` y `?hue=<matiz>` para fijar el fondo y el matiz.
import { chromium } from 'playwright-core';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const [outDir = 'docs/screenshots/0.5.1', base = 'http://localhost:1420/?intensity=full'] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', args: ['--force-color-profile=srgb'] });
const errors = [];
const withParams = (params) => {
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.href;
};

async function open(width, height, { scale = 1, video, params = { backdrop: 'dots' } } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, ...(video ? { recordVideo: { dir: video, size: { width, height } } } : {}) });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(withParams(params));
  await page.locator('.composer').waitFor();
  await page.evaluate(() => document.fonts.ready.then(() => true));
  await page.waitForTimeout(1500);
  return page;
}
const jpg = async (page, name, opts = {}) => {
  await page.screenshot({ path: resolve(outDir, `${name}.jpg`), type: 'jpeg', quality: 88, ...opts });
  console.log('captura:', name);
};
const toTop = (page) => page.evaluate(() => document.querySelector('.chat-scroll')?.scrollTo({ top: 0 }));
const hideJump = (page) => page.evaluate(() => document.querySelector('.jump-btn')?.setAttribute('style', 'display:none'));
// Clic en una zona vacía del fondo: emite una onda. Se captura cuando el anillo ya se ha abierto.
const wave = async (page, x, y, wait = 900) => {
  await page.mouse.click(x, y);
  await page.waitForTimeout(wait);
};

try {
  // 1. Vista principal: conversación con una onda cian cruzando el cristal.
  const p = await open(1440, 900);
  await toTop(p);
  await hideJump(p);
  await wave(p, 1180, 250, 1100);
  await jpg(p, 'duovra-main');

  // 2. Panel contextual con un diff.
  await p.locator('.file-line').first().click();
  await p.waitForTimeout(900);
  await p.mouse.move(700, 300);
  await p.waitForTimeout(600);
  await jpg(p, 'duovra-panel');
  await p.keyboard.press('Escape');

  // 3. Ajustes → Apariencia (Fondo, onda y matiz).
  await p.keyboard.press('Control+,');
  await p.waitForTimeout(700);
  await p.getByRole('button', { name: /Apariencia/ }).first().click();
  await p.waitForTimeout(800);
  await p.getByText('Onda al hacer clic').first().evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await p.waitForTimeout(600);
  await p.mouse.move(4, 400);
  await jpg(p, 'duovra-settings');
  await p.close();

  // 4. Matiz violeta suave: varias ondas que se cruzan detrás de la barra lateral y el compositor.
  const v = await open(1440, 900, { params: { backdrop: 'dots', hue: 'violeta' } });
  await toTop(v);
  await hideJump(v);
  await v.mouse.click(1250, 760);
  await v.waitForTimeout(350);
  await wave(v, 330, 180, 950);
  await jpg(v, 'duovra-violet');
  await v.close();

  // 5. Aurora con el mismo cristal óptico (usuarios que vienen de 0.5.0).
  const a = await open(1440, 900, { params: { backdrop: 'aurora' } });
  await toTop(a);
  await hideJump(a);
  await a.mouse.move(1100, 300);
  await a.waitForTimeout(800);
  await hideJump(a);
  await jpg(a, 'duovra-aurora');
  await a.close();

  // 6. Compositor con el menú de modelos, recortado a doble resolución.
  const c = await open(1440, 900, { scale: 2 });
  await wave(c, 1200, 420, 700);
  await c.locator('.model-btn').click();
  await c.waitForTimeout(700);
  const box = await c.locator('.composer').boundingBox();
  await jpg(c, 'duovra-composer', { clip: { x: box.x - 40, y: box.y - 290, width: box.width + 80, height: box.height + 330 } });
  await c.close();

  // Demo animada: reposo, clics y ondas que se cruzan detrás del cristal, con un cambio de agente.
  const vdir = join(tmpdir(), `duovra-video-${Date.now()}`);
  const d = await open(1280, 800, { video: vdir });
  await d.getByText('Conversación vacía').first().click();
  await d.waitForTimeout(1600);
  await d.mouse.click(980, 260);
  await d.waitForTimeout(1300);
  await d.mouse.click(420, 520);
  await d.waitForTimeout(500);
  await d.mouse.click(1100, 640);
  await d.waitForTimeout(1200);
  await d.getByRole('radio', { name: 'Claude Code' }).click();
  await d.waitForTimeout(1600);
  await d.getByRole('radio', { name: 'Codex' }).click();
  await d.waitForTimeout(2600);
  const video = await d.video().path();
  await d.context().close();
  // WebP animado: GitHub lo muestra como imagen y pesa mucho menos que un GIF.
  const anim = resolve(outDir, 'duovra-dotflow.webp');
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', '2.6', '-t', '8', '-i', video,
    '-vf', 'fps=12,scale=640:-1:flags=lanczos', '-c:v', 'libwebp', '-lossless', '0', '-q:v', '50',
    '-compression_level', '6', '-loop', '0', anim], { stdio: 'inherit' });
  console.log(r.status === 0 ? `animación: ${anim}` : 'ffmpeg no disponible o falló: sin animación');
  if (process.env.KEEP_VIDEO) {
    spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', '2.6', '-i', video, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', process.env.KEEP_VIDEO], { stdio: 'inherit' });
    console.log(`vídeo: ${process.env.KEEP_VIDEO}`);
  }
  rmSync(vdir, { recursive: true, force: true });
} finally {
  if (errors.length) console.log('Errores de página:', errors);
  await browser.close();
}
