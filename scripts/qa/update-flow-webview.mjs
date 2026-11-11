// QA de la experiencia de actualización en el WebView2 real (Duovra-QA aislada).
// Requiere el servidor de scripts/qa/distribution-server.mjs en modo «update».
// Uso: node scripts/qa/webview.mjs scripts/qa/update-flow-webview.mjs <carpeta-capturas>
export default async (page, ctx) => {
  const version = await ctx.invoke('distribution_info');
  ctx.log('instalada:', JSON.stringify(version));

  // 1. Indicador discreto tras la comprobación automática al iniciar.
  const link = page.locator('[data-update-link]').first();
  await link.waitFor({ timeout: 20_000 });
  await ctx.shot('01-indicador');

  // 2. Novedades.
  await link.click();
  const now = page.getByRole('button', { name: 'Actualizar ahora' });
  await now.waitFor();
  await ctx.shot('02-novedades');

  // 3. Pantalla de actualización: se registran las fases que se ven de verdad.
  await now.click();
  const seen = new Set();
  const started = Date.now();
  let shots = 0;
  while (Date.now() - started < 120_000) {
    let title;
    try {
      title = await page.locator('#update-title').textContent({ timeout: 1000 });
    } catch {
      // La app se cerró para ejecutar el instalador (CDP desconectado).
      break;
    }
    const meta = (await page.locator('.update-meta').textContent().catch(() => '')) ?? '';
    if (title && !seen.has(title)) {
      seen.add(title);
      ctx.log(`fase: ${title} ${meta}`);
      await ctx.shot(`03-fase-${++shots}`).catch(() => undefined);
    }
    if (title === 'Descargando' && /\d+ %/.test(meta) && !seen.has('progreso')) {
      seen.add('progreso');
      ctx.log(`progreso real: ${meta}`);
      await ctx.shot('04-progreso').catch(() => undefined);
    }
    if (title?.startsWith('No se pudo')) {
      ctx.log('error:', await page.locator('#update-detail').textContent());
      throw new Error('La actualización falló');
    }
    await ctx.wait(150);
  }
  ctx.log('fases vistas:', [...seen].join(' → '));
};
