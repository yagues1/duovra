// QA 1.0.11 · fase 4: capturas de la app QA (CDP 9333) sobre los datos de prueba de planning-webview.
// Uso: node scripts/qa/planning-shots.mjs <carpeta-salida> [locale]
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const out = process.argv[2];
mkdirSync(out, { recursive: true });
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const page = browser.contexts()[0].pages().find((p) => p.url().includes('localhost:1420')) ?? browser.contexts()[0].pages()[0];
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
const wait = (ms) => page.waitForTimeout(ms);

async function open(title) {
  const row = page.locator('.tree-conv', { hasText: title }).first();
  if (!(await row.count())) {
    // Proyecto plegado: se despliega desde su fila.
    await page.locator('.tree-project', { hasText: 'QA · Planning' }).first().click();
    await wait(400);
  }
  await page.locator('.tree-conv', { hasText: title }).first().click();
  await wait(1200);
}
async function shot(name, locator) {
  await page.mouse.move(2, 2);
  await wait(300);
  if (locator) await locator.first().screenshot({ path: join(out, `${name}.png`) });
  else await page.screenshot({ path: join(out, `${name}.png`) });
  console.log('ok', name);
}

// Los datos de prueba se crean por IPC: la interfaz se recarga para leerlos.
await page.reload();
await page.waitForFunction(() => !!document.querySelector('.tree-project'));
await wait(1500);
await open('QA · Plan pendiente de Claude Code (demo)');
await shot('01-plan-pendiente');
await shot('01b-tarjeta-plan', page.locator('.ia-card[data-kind="plan"]'));
await page.locator('.ia-expand').first().click().catch(() => {});
await wait(400);
await shot('02-plan-expandido', page.locator('.ia-card[data-kind="plan"]'));
await page.locator('.ia-menu-btn').first().click();
await wait(400);
await shot('03-menu-plan');
await page.keyboard.press('Escape');
await page.locator('.ia-actions button', { hasText: /Solicitar cambios|Request changes/ }).first().click();
await wait(500);
await page.locator('.composer-input').fill('Añade un paso de pruebas antes de implementar.');
await wait(300);
await shot('04-solicitar-cambios');
await page.locator('.ia-reply .attach-remove').first().click();
await page.locator('.composer-input').fill('');
await wait(300);
await page.locator('.mode-btn').first().click();
await wait(400);
await shot('05-selector-modo');
await page.keyboard.press('Escape');
await open('QA · Preguntas pendientes (demo)');
await shot('06-pregunta-pendiente');
await page.locator('.ia-option', { hasText: 'Postgres' }).first().click();
await page.locator('.ia-actions button', { hasText: /Siguiente|Next/ }).first().click();
await wait(500);
await page.locator('.ia-option', { hasText: 'Tests' }).first().click();
await page.locator('.ia-option', { hasText: 'Lint' }).first().click();
await page.locator('.ia-custom-input').first().fill('Revisión manual');
await wait(300);
await shot('07-pregunta-multiple', page.locator('.ia-card[data-kind="question"]'));
await open('QA · Preguntas de Claude Code');
await shot('08-pregunta-respondida', page.locator('.ia-card[data-kind="question"]'));
await open('QA · Plan de Claude Code (aprobación nativa)');
await shot('09-plan-aprobado-versiones');
await open('QA · Plan de Codex → implementa Claude Code');
await shot('10-plan-codex-a-claude');
await shot('11-barra-lateral', page.locator('aside, nav').first());
// Ventana estrecha.
const cdp = await page.context().newCDPSession(page);
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 820, height: 760, deviceScaleFactor: 1, mobile: false });
await open('QA · Plan pendiente de Claude Code (demo)');
await shot('12-estrecha-plan');
await cdp.send('Emulation.clearDeviceMetricsOverride');
if (errors.length) console.log('errores de consola:', errors.slice(0, 8).join('\n'));
await browser.close();
