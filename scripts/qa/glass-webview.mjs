import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const [mode, label = mode] = process.argv.slice(2);
const out = 'output/qa/liquid-glass';
// Modos: smoke (dev, con IPC aislado), measure, record y release (ejecutable Tauri por CDP).
const port = Number(process.env.GLASS_CDP_PORT ?? 9334);
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const page = browser.contexts()[0].pages().find((p) => !p.url().startsWith('devtools'));
const cdp = await page.context().newCDPSession(page);
const dev = process.env.GLASS_DEV_URL ?? 'http://localhost:1420';
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const shot = (name) => page.screenshot({ path: `${out}/${name}.png`, timeout: 15000 });
await mkdir(out, { recursive: true });

// Sistema óptico de 0.5.1: el cristal de paneles, compositor y cápsulas lo dibuja el shader del
// fondo (`html[data-glass=shader]`, superficies de src/lib/glass/surfaces.ts) y los flotantes
// (menús, diálogos) llevan una lente SVG (`.mat-float[data-lens]`, src/lib/glass/floatLens.ts).
const opticsReady = () => page.waitForFunction(() => {
  const root = document.documentElement;
  return root.dataset.glass === 'shader' && root.dataset.optics === 'on' && !!document.querySelector('canvas');
});
const floatLensReady = (selector) => page.waitForFunction((sel) => {
  const el = document.querySelector(sel);
  return !!el && el.hasAttribute('data-lens') && getComputedStyle(el).backdropFilter.includes('url(');
}, selector);

async function fixture() {
  // La API Tauri real está sellada en WebView2. Aislamos el arnés reescribiendo
  // las referencias de sus módulos Vite durante esta sesión CDP, fuera de producción.
  await page.route(`${dev}/**`, async (route) => {
    if (route.request().resourceType() !== 'script') return route.continue();
    const response = await route.fetch({ maxRetries: 2 });
    if (!response.headers()['content-type']?.includes('javascript')) return route.fulfill({ response });
    const body = (await response.text()).replaceAll('__TAURI_INTERNALS__', '__GLASS_QA_INTERNALS__')
      .replaceAll('__TAURI_EVENT_PLUGIN_INTERNALS__', '__GLASS_QA_EVENTS__');
    await route.fulfill({ response, body });
  });
}

async function measure() {
  await fixture();
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  const results = [];
  const sizes = [{ width: 1366, height: 720 }, { width: 1100, height: 680 }, { width: 760, height: 520 }];
  for (const { width, height } of sizes) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    for (const intensity of ['reduced', 'balanced', 'full']) {
      await page.goto(`${dev}/?intensity=${intensity}`, { waitUntil: 'commit' });
      const draft = page.getByRole('textbox', { name: 'Mensaje' });
      const menu = page.locator('.model-btn');
      await draft.waitFor({ timeout: 20000 });
      await page.locator(`html[data-intensity="${intensity}"]`).waitFor({ state: 'attached' });
      await page.evaluate(() => document.fonts.ready.then(() => true));
      await page.evaluate(() => {
        delete window.glassQaFrameData;
        const stamps = [];
        const start = performance.now();
        const tick = (t) => {
          stamps.push(t);
          if (t - start < 2800) return requestAnimationFrame(tick);
          const frames = stamps.slice(1).map((n, i) => n - stamps[i]).sort((a, b) => a - b);
          window.glassQaFrameData = { fps: frames.length * 1000 / (stamps.at(-1) - stamps[0]),
            p95: frames[Math.ceil(frames.length * .95) - 1], max: frames.at(-1),
            over25: frames.filter((ms) => ms > 25).length };
        };
        requestAnimationFrame(tick);
      });
      await menu.click({ force: true });
      await page.waitForTimeout(240);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(180);
      await page.keyboard.press('Control+b');
      await page.waitForTimeout(420);
      await page.keyboard.press('Control+b');
      await page.waitForTimeout(420);
      await draft.fill(Array(7).fill('Borrador para comprobar el crecimiento del compositor.').join('\n'));
      await page.waitForTimeout(390);
      await draft.fill('');
      await page.waitForFunction(() => !!window.glassQaFrameData);
      const result = { width, height, intensity, ...(await page.evaluate(() => window.glassQaFrameData)) };
      results.push(result);
      console.log(JSON.stringify(result));
      if (intensity === 'full') await shot(`${label}-${width}x${height}`);
    }
  }
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await writeFile(`${out}/${label}.json`, JSON.stringify({ results, errors }, null, 2));
}

