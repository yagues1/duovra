#!/usr/bin/env node
// Capturas del README con datos de demostración (IPC simulado de src/dev/mockTauri.ts): sin
// conversaciones reales, rutas privadas ni cuentas. Motor: Microsoft Edge (Chromium, como WebView2).
//
// 1. npx vite --port 1420 --strictPort
// 2. node scripts/qa/readme-shots.mjs [carpeta] [url]
// Genera JPEG para el README y, con ffmpeg en el PATH, una animación WebP corta de la aurora.
import { chromium } from 'playwright-core';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const [outDir = 'docs/screenshots/0.4.0', url = 'http://localhost:1420/?intensity=full'] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', args: ['--force-color-profile=srgb'] });
const errors = [];

async function open(width, height, scale = 1, video) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, ...(video ? { recordVideo: { dir: video, size: { width, height } } } : {}) });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(url);
  await page.locator('.composer').waitFor();
  await page.waitForTimeout(1800);
  return page;
}
const jpg = async (page, name, opts = {}) => {
  await page.waitForTimeout(800);
  await page.screenshot({ path: resolve(outDir, `${name}.jpg`), type: 'jpeg', quality: 88, ...opts });
  console.log('captura:', name);
};
const toTop = (page) => page.evaluate(() => document.querySelector('.chat-scroll')?.scrollTo({ top: 0 }));

try {
  // 1. Vista principal: conversación compartida desde el principio.
  const p = await open(1440, 900);
  await toTop(p);
  await p.waitForTimeout(600);
  // El botón «Ir al final» aparece al subir; se retira solo para esta captura.
  await p.evaluate(() => document.querySelector('.jump-btn')?.setAttribute('style', 'display:none'));
  await p.mouse.move(720, 450);
  await jpg(p, 'duovra-main');

  // 4. Panel contextual con un diff.
  await p.locator('.file-line').first().click();
  await p.waitForTimeout(900);
  await p.mouse.move(700, 300);
  await jpg(p, 'duovra-panel');
  await p.keyboard.press('Escape');

  // 6. Aurora Glass: pantalla de bienvenida de una conversación vacía.
  await p.getByText('Conversación vacía').first().click();
  await p.waitForTimeout(1200);
  await p.mouse.move(1100, 300);
  await jpg(p, 'duovra-welcome');

  // 5. Ajustes → Apariencia.
  await p.keyboard.press('Control+,');
  await p.waitForTimeout(700);
  await p.getByRole('button', { name: /Apariencia/ }).first().click();
  await p.waitForTimeout(1000);
  await p.mouse.move(4, 400);
  await jpg(p, 'duovra-settings');
  await p.close();

  // 3. Compositor con el menú de modelos, recortado a doble resolución.
  const c = await open(1440, 900, 2);
  await c.locator('.model-btn').click();
  await c.waitForTimeout(700);
  const box = await c.locator('.composer').boundingBox();
  await jpg(c, 'duovra-composer', { clip: { x: box.x - 40, y: box.y - 290, width: box.width + 80, height: box.height + 330 } });
  await c.close();

  // Demo animada: 8 s de aurora en movimiento con un cambio de agente.
  const vdir = join(tmpdir(), `duovra-video-${Date.now()}`);
  const v = await open(1280, 800, 1, vdir);
  await v.getByText('Conversación vacía').first().click();
  await v.waitForTimeout(1500);
  await v.mouse.move(900, 300, { steps: 30 });
  await v.getByRole('radio', { name: 'Claude Code' }).click();
  await v.waitForTimeout(2200);
  await v.mouse.move(400, 600, { steps: 40 });
  await v.getByRole('radio', { name: 'Codex' }).click();
  await v.waitForTimeout(3500);
  const video = await v.video().path();
  await v.context().close();
  // WebP animado: GitHub lo muestra como imagen y pesa mucho menos que un GIF con degradados.
  const anim = resolve(outDir, 'duovra-aurora.webp');
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', '2.2', '-t', '7.5', '-i', video,
    '-vf', 'fps=12,scale=720:-1:flags=lanczos', '-c:v', 'libwebp', '-lossless', '0', '-q:v', '64',
    '-compression_level', '6', '-loop', '0', anim], { stdio: 'inherit' });
  console.log(r.status === 0 ? `animación: ${anim}` : 'ffmpeg no disponible o falló: sin animación');
  rmSync(vdir, { recursive: true, force: true });
} finally {
  if (errors.length) console.log('Errores de página:', errors);
  await browser.close();
}
