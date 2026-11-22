#!/usr/bin/env node
// QA visual con fixtures del frontend y el mismo store que la aplicación.
// STUDIO_QA_CDP=http://127.0.0.1:9355 comprueba el ejecutable QA de WebView2.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright-core';

const out = resolve(process.argv[2] ?? 'output/qa/studio/capturas');
const endpoint = process.env.STUDIO_QA_CDP;
mkdirSync(out, { recursive: true });
const browser = endpoint ? await chromium.connectOverCDP(endpoint) : await chromium.launch({ channel: 'msedge' });
const page = endpoint
  ? browser.contexts()[0].pages().find((tab) => new URL(tab.url()).hostname === 'tauri.localhost')
  : await browser.newPage({ viewport: { width: 1360, height: 860 } });
assert(page, 'No se encontró la ventana Tauri de QA');
const base = endpoint ? new URL('/', page.url()).href : (process.env.STUDIO_QA_URL ?? 'http://127.0.0.1:1440/');
const errors = [];
const checks = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
const shot = async (name) => {
  await page.waitForTimeout(160);
  await page.screenshot({ path: join(out, name + '.png') });
  console.log('Captura', name);
};
const check = (name) => {
  checks.push(name);
  console.log('PASS', name);
};
const stage = (state) => page.locator('.agent-activity[data-s="' + state + '"]');
const field = page.locator('[data-activity][aria-hidden="true"]');
const input = page.getByRole('textbox', { name: 'Mensaje' });
const agentSelector = page.locator('.agent-btn');
const chooseAgent = async (name) => {
  await agentSelector.click();
  await page.getByRole('menuitemradio', { name, exact: true }).click();
  assert.match(await agentSelector.getAttribute('aria-label'), new RegExp(name));
};
const workbench = () => page.locator('#workbench');
const waitStage = (state) => stage(state).waitFor({ timeout: 20000 });
const focus = (locator) => locator.evaluate((element) => element === document.activeElement);
const hasOutline = (locator) => locator.evaluate((element) => {
  const { outlineStyle, outlineWidth } = getComputedStyle(element);
  return outlineStyle !== 'none' && parseFloat(outlineWidth) > 0;
});
const Native = (cmd, args = {}) => page.evaluate(([name, payload]) => window.__TAURI_INTERNALS__.invoke(name, payload), [cmd, args]);

async function open(scene, extra = {}) {
  const url = new URL(base);
  url.search = new URLSearchParams({ mock: '1', escena: scene, step: '850', ...extra }).toString();
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  await input.waitFor();
  await page.locator('.studio-intro').waitFor({ state: 'hidden' });
}

async function recordStart() {
  if (!endpoint || process.env.STUDIO_QA_VIDEO !== '1') return async () => {};
  const client = await page.context().newCDPSession(page);
  const frames = [];
  client.on('Page.screencastFrame', ({ sessionId, data, metadata }) => {
    frames.push({ data, time: metadata.timestamp });
    void client.send('Page.screencastFrameAck', { sessionId }).catch(() => undefined);
  });
  await client.send('Page.startScreencast', { format: 'jpeg', quality: 82, maxWidth: 1120, maxHeight: 760, everyNthFrame: 1 });
  return async () => {
    await client.send('Page.stopScreencast');
    await client.detach();
    assert(frames.length > 20, 'El vídeo requiere al menos 20 fotogramas');
    const dir = join(out, 'fotogramas-webview2');
    mkdirSync(dir, { recursive: true });
    const list = ['ffconcat version 1.0'];
    for (const [i, frame] of frames.entries()) {
      const file = i.toString().padStart(4, '0') + '.jpg';
      writeFileSync(join(dir, file), frame.data, 'base64');
      list.push("file '" + file + "'");
      const interval = frames[i + 1] ? frames[i + 1].time - frame.time : 0.6;
      list.push('duration ' + Math.max(1 / 60, Math.min(2, interval)).toFixed(4));
    }
    list.push("file '" + (frames.length - 1).toString().padStart(4, '0') + ".jpg'");
    writeFileSync(join(dir, 'video.ffconcat'), list.join('\n'));
    const video = join(out, 'campo-y-mascota-webview2.mp4');
    const ffmpeg = spawnSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', 'video.ffconcat',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=24', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', video,
    ], { cwd: dir, encoding: 'utf8' });
    assert.equal(ffmpeg.status, 0, ffmpeg.stderr);
    console.log('Vídeo', video, frames.length, 'fotogramas de WebView2');
  };
}

