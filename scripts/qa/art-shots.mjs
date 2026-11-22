#!/usr/bin/env node
// Capturas comparables antes/después del refinamiento artístico, con el IPC simulado (?mock).
// Mismos escenarios y resolución en cada ejecución; no invoca proveedores ni usa la base de datos real.
// node scripts/qa/art-shots.mjs <carpeta> [ancho] [alto]
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const [outDir = 'output/qa/art', w = '1440', h = '900'] = process.argv.slice(2);
const base = process.env.QA_URL ?? 'http://localhost:1431';
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', args: ['--force-color-profile=srgb', '--use-angle=d3d11', '--enable-gpu'] });
const errors = [];
const page = await browser.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.goto(`${base}/?mock&backdrop=dots&step=1800`, { timeout: 180000 });
await page.locator('.composer').waitFor({ timeout: 60000 });
await page.waitForTimeout(2600);

const shot = async (name, clipSel) => {
  await page.mouse.move(2, 2);
  await page.waitForTimeout(500);
  let clip;
  if (clipSel) {
    const b = await page.locator(clipSel).first().boundingBox();
    if (b) clip = { x: Math.max(0, b.x - 8), y: Math.max(0, b.y - 8), width: b.width + 16, height: b.height + 16 };
  }
  await page.screenshot({ path: resolve(outDir, `${name}.png`), clip });
  console.log('captura:', name);
};

// 1. Conversación en reposo (final del historial).
await shot('01-chat-reposo');
await page.locator('.messages, .chat-scroll, [data-chat-scroll]').first().evaluate((el) => { el.scrollTop = 0; }).catch(() => {});
await page.waitForTimeout(400);
await shot('01b-chat-reposo-inicio');

// 5. Barra lateral.
await shot('05-barra-lateral', 'aside, .sidebar');

// 6. Selector de agente y modelo.
await page.locator('.model-btn').click();
await page.waitForTimeout(600);
await shot('06-selector-modelo');
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
await shot('06b-compositor', '.composer-wrap');

// 2–4. Turno simulado en una conversación vacía.
await page.getByText('Conversación vacía').first().click();
await page.waitForTimeout(800);
await page.locator('.agent-btn').click();
await page.getByRole('menuitemradio', { name: 'Claude Code', exact: true }).click();
await page.waitForTimeout(600);
await page.locator('.composer-input').fill('Arregla el botón de enviar y añade un test');
await page.keyboard.press('Enter');
const until = (st) => page.waitForFunction((v) => document.querySelector('.agent-activity')?.getAttribute('data-s') === v, st, { timeout: 30000 });
await until('coding'); await page.waitForTimeout(500);
await shot('02-trabajando-codigo');
await until('tools'); await page.waitForTimeout(500);
await shot('02b-trabajando-herramientas');
await shot('02c-mascota-compositor', '.composer-wrap');
await until('waiting'); await page.waitForTimeout(500);
await shot('03-esperando-autorizacion');
await page.getByRole('button', { name: 'Aprobar', exact: true }).click();
await until('writing'); await page.waitForTimeout(500);
await shot('03b-respondiendo');
await until('done'); await page.waitForTimeout(600);
await shot('04-tarea-terminada');
await page.waitForTimeout(3500);
await shot('04b-terminada-reposo');

// 7. Ajustes.
await page.keyboard.press('Control+,');
await page.waitForTimeout(900);
await shot('07-ajustes');
await page.getByRole('button', { name: /Apariencia/ }).first().click();
await page.waitForTimeout(800);
await shot('07b-ajustes-apariencia');

if (errors.length) console.log('Errores de consola:', errors.slice(0, 8));
await browser.close();
