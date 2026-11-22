#!/usr/bin/env node
// Recorre el compositor real con los turnos simulados de src/dev/mockTauri.ts.
// node scripts/qa/mascot-states.mjs <carpeta> [claude|codex] [texto]
// QA_URL apunta a Vite. QA_CDP permite ejecutar la misma prueba en un WebView2 de QA.
// QA_VIDEO=1 conserva también el recorrido grabado en Edge.
import assert from 'node:assert/strict';
import { mkdirSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

const [out = 'output/qa/mascots', agent = 'claude', text = 'Arregla el botón de enviar y añade un test'] = process.argv.slice(2);
const failed = /falla|error/i.test(text);
const video = process.env.QA_VIDEO === '1';
const cdp = process.env.QA_CDP;
const viewport = { width: 1360, height: 820 };
mkdirSync(out, { recursive: true });
const browser = cdp ? await chromium.connectOverCDP(cdp) : await chromium.launch({ channel: 'msedge' });
const context = cdp ? browser.contexts()[0] : await browser.newContext({
  viewport, deviceScaleFactor: 2, ...(video && { recordVideo: { dir: out, size: viewport } }),
});
const page = cdp ? context.pages()[0] : await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const stage = '.stage-slot .mascot';
const mascot = page.locator(stage);
const cursorX = () => mascot.evaluate((svg) => Number(svg.style.getPropertyValue('--mascot-cursor-x')));
const state = (pose) => page.locator(`${stage}[data-s="${pose}"]`).waitFor();
const following = (enabled) => page.locator(stage + (enabled ? '[data-follow]' : ':not([data-follow])')).waitFor();
const screenshot = (name) => page.screenshot({ path: resolve(out, `${agent}-${name}.png`), scale: 'css' });
const detailShot = async (name) => {
  const box = await mascot.boundingBox();
  assert(box, 'La mascota está visible');
  await page.screenshot({ path: resolve(out, `${agent}-detalle-${name}.png`), clip: {
    x: Math.round(box.x - 12), y: Math.round(box.y - 12),
    width: Math.round(box.width + 24), height: Math.round(box.height + 24),
  } });
};
const depth = () => mascot.locator('.mascot-depth').evaluate((g) => getComputedStyle(g).transform);
const pointer = async (side) => {
  const box = await mascot.locator('.mascot-hit').boundingBox();
  assert(box);
  await page.mouse.move(box.x + box.width * side, box.y + box.height * .22);
};

try {
  if (cdp) await page.waitForURL((url) => url.origin !== 'null');
  const base = cdp ? page.url() : process.env.QA_URL ?? 'http://localhost:1431';
  await page.goto(new URL('/?mock&backdrop=dots&step=1600', base).href);
  await page.bringToFront();
  await page.locator('.composer').waitFor();
  await page.getByText('Conversación vacía', { exact: true }).first().click();
  const selector = page.locator('.agent-btn');
  const other = agent === 'claude' ? 'Codex' : 'Claude Code';
  const select = async (name) => {
    await selector.click();
    await page.getByRole('menuitemradio', { name, exact: true }).click();
  };
  if (agent === 'claude') await select('Claude Code');
  await state('idle');
  await following(true);

  const icon = selector.locator('svg.mascot');
  assert.equal(await icon.getAttribute('data-treatment'), 'minimal');
  assert.equal(await icon.evaluate((svg) => svg.getAnimations({ subtree: true }).length), 0);
  assert.equal(await icon.locator(agent === 'claude' ? '.mascot-antenna' : '.mascot-visor').count(), 1);
  assert.equal(await mascot.getAttribute('focusable'), 'false');
  assert.equal(await page.locator('.stage-slot [role="status"]').count(), 1);
  assert.equal(await page.locator('.stage-slot [role="status"]').textContent(), 'Listo para trabajar');

  const centered = await depth();
  await pointer(.1);
  await page.waitForTimeout(450);
  assert((await cursorX()) < -.5);
  assert.notEqual(await depth(), centered);
  await detailShot('mirada-izquierda');
  await pointer(.9);
  await page.waitForTimeout(450);
  assert((await cursorX()) > .5);
  await detailShot('mirada-derecha');
  await page.mouse.move(100, 100);
  await page.waitForTimeout(450);
  assert.equal(await cursorX(), 0);
  assert.equal(await depth(), centered);
  await screenshot('reposo');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await following(false);
  await pointer(.9);
  assert.equal(await depth(), 'none');
  assert.equal(await cursorX(), 0);
  assert.equal(await mascot.evaluate((svg) => svg.getAnimations({ subtree: true }).length), 0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await following(true);

  const loops = () => mascot.evaluate((svg) => svg.getAnimations({ subtree: true })
    .filter((animation) => animation.effect?.getTiming().iterations === Infinity).length);
  const motionSetting = async (value) => {
    await page.locator('html').evaluate((root, setting) => { root.dataset.mascots = setting; }, value);
    await following(value === 'full');
  };
  for (const mode of ['subtle', 'off']) {
    await motionSetting(mode);
    await pointer(.9);
    assert.equal(await cursorX(), 0);
    assert.equal(await loops(), 0);
  }
  await motionSetting('full');
  const moveOffscreen = (outside) => mascot.evaluate((svg, moved) => {
    svg.style.translate = moved ? '200vw' : '';
  }, outside);
  await moveOffscreen(true);
  await page.locator(stage + '[data-outside]').waitFor({ state: 'attached' });
  assert(await mascot.evaluate((svg) => svg.getAnimations({ subtree: true }).every((animation) => animation.playState === 'paused')));
  await moveOffscreen(false);
  await following(true);

  const original = await mascot.elementHandle();
  await mascot.evaluate((svg) => {
    svg.addEventListener('transitionrun', (event) => {
      if (event.propertyName === 'd' && svg.dataset.s === 'reading') svg.dataset.qaReadingMorph = '';
    });
  });
  await page.locator('.composer-input').fill(text);
  await pointer(.9);
  await page.locator('.composer-input').press('Enter');
  for (const pose of ['thinking', 'reading', 'coding', 'tools', ...(failed ? ['error'] : []), 'waiting']) {
    await state(pose);
    await following(false);
    await pointer(.1);
    assert.equal(await cursorX(), 0);
    assert.equal(await mascot.evaluate((svg, previous) => svg === previous, original), true);
    if (pose === 'reading') {
      await page.locator(stage + '[data-qa-reading-morph]').waitFor({ timeout: 1000 });
    }
    await page.waitForTimeout(430);
    await detailShot(pose);
    console.log('PASS', agent, pose);
  }
  await select(other);
  assert.equal(await mascot.getAttribute('data-agent'), agent, 'El selector solo cambia el agente del próximo turno');
  await page.getByRole('button', { name: 'Aprobar', exact: true }).click();
  await state('writing');
  await page.waitForTimeout(450);
  await detailShot('writing');
  await screenshot('streaming');
  const final = failed ? 'error' : 'done';
  await state(final);
  await page.waitForTimeout(155);
  await detailShot('final-' + final);
  await state('idle');
  assert.equal(await mascot.getAttribute('data-agent'), agent === 'claude' ? 'codex' : 'claude');
  assert.equal(await mascot.evaluate((svg, previous) => svg !== previous && !previous.isConnected, original), true);
  await following(true);
  assert.equal(await cursorX(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS', agent, 'writing', final, 'reposo, mirada, movimiento reducido y cambio de agente');
} finally {
  if (!cdp) {
    const recording = page.video();
    await context.close();
    if (recording) renameSync(await recording.path(), resolve(out, `${agent}-recorrido.webm`));
  }
  await browser.close();
}