try {
  await open('inicio');
  await field.locator('canvas').waitFor();
  // En reposo, el campo deriva si la ventana tiene el foco (movimiento ambiental «Normal»).
  await page.locator('[data-activity][aria-hidden="true"][data-ready="true"][data-thread="worker"]').waitFor();
  assert.equal(await workbench().count(), 0);
  if (endpoint) {
    assert.match((await Native('distribution_info')).platform, /Windows/i);
    assert.match(await page.evaluate(() => navigator.userAgent), /Edg\//);
  }
  await shot('inicio');
  check('canvas del worker en reposo y Workbench cerrado');

  const composer = page.locator('.composer');
  const borderColor = () => composer.evaluate((element) => getComputedStyle(element).borderColor);
  await input.blur();
  const idleBorder = await borderColor();
  await input.click();
  await page.keyboard.type('Prueba de foco');
  assert.equal(await input.inputValue(), 'Prueba de foco');
  assert(await focus(input));
  assert.equal(await hasOutline(input), false);
  assert.equal(await borderColor(), idleBorder);
  await input.fill('');

  const attach = composer.getByRole('button', { name: 'Adjuntar archivos' });
  await page.keyboard.press('Tab');
  assert(await focus(attach) && await hasOutline(attach));
  await page.keyboard.press('Shift+Tab');
  assert(await focus(input) && await hasOutline(input));
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  assert(await focus(agentSelector) && await hasOutline(agentSelector));
  await agentSelector.click();
  const agentMenu = page.getByRole('menu', { name: 'Agente para el próximo mensaje' });
  const focusedItem = agentMenu.locator(':focus');
  await focusedItem.waitFor();
  assert.equal(await hasOutline(focusedItem), false);
  await page.keyboard.press('Escape');
  await agentMenu.waitFor({ state: 'hidden' });
  assert(await focus(agentSelector) && await hasOutline(agentSelector));
  check('el compositor y el selector de agente distinguen clic, Tab y Shift+Tab');

  await open('mixta');
  await page.locator('.turn[data-agent="claude"]').waitFor();
  await page.locator('.turn[data-agent="codex"]').waitFor();
  await page.locator('.chat-scroll').evaluate((element) => { element.scrollTop = 0; });
  await shot('mixta');
  await page.locator('.effort-btn').click();
  const lunaEffort = page.getByRole('menu', { name: 'Esfuerzo' });
  assert.equal(await lunaEffort.getByRole('menuitemradio').count(), 5);
  assert(await lunaEffort.locator('.mp-model-name').evaluateAll((labels) => labels.every((label) => {
    const range = document.createRange();
    range.selectNodeContents(label);
    return range.getClientRects().length === 1 && label.offsetWidth <= label.closest('button').clientWidth;
  })));
  await page.keyboard.press('Escape');
  await lunaEffort.waitFor({ state: 'hidden' });
  check('cinco niveles de esfuerzo completos en una sola línea');
  await page.locator('.turn[data-agent="codex"] .turn-name').scrollIntoViewIfNeeded();
  await shot('mixta-ambos-agentes');
  const codex = page.locator('.turn[data-agent="codex"]');
  const activity = codex.locator('.activity-head');
  assert.equal(await activity.count(), 1);
  assert.equal(await activity.getAttribute('aria-expanded'), 'false');
  await activity.press('Enter');
  const summary = codex.getByRole('button', { name: /^Resumen del razonamiento/ });
  assert.equal(await summary.count(), 1, 'El turno debe mostrar un único resumen con contenido');
  await summary.press('Enter');
  await codex.locator('.step-reasoning').getByText('Comprobación de la exportación', { exact: false }).waitFor();
  await activity.press('Enter');
  check('actividad compacta y un solo resumen de razonamiento con texto');

  await page.getByRole('button', { name: 'Mostrar Workbench', exact: true }).click();
  await workbench().getByRole('tab', { name: 'Archivos', exact: true }).press('ArrowRight');
  const lastChanges = workbench().getByRole('region', { name: 'Cambios del agente', exact: true });
  await lastChanges.getByRole('button', { name: /math\.js/ }).press('Enter');
  await workbench().locator('.diff-line[data-type="add"]').filter({ hasText: 'export function resta' }).waitFor();
  await page.getByRole('button', { name: 'Cerrar Workbench', exact: true }).click();
  check('Cambios de Workbench muestra el diff del último turno por teclado');

  const changed = page.locator('.changes .file-line').first();
  await changed.click();
  await workbench().waitFor();
  await workbench().locator('.diff-view').waitFor();
  assert.equal(await workbench().locator('.diff-line[data-type="add"]').count(), 4);
  await shot('workbench-diff');
  await page.getByRole('button', { name: 'Cerrar Workbench', exact: true }).click();
  await workbench().waitFor({ state: 'hidden' });
  assert(await focus(changed));
  const file = page.locator('button.file-ref').filter({ hasText: 'math.js' }).first();
  await file.focus();
  await page.keyboard.press('Enter');
  await workbench().locator('.code-view').waitFor();
  await shot('workbench-archivo');
  await page.keyboard.press('Escape');
  await workbench().waitFor({ state: 'hidden' });
  await activity.click();
  await codex.locator('.step').filter({ hasText: /node -e.*resta/ })
    .getByRole('button', { name: 'Abrir la salida en el panel' }).click();
  await workbench().locator('.term-out').waitFor();
  assert.equal((await workbench().locator('.term-out').innerText()).trim(), '2');
  await shot('workbench-salida');
  const tabs = workbench().getByRole('tab');
  await workbench().getByRole('tab', { selected: true }).focus();
  await page.keyboard.press('Home');
  assert(await focus(tabs.first()));
  await shot('workbench-contexto');
  await page.keyboard.press('Escape');
  check('autoría mixta, diff, archivo, salida y navegación de Workbench');

  await open('larga');
  assert.equal(await page.locator('.turn[data-agent="codex"] .md ol li').count(), 6);
  await shot('respuesta-larga-codigo');
  await open('pregunta');
  assert.match(await page.locator('.turn-prose').innerText(), /¿Quieres que guarde/);
  await shot('pregunta');
  check('respuesta larga, código y pregunta Markdown de historial sin items');

  await open('inicio');
  await agentSelector.focus();
  await page.keyboard.press('Enter');
  const claudeOption = page.getByRole('menuitemradio', { name: 'Claude Code', exact: true });
  await claudeOption.waitFor();
  await page.keyboard.press('Home');
  assert(await focus(claudeOption));
  await page.keyboard.press('Enter');
  assert.match(await agentSelector.getAttribute('aria-label'), /Claude Code/);
  await shot('agente-claude');
  const model = page.locator('.model-btn');
  const effort = page.locator('.effort-btn');
  await effort.focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu', { name: 'Esfuerzo' });
  await menu.waitFor();
  await shot('esfuerzo');
  const currentEffort = menu.getByRole('menuitemradio', { checked: true });
  assert(await focus(await currentEffort.count() ? currentEffort : menu.getByRole('menuitemradio').first()));
  const previous = await effort.getAttribute('aria-label');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await menu.waitFor({ state: 'hidden' });
  assert.notEqual(await effort.getAttribute('aria-label'), previous);
  await shot('esfuerzo-cambiado');
  assert(await focus(effort));
  await model.click();
  await page.getByText('Modelos de Claude Code', { exact: true }).waitFor();
  await shot('modelo');
  await page.getByRole('button', { name: /Más modelos/ }).click();
  await shot('modelos-adicionales');
  await page.keyboard.press('Escape');
  assert(await focus(model));
  await model.click();
  const haiku = page.getByRole('dialog', { name: 'Modelo' }).getByRole('button').filter({ hasText: /Haiku/ }).first();
  await haiku.click();
  assert.match(await model.innerText(), /Haiku/);
  check('agente manual, modelo, catálogo adicional y esfuerzo mediante teclado');

  const stop = await recordStart();
  const draft = 'Revisa el compositor y añade una prueba';
  await input.fill(draft);
  const baseHeight = (await input.boundingBox()).height;
  await input.press('Shift+Enter');
  await input.press('Shift+Enter');
  await input.press('Shift+Enter');
  await input.press('End');
  await page.keyboard.insertText('Incluye la línea final.');
  assert((await input.boundingBox()).height > baseHeight);
  await shot('multilinea');
  await input.fill(Array.from({ length: 20 }, () => draft).join('\n'));
  assert(await input.evaluate((el) => el.scrollHeight > el.clientHeight && el.clientHeight <= 160));
  await input.fill(draft);
  await input.press('Enter');
  await waitStage('thinking');
  assert.equal(await page.locator('.titlebar-title-text').innerText(), draft);
  const runThread = page.locator('.tree-conv').filter({ hasText: draft });
  await runThread.waitFor();
  await shot('mascota-pensando');
  await chooseAgent('Codex');
  assert.equal(await page.locator('.stage-mascot').getAttribute('data-agent'), 'claude');
  await waitStage('reading');
  await shot('mascota-leyendo');
  await waitStage('coding');
  await shot('mascota-editando');
  await waitStage('tools');
  await shot('herramientas');
  await page.locator('[data-activity][aria-hidden="true"][data-running="true"]').waitFor();
  await waitStage('waiting');
  const permission = page.getByRole('region', { name: 'Solicitud de permiso de Claude Code' });
  await permission.waitFor();
  assert.equal(await permission.getByRole('button').count(), 2);
  await shot('autorizacion');
  await page.locator('[data-activity][aria-hidden="true"][data-activity="waiting"]').waitFor();
  assert.match(await page.locator('.live-text[data-phase="waiting"]').innerText(), /Esperando/);
  await permission.getByRole('button', { name: 'Aprobar', exact: true }).click();
  await waitStage('writing');
  await shot('mascota-escribiendo');
  await waitStage('done');
  await shot('finalizacion');
  await stage('done').waitFor({ state: 'hidden' });
  const final = await page.locator('.turn[data-status="done"] .turn-prose[data-role="answer"]').last().innerText();
  assert.equal(final.match(/El botón Enviar queda desactivado/g)?.length, 1);
  assert.match(final, /Los tests de composer pasan/);
  check('reacciones del campo, permiso detenido, streaming y retorno al reposo');

  await input.fill('Simula un error');
  await input.press('Enter');
  const codexPermission = page.getByRole('region', { name: 'Solicitud de permiso de Codex' });
  await codexPermission.waitFor({ timeout: 18000 });
  assert.equal(await codexPermission.getByRole('button', { name: 'Aprobar en esta sesión' }).count(), 1);
  await codexPermission.getByRole('button', { name: 'Aprobar', exact: true }).click();
  await page.locator('.turn-error').waitFor({ timeout: 18000 });
  await shot('error');
  assert.match(await page.locator('.turn-error').innerText(), /código 1/);
  await stage('error').waitFor();
  await shot('mascota-error');
  await stage('error').waitFor({ state: 'hidden' });
  await stop();
  check('error de Codex y opciones distintas por proveedor');

  await input.fill('Comprueba la cancelación con autorización pendiente.');
  await input.press('Enter');
  await codexPermission.waitFor();
  await input.fill('Borrador para el próximo turno');
  await page.locator('.tree-conv').filter({ hasText: 'Crear el archivo nota2.txt' }).click();
  await page.locator('.titlebar-title-text').filter({ hasText: 'Crear el archivo nota2.txt' }).waitFor();
  assert.equal(await page.locator('.stage-mascot').count(), 0);
  assert.equal(await codexPermission.count(), 0);
  await runThread.click();
  await codexPermission.waitFor();
  assert.equal(await input.inputValue(), 'Borrador para el próximo turno');
  await page.getByRole('button', { name: 'Detener la ejecución', exact: true }).click();
  await codexPermission.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Enviar mensaje', exact: true }).waitFor();
  assert.equal(await page.locator('.stage-mascot').count(), 0);
  assert.equal(await input.inputValue(), 'Borrador para el próximo turno');
  check('el permiso sigue a su conversación, cancelar lo retira y el borrador se conserva');

  if (!endpoint) {
    await page.getByRole('button', { name: 'Añadir proyecto', exact: true }).click();
    await page.getByText('Proyecto QA', { exact: true }).first().waitFor();
    await page.getByRole('button', { name: 'Adjuntar archivos', exact: true }).click();
    await page.getByRole('button', { name: 'Quitar captura.png', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Quitar notas.txt', exact: true }).click();
    await page.getByRole('button', { name: 'Quitar notas.txt', exact: true }).waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Enviar mensaje', exact: true }).click();
    assert.equal(await page.locator('.titlebar-title-text').innerText(), 'captura.png');
    await page.getByRole('button', { name: 'Detener la ejecución', exact: true }).click();
    check('crear proyecto y conversación, adjuntar, quitar y enviar archivos con diálogo simulado');
  }

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 780, height: 560 });
  await open('inicio', { backdrop: 'off' });
  assert.equal(await field.count(), 0);
  await page.keyboard.press('Control+b');
  await page.locator('.nav-drawer[open]').waitFor();
  await shot('estrecha-navegacion');
  await page.keyboard.press('Escape');
  await page.locator('.nav-drawer[open]').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Mostrar Workbench' }).click();
  await page.locator('dialog#workbench[open]').waitFor();
  await shot('estrecha-workbench');
  await page.keyboard.press('Escape');
  await workbench().waitFor({ state: 'hidden' });
  assert(await focus(page.getByRole('button', { name: 'Mostrar Workbench' })));
  await open('inicio');
  assert.equal(await page.locator('html').getAttribute('data-intensity'), 'reduced');
  await page.locator('[data-activity][aria-hidden="true"][data-ready="true"][data-running="false"]').waitFor();
  await shot('estrecha-reducida');
  const railWidth = (await page.locator('.sidebar').boundingBox()).width;
  assert(railWidth >= 61 && railWidth <= 63, 'Ancho del riel a escala 100 %');
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  check('ventana estrecha, Escape, foco, movimiento reducido y fondo apagado');

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 1360, height: 860 });
  const scale = await page.evaluate(() => window.devicePixelRatio);
  await open('inicio', { scale: '1.2', hue: 'menta' });
  if (endpoint) await page.waitForFunction((baseScale) => devicePixelRatio > baseScale * 1.1, scale);
  assert.equal(await page.locator('html').getAttribute('data-hue'), 'menta');
  await shot('escala-y-matiz');
  await page.getByRole('button', { name: 'Reportar un error', exact: true }).click();
  await page.getByRole('dialog', { name: 'Reportar un error' }).waitFor();
  await shot('dialogo-reportar');
  await page.keyboard.press('Escape');
  await page.getByRole('dialog', { name: 'Reportar un error' }).waitFor({ state: 'hidden' });
  check('diálogo nativo de reporte y tema alternativo');

  await open('inicio', { update: '1' });
  await page.locator('[data-update-link]').click();
  await page.getByRole('dialog', { name: 'Novedades de Duovra' }).waitFor();
  await shot('dialogo-novedades');
  await page.getByRole('button', { name: 'Actualizar ahora' }).click();
  await page.getByRole('progressbar').waitFor();
  await shot('actualizacion-simulada');
  check('novedades y pantalla de progreso con canal simulado');

  await page.addInitScript(() => {
    const fallback = new URLSearchParams(location.search).get('fallback');
    if (fallback) window.Worker = class { constructor() { throw new Error('Worker deshabilitado en QA'); } };
    if (fallback === 'solid') HTMLCanvasElement.prototype.getContext = () => null;
  });
  await open('inicio', { fallback: 'main' });
  await page.locator('[data-activity][aria-hidden="true"][data-thread="main"][data-ready="true"]').waitFor();
  await shot('fallback-canvas');
  await open('inicio', { fallback: 'solid' });
  await page.locator('[data-activity][aria-hidden="true"][data-thread="unavailable"]').waitFor();
  assert.equal(await field.locator('canvas').count(), 0);
  await shot('fallback-solido');
  check('fallback Canvas 2D y fondo sólido');

  if (endpoint) {
    await open('inicio', { step: '4500' });
    await input.fill('Comprueba la pausa al minimizar');
    await input.press('Enter');
    await page.locator('[data-activity][aria-hidden="true"][data-running="true"]').waitFor();
    await Native('plugin:window|minimize', { label: 'main' });
    await page.waitForFunction(() => document.querySelector('[data-activity][aria-hidden="true"]')?.dataset.running === 'false',
      null, { polling: 50, timeout: 1100 });
    assert(await Native('plugin:window|is_minimized', { label: 'main' }));
    check('el worker se detiene al minimizar la ventana nativa durante una reacción');
  }

  assert.deepEqual(errors, []);
} finally {
  writeFileSync(join(out, 'verificacion.json'), JSON.stringify({ runtime: endpoint ? 'Tauri / WebView2' : 'Edge', checks, errors }, null, 2));
  if (!endpoint) await browser.close();
}
if (endpoint) process.exit(0);