async function smoke() {
  await fixture();
  const sizes = [{ width: 1366, height: 720 }, { width: 1100, height: 680 }, { width: 760, height: 520 }];
  for (const { width, height } of sizes.filter(({ width }) => !process.env.GLASS_SMOKE_WIDTH || Number(process.env.GLASS_SMOKE_WIDTH) === width)) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await page.goto(`${dev}/?intensity=full`, { waitUntil: 'domcontentloaded' });
    const draft = page.getByRole('textbox', { name: 'Mensaje' });
    const trigger = page.locator('.model-btn');
    await draft.waitFor({ timeout: 20000 });
    await opticsReady();
    await page.getByRole('radio', { name: 'Codex', exact: true }).focus();
    await trigger.filter({ hasText: 'GPT-6-Luna' }).filter({ hasText: 'Alto' }).waitFor();
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(() => document.querySelector('.agent-option[aria-checked=true]')?.getAttribute('aria-label') === 'Claude Code');
    await trigger.filter({ hasText: 'Haiku 5.5' }).filter({ hasText: 'Medio' }).waitFor();
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => document.querySelector('.agent-option[aria-checked=true]')?.getAttribute('aria-label') === 'Codex');
    await trigger.filter({ hasText: 'GPT-6-Luna' }).filter({ hasText: 'Alto' }).waitFor();
    await page.keyboard.press('Tab');
    assert.equal(await trigger.evaluate((el) => el === document.activeElement), true);
    await page.keyboard.press('Enter');
    const menu = page.locator('.popover');
    await menu.getByRole('menuitem').first().waitFor();
    await page.waitForFunction(() => !!document.activeElement?.closest('.popover'));
    await floatLensReady('.popover');
    const bounds = await menu.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= width && bounds.y + bounds.height <= height);
    await page.waitForTimeout(420);
    await shot(`dev-menu-${width}`);
    await page.keyboard.press('Escape');
    assert.equal(await trigger.evaluate((el) => el === document.activeElement), true);
    await menu.waitFor({ state: 'detached' });
    await trigger.click();
    await trigger.click();
    await trigger.click();
    await menu.waitFor();
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Adjuntar archivos' }).click();
    await page.getByText('captura.png', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Quitar captura.png' }).click();
    await page.getByText('captura.png', { exact: true }).waitFor({ state: 'detached' });
    await draft.fill(Array(7).fill('Borrador de prueba de crecimiento.').join('\n'));
    await page.waitForTimeout(450);
    assert.ok((await draft.boundingBox()).height > 100);
    await shot(`dev-compositor-${width}`);
    await draft.fill('');
    await page.getByRole('button', { name: 'Adjuntar archivos' }).hover();
    await page.getByRole('tooltip').filter({ hasText: 'Adjuntar archivos' }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('tooltip').waitFor({ state: 'hidden' });
    await page.keyboard.press('Control+b');
    if (width === 760) await page.getByRole('dialog', { name: 'Navegación' }).waitFor();
    await page.keyboard.press('Control+b');
    if (width === 760) await page.getByRole('dialog', { name: 'Navegación' }).waitFor({ state: 'detached' });
    await page.locator('.activity-head').first().click();
    const details = page.getByRole('button', { name: 'Abrir en el panel', exact: true }).first();
    await details.click();
    await page.getByRole('complementary', { name: 'Panel de detalles' }).waitFor();
    await page.waitForTimeout(450);
    await shot(`dev-panel-${width}`);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+,');
    await page.getByRole('button', { name: 'Modelos', exact: true }).click();
    await page.getByText('GPT-6-Luna', { exact: true }).first().waitFor();
    console.log(`PASS teclado, capas, adjuntos, panel y Modelos · ${width} × ${height}`);
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${dev}/?intensity=full`, { waitUntil: 'domcontentloaded' });
  await page.locator('html[data-intensity=reduced]').waitFor({ state: 'attached' });
  await page.emulateMedia({ reducedMotion: null });
  // Fondos y matices: Dot Matrix Flow y Aurora comparten el mismo cristal; el matiz llega a <html>.
  for (const [backdrop, hue] of [['dots', 'violeta'], ['aurora', 'menta'], ['dots', 'cian']]) {
    await page.goto(`${dev}/?intensity=full&backdrop=${backdrop}&hue=${hue}`, { waitUntil: 'domcontentloaded' });
    await page.locator(`html[data-backdrop=${backdrop}][data-hue=${hue}]`).waitFor({ state: 'attached' });
    await opticsReady();
  }
  console.log('PASS cristal óptico con Dot Matrix Flow y Aurora, y matices aplicados');
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await page.evaluate(async () => {
    const { useStore } = await import('/src/state/store.ts');
    const conversationId = useStore.getState().activeConversationId;
    useStore.setState({ runs: { [conversationId]: {
      runId: 'qa-run', messageId: 'qa-message', conversationId, agent: 'codex', model: 'gpt-6-luna',
      items: [], usage: null, approvals: [], startedAt: Date.now(),
    } } });
  });
  await page.getByRole('button', { name: 'Detener la ejecución' }).waitFor();
  await page.evaluate(async () => (await import('/src/state/store.ts')).useStore.setState({ runs: {} }));
  await page.getByRole('button', { name: 'Enviar mensaje' }).waitFor();
  console.log('PASS movimiento reducido y estado enviar/detener simulado');
  if (errors.length) throw new Error(errors.join('\n'));
}

async function record() {
  await fixture();
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 680, deviceScaleFactor: 1, mobile: false });
  await page.goto(`${dev}/?intensity=full`, { waitUntil: 'domcontentloaded' });
  const trigger = page.locator('.model-btn');
  await trigger.waitFor();
  await page.evaluate(() => document.fonts.ready.then(() => true));
  const frames = [];
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    frames.push({ data, time: metadata.timestamp });
    void cdp.send('Page.screencastFrameAck', { sessionId });
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 84, maxWidth: 1100, maxHeight: 680 });
  await page.waitForTimeout(350);
  await page.getByRole('radio', { name: 'Claude Code', exact: true }).click();
  await page.waitForTimeout(550);
  await trigger.click();
  await page.waitForTimeout(800);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(450);
  await page.getByRole('radio', { name: 'Codex', exact: true }).click();
  await page.waitForTimeout(430);
  const draft = page.getByRole('textbox', { name: 'Mensaje' });
  await draft.fill(Array(6).fill('Borrador para comprobar el crecimiento.').join('\n'));
  await page.waitForTimeout(800);
  await draft.fill('');
  await page.waitForTimeout(550);
  await cdp.send('Page.stopScreencast');
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  assert.ok(frames.length > 5);
  const directory = `${out}/frames`;
  await mkdir(directory, { recursive: true });
  const names = frames.map((_, i) => `f${String(i).padStart(4, '0')}.jpg`);
  await Promise.all(frames.map((frame, i) => writeFile(`${directory}/${names[i]}`, Buffer.from(frame.data, 'base64'))));
  const concat = frames.map((frame, i) => `file '${names[i]}'\nduration ${Math.max(0.016, (frames[i + 1]?.time ?? frame.time + 0.18) - frame.time)}`);
  await writeFile(`${directory}/clip.ffconcat`, `ffconcat version 1.0\n${concat.join('\n')}\nfile '${names.at(-1)}'\n`);
  console.log(`${frames.length} fotogramas reales de WebView2`);
}

async function release() {
  assert.equal(new URL(page.url()).hostname, 'tauri.localhost');
  const info = await page.evaluate(async () => {
    const { appVersion, projects } = await window.__TAURI_INTERNALS__.invoke('bootstrap');
    return { appVersion, projects: projects.length, userAgent: navigator.userAgent, intensity: document.documentElement.dataset.intensity };
  });
  assert.ok(info.appVersion && info.projects >= 0);
  const trigger = page.locator('.model-btn');
  await trigger.waitFor();
  if (info.intensity !== 'reduced') await opticsReady();
  const menu = page.locator('.popover');
  if (await trigger.getAttribute('aria-expanded') === 'true') {
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'detached' });
  }
  await page.mouse.move(12, 44);
  await page.getByRole('tooltip').waitFor({ state: 'hidden' });
  await page.locator('.composer').screenshot({ path: `${out}/release-compositor.png` });
  await trigger.click();
  await menu.getByRole('menuitem').first().waitFor();
  if (info.intensity !== 'reduced') await floatLensReady('.popover');
  await page.waitForTimeout(400);
  await menu.screenshot({ path: `${out}/release-selector.png` });
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached' });
  const appUrl = page.url();
  await page.goto(new URL('/third-party-notices.txt', appUrl).href, { waitUntil: 'domcontentloaded' });
  const notice = await page.locator('body').innerText();
  assert.ok(notice.includes('Motion Primitives') && !notice.includes('Vaso'));
  await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
  assert.deepEqual(errors, []);
  await writeFile(`${out}/release.json`, JSON.stringify({ ...info, errors }, null, 2));
  console.log('PASS ejecutable Tauri, IPC, cristal óptico, selector real y avisos empaquetados', info);
}


try {
  if (mode === 'measure') await measure();
  else if (mode === 'smoke') await smoke();
  else if (mode === 'record') await record();
  else if (mode === 'release') await release();
  else throw new Error('Usa measure, smoke, record o release');
  if (errors.length) console.error(errors);
} catch (error) {
  console.error(error, errors);
  process.exitCode = 1;
} finally {
  process.exit(process.exitCode ?? 0);
}
