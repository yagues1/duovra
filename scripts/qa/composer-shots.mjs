#!/usr/bin/env node
// Capturas del compositor (1.0.0 Beta 2) con el IPC simulado: hover, menú de agente, selector de
// modelo, menú de esfuerzo, modo rápido y Enviar durante una ejecución.
// Requiere un servidor con la build de QA simulada (VITE_DUOVRA_QA=1) en QA_URL.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const [outDir = 'output/qa/composer'] = process.argv.slice(2);
const base = process.env.QA_URL ?? 'http://localhost:1431';
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', args: ['--force-color-profile=srgb', '--use-angle=d3d11', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1360, height: 820 } });
page.setDefaultTimeout(12_000);
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
const clip = async (name, popup) => {
  const box = await page.locator('.composer-wrap').boundingBox();
  const pop = popup ? await popup.boundingBox() : box;
  assert(box && pop, 'El compositor y el menú deben estar visibles');
  const top = Math.min(box.y, pop.y) - 16;
  await page.screenshot({ path: resolve(outDir, `${name}.png`), animations: 'disabled',
    clip: { x: box.x - 8, y: top, width: box.width + 16, height: box.y + box.height - top + 8 } });
  console.log('captura', name);
};

try {
  await page.goto(`${base}/?mock=1&escena=inicio`);
  const composer = page.locator('.composer');
  await composer.waitFor();
  await page.locator('.studio-intro').waitFor({ state: 'hidden' });
  await composer.hover();
  await clip('01-compositor-hover');

  const agent = page.getByRole('button', { name: /^Agente para el próximo mensaje:/ });
  const agentMenu = page.getByRole('menu', { name: 'Agente para el próximo mensaje' });
  await agent.press('Enter');
  const codex = agentMenu.getByRole('menuitemradio', { name: /^Codex\b/, checked: true });
  await codex.waitFor();
  await clip('02-menu-agente', agentMenu);
  await codex.click();

  const modelButton = page.locator('.model-btn');
  const model = page.getByRole('dialog', { name: 'Modelo' });
  await modelButton.click();
  await model.getByText('Modelos de Codex', { exact: true }).waitFor();
  await clip('03-selector-modelo', model);
  await model.getByRole('button', { name: /^GPT-6-Luna/ }).click();
  await page.getByRole('button', { name: 'Modelo: GPT-6-Luna', exact: true }).waitFor();
  await page.locator('.popover[aria-label="Modelo"]').waitFor({ state: 'detached' });

  // El menú abre con el foco en el nivel actual y lo devuelve al disparador al seleccionar.
  const effortButton = page.locator('.effort-btn');
  await effortButton.click();
  const effort = page.getByRole('menu', { name: 'Esfuerzo' });
  await effort.waitFor();
  const selected = effort.getByRole('menuitemradio', { checked: true });
  await selected.waitFor();
  assert(await selected.evaluate((element) => element === document.activeElement));
  await clip('04-menu-esfuerzo', effort);
  await effort.getByRole('menuitemradio', { name: 'Alto', exact: true }).click();
  await page.locator('.popover[aria-label="Esfuerzo"]').waitFor({ state: 'detached' });
  assert.equal(await effortButton.getAttribute('aria-label'), 'Esfuerzo: Alto');
  assert(await effortButton.evaluate((element) => element === document.activeElement));

  const fast = page.locator('.fast-btn');
  assert.equal(await fast.getAttribute('aria-pressed'), 'false');
  await fast.click();
  assert.equal(await fast.getAttribute('aria-pressed'), 'true');
  await clip('05-modo-rapido');

  // Enviar inicia un turno y encola el segundo mensaje mientras el primero sigue activo.
  const input = page.getByRole('textbox', { name: 'Mensaje', exact: true });
  await input.fill('Primer encargo');
  await input.press('Enter');
  await page.locator('.agent-activity').waitFor();
  await input.fill('Segundo encargo');
  assert.equal(await page.locator('.send-btn').getAttribute('aria-label'), 'Añadir a la cola');
  await input.press('Enter');
  const next = page.locator('.queue-next', { hasText: 'Segundo encargo' });
  await next.waitFor();
  assert.equal(await next.getAttribute('aria-expanded'), 'false');
  await page.getByText('Mensaje añadido a la cola', { exact: true }).waitFor({ state: 'hidden' });
  await clip('06-enviar-a-la-cola');
  assert.equal(await page.locator('.composer-defer').count(), 0);
  assert.deepEqual(errors, []);
  console.log('Compositor comprobado: agente, modelo, esfuerzo, modo rápido y envío/cola');
} finally {
  await browser.close();
}
