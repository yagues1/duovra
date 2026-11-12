#!/usr/bin/env node
// Comprobación visual y de rendimiento en el WebView2 real (ejecutable QA con identificador propio).
//
// Usa el IPC real de una instalación QA aislada (`-c '{"identifier":"dev.duovra.qa",...}'`): crea
// un proyecto de demostración en una carpeta temporal y una conversación vacía. No usa la base de
// datos del usuario ni invoca a ningún proveedor (docs/qa/test-model-policy.md).
//
//   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9333'
//   & '<ejecutable QA>'
//   node scripts/qa/visual-webview.mjs <carpeta> <etiqueta> <carpeta-de-proyecto-demo>
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [outDir = 'output/qa/webview', tag = 'app', demoDir] = process.argv.slice(2);
if (!demoDir) throw new Error('Falta la carpeta del proyecto de demostración');
mkdirSync(outDir, { recursive: true });
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => !p.url().startsWith('devtools')) ?? ctx.pages()[0];
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
const invoke = (cmd, args = {}) => page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);

/** FPS e intervalos entre fotogramas durante `ms`, mientras se ejecuta `act`. */
async function measure(ms, act) {
  const run = page.evaluate((d) => new Promise((res) => {
    const ts = [];
    const t0 = performance.now();
    const f = (t) => { ts.push(t); if (t - t0 < d) requestAnimationFrame(f); else res(ts); };
    requestAnimationFrame(f);
  }), ms);
  if (act) await act();
  const ts = await run;
  const gaps = ts.slice(1).map((t, i) => t - ts[i]).sort((a, b) => a - b);
  return { fps: +((ts.length - 1) / ((ts.at(-1) - ts[0]) / 1000)).toFixed(1), p95: +gaps[Math.floor(gaps.length * 0.95)].toFixed(1), max: +gaps.at(-1).toFixed(1) };
}

// Proyecto y conversación de demostración (idempotente).
const boot = await invoke('bootstrap');
let project = boot.projects.find((p) => p.name === 'Demo');
if (!project) project = await invoke('create_project', { name: 'Demo', path: demoDir });
if (!boot.conversations.some((c) => c.projectId === project.id)) await invoke('create_conversation', { projectId: project.id, title: 'Conversación de demostración' });
await invoke('set_setting', { key: 'ui.lastProjectId', value: project.id });

const results = {};
for (const intensity of ['balanced', 'full']) {
  await invoke('set_setting', { key: 'appearance.intensity', value: intensity });
  await page.reload();
  await page.locator('.composer').waitFor({ timeout: 20000 });
  await page.waitForTimeout(3000);
  const viewport = await page.evaluate(() => `${innerWidth}x${innerHeight}`);
  const idle = await measure(3000);
  const busy = await measure(3400, async () => {
    for (let k = 0; k < 2; k++) {
      await page.getByRole('radio', { name: k ? 'Codex' : 'Claude Code' }).click();
      await page.waitForTimeout(400);
      await page.keyboard.press('Control+b');
      await page.waitForTimeout(500);
      await page.keyboard.press('Control+b');
      await page.waitForTimeout(400);
    }
  });
  results[intensity] = { viewport, idle, busy };
  console.log(tag, intensity, viewport, JSON.stringify({ idle, busy }));
  if (intensity === 'full') {
    await page.mouse.move(900, 300);
    await page.waitForTimeout(600);
    await page.screenshot({ path: resolve(outDir, `${tag}-chat.png`) });
    await page.keyboard.press('Control+,');
    await page.waitForTimeout(700);
    await page.getByRole('button', { name: /Apariencia/ }).first().click();
    await page.waitForTimeout(900);
    results.settings = await measure(2500);
    await page.screenshot({ path: resolve(outDir, `${tag}-ajustes.png`) });
    await page.keyboard.press('Control+,');
  }
}
await invoke('set_setting', { key: 'appearance.intensity', value: 'auto' });
writeFileSync(resolve(outDir, `${tag}-rendimiento.json`), JSON.stringify({ results, errors }, null, 2));
console.log('errores', errors);
process.exit(0);
