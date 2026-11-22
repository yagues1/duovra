#!/usr/bin/env node
// Captura rápida de la interfaz con el IPC simulado (?mock). Sin proveedores ni base de datos.
// node scripts/qa/shot.mjs <salida.png> [ruta-y-query] [ancho] [alto] [esperaMs] [acciones-js]
import { chromium } from 'playwright-core';
const [out, path = '/?mock', w = '1360', h = '820', wait = '2500', script = ''] = process.argv.slice(2);
const base = process.env.QA_URL ?? 'http://localhost:1431';
const browser = await chromium.launch({ channel: 'msedge', args: ['--force-color-profile=srgb', '--use-angle=d3d11', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.goto(base + path);
await page.waitForTimeout(+wait);
if (script) await page.evaluate(`(async () => { ${script} })()`);
await page.mouse.move(2, 2);
await page.waitForTimeout(400);
await page.screenshot({ path: out });
if (errors.length) console.log('errores:', errors.slice(0, 5).join('\n'));
console.log('ok', out);
await browser.close();
