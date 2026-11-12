#!/usr/bin/env node
// Capturas comparables de la interfaz con datos de demostración (IPC simulado de src/dev/mockTauri.ts).
// No usa la base de datos real ni invoca a ningún proveedor: sirve para comparar materiales,
// distribución y estados entre versiones. Motor: Microsoft Edge (Chromium, como WebView2).
//
// 1. npx vite --port 1420 --strictPort
// 2. node scripts/qa/visual-scenes.mjs <carpeta-de-capturas> [url]
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const [outDir = 'output/qa/visual', url = 'http://localhost:1420/?intensity=full'] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', args: ['--force-color-profile=srgb', '--use-angle=d3d11', '--enable-gpu'] });
const errors = [];

async function open(width, height) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(url);
  await page.locator('.composer').waitFor();
  await page.waitForTimeout(1600);
  return page;
}
const shot = async (page, name) => {
  await page.mouse.move(2, 2);
  await page.waitForTimeout(700);
  await page.screenshot({ path: resolve(outDir, `${name}.png`) });
  console.log('captura:', name);
};
const empty = (page) => page.getByText('Conversación vacía').first().click();

try {
  const p = await open(1440, 900);
  await shot(p, '01-chat');
  await p.locator('.model-btn').click();
  await p.waitForTimeout(500);
  await shot(p, '02-menu-modelos');
  await p.keyboard.press('Escape');
  await p.locator('.file-line').first().click();
  await p.waitForTimeout(900);
  await shot(p, '03-panel-diff');
  await p.keyboard.press('Escape');
  await empty(p);
  await p.waitForTimeout(900);
  await shot(p, '04-vacio');
  await p.keyboard.press('Control+,');
  await p.waitForTimeout(900);
  await shot(p, '05-ajustes');
  await p.getByRole('button', { name: /Apariencia/ }).first().click();
  await p.waitForTimeout(900);
  await shot(p, '06-ajustes-apariencia');
  await p.close();

  const s = await open(760, 520);
  await shot(s, '07-w760-chat');
  await s.keyboard.press('Control+,');
  await s.waitForTimeout(900);
  await shot(s, '08-w760-ajustes');
  await s.close();
} finally {
  if (errors.length) console.log('Errores de consola:', errors);
  await browser.close();
}
