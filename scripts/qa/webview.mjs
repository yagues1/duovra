#!/usr/bin/env node
// Conecta con el WebView2 del ejecutable real de Duovra por CDP y ejecuta un
// módulo de pasos de QA: `export default async (page, ctx) => { ... }`.
//
// 1. Abrir la app con depuración remota (solo para QA, en PowerShell):
//      $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9333'
//      & 'src-tauri\target\release\duovra.exe'
// 2. node scripts/qa/webview.mjs ruta\a\pasos.mjs [carpeta-de-capturas]
//
// Usa el IPC, la base de datos y las CLIs reales: aplica docs/qa/test-model-policy.md.
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [steps, outDir = 'output/qa/release'] = process.argv.slice(2);
if (!steps) {
  console.error('Uso: node scripts/qa/webview.mjs pasos.mjs [carpeta-de-capturas]');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const page = browser.contexts()[0]?.pages().find((p) => !p.url().startsWith('devtools')) ?? browser.contexts()[0]?.pages()[0];
if (!page) throw new Error('No se encontró la página del WebView2');
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));
const ctx = {
  shot: async (name, opts = {}) => {
    const path = resolve(outDir, `${name}.png`);
    await page.screenshot({ path, ...opts });
    console.log(`captura: ${path}`);
    return path;
  },
  invoke: (cmd, args) => page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args ?? {}]),
  wait: (ms) => page.waitForTimeout(ms),
  log: (...a) => console.log(...a),
};
try {
  const mod = await import(pathToFileURL(resolve(steps)).href);
  await mod.default(page, ctx);
} catch (e) {
  console.error('FALLO del paso de QA:', e);
  process.exitCode = 1;
} finally {
  if (errors.length) console.log('Errores de consola:', errors);
  // No se llama a browser.close(): con CDP podría cerrar la app. Basta con salir del proceso.
  process.exit(process.exitCode ?? 0);
}
