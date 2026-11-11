import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { setTimeout } from 'node:timers/promises';

const ca = readFileSync('output/qa/distribution/ca.pem');
function setMode(mode) {
  return new Promise((resolve, reject) => {
    const req = request(`https://127.0.0.1:17443/qa?mode=${mode}`, { method: 'POST', ca }, (res) => {
      res.resume();
      res.on('end', () => res.statusCode === 200 ? resolve() : reject(new Error('Modo de QA rechazado')));
    });
    req.on('error', reject);
    req.end();
  });
}

export default async function verify(page, { shot, invoke, log }) {
  await setMode('current');
  await page.reload();
  await page.getByRole('button', { name: 'Reportar un error' }).waitFor();
  const info = await invoke('distribution_info');
  assert.equal(info.reportingEnabled, true);
  assert.equal(info.updaterEnabled, true);
  assert.equal(await invoke('check_update'), null);
  assert.equal(await page.getByRole('button', { name: 'Actualización disponible' }).count(), 0);
  const reportTrigger = page.getByRole('button', { name: 'Reportar un error' });
  await reportTrigger.click();
  const report = page.getByRole('dialog', { name: 'Reportar un error' });
  await report.getByRole('button', { name: 'Enviar reporte' }).click();
  await report.getByRole('alert').filter({ hasText: 'Revisa el campo indicado' }).waitFor();
  assert.equal(await report.getByLabel('Título del problema').evaluate((el) => el === document.activeElement), true);
  await report.getByLabel('Título del problema').fill('Prueba local de la barra lateral');
  await report.getByLabel('Descripción', { exact: true }).fill('La barra lateral tarda en abrir. Correo ficticio: demo@example.test');
  await report.getByLabel('Pasos para reproducirlo').fill('1. Contraer la barra\n2. Abrir el cajón');
  await report.getByLabel('Categoría').selectOption('visual');
  await report.getByLabel('Captura (opcional)').setInputFiles('src-tauri/icons/128x128.png');
  await report.getByAltText('Vista previa de la captura que se adjuntará').waitFor();
  await report.getByRole('checkbox').check();
  await shot('01-formulario-reporte');
  await setMode('report-error');
  await report.getByRole('button', { name: 'Enviar reporte' }).click();
  await report.getByRole('alert').filter({ hasText: 'Incidencia sin confirmar' }).waitFor();
  await setMode('current');
  await report.getByRole('button', { name: 'Reintentar el envío' }).click();
  await report.getByRole('status').filter({ hasText: 'incidencia #42' }).waitFor();
  await report.getByRole('button', { name: 'Cerrar reporte' }).click();
  assert.equal(await reportTrigger.evaluate((el) => el === document.activeElement), true);
  log('Reporte: validación, captura, error de red y reintento confirmado por el servidor local');

  await setMode('older');
  await page.getByRole('button', { name: 'Ajustes', exact: true }).click();
  const check = page.getByRole('button', { name: 'Buscar actualizaciones' });
  await check.click();
  await page.getByText('Ya tienes la versión más reciente.').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Actualización disponible' }).count(), 0);
  await shot('02-ajustes-general');
  await setMode('download-error');
  await check.click();
  const update = page.getByRole('dialog', { name: 'Actualización disponible' });
  await update.waitFor();
  await update.getByRole('button', { name: 'Descargar e instalar' }).click();
  await update.getByRole('alert').filter({ hasText: 'No se pudo descargar' }).waitFor();
  await setMode('signature');
  await update.getByRole('button', { name: 'Reintentar descarga' }).click();
  await update.getByRole('alert').filter({ hasText: 'No se pudo verificar' }).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('button', { name: 'Ver actualización' }).evaluate((el) => el === document.activeElement), true);

  // Una nueva comprobación contra el manifiesto modificado prueba la versión dentro de la firma.
  await setMode('version');
  await page.reload();
  await page.getByRole('button', { name: 'Actualización disponible' }).click();
  await update.getByRole('button', { name: 'Descargar e instalar' }).click();
  await update.getByRole('alert').filter({ hasText: 'No se pudo verificar' }).waitFor();
  await setMode('valid');
  await page.reload();
  await page.getByRole('button', { name: 'Actualización disponible' }).waitFor();
  await shot('03-aviso-actualizacion');
  await page.getByRole('button', { name: 'Actualización disponible' }).click();
  await update.getByRole('button', { name: 'Descargar e instalar' }).click();
  await update.getByRole('progressbar').waitFor();
  await shot('04-descarga-actualizacion');
  await update.getByRole('button', { name: 'Reiniciar para actualizar' }).waitFor();
  await shot('05-actualizacion-verificada');
  await page.keyboard.press('Escape');
  log('Updater nativo: 204, versión anterior, versión nueva, 503, firma manipulada, versión falseada y paquete válido');

  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 760, height: 520, deviceScaleFactor: 1, mobile: false });
    const railReport = page.locator('.rail-btn[data-report-trigger]');
    await railReport.focus();
    await page.getByRole('tooltip', { name: 'Reportar un error' }).waitFor();
    await shot('06-barra-contraida');
    await page.keyboard.press('Enter');
    await report.waitFor();
    const bounds = await report.boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.width <= 760 && bounds.height <= 520);
    await shot('07-reporte-760');
    await page.keyboard.press('Escape');
  } finally {
    await cdp.send('Emulation.clearDeviceMetricsOverride');
  }
  await page.keyboard.press('Control+,');
  await page.getByRole('button', { name: 'Agentes', exact: true }).click();
  const icon = page.locator('img[src*="openai-codex-marketplace"]').first();
  await icon.waitFor();
  assert.equal(await icon.evaluate((el) => el.complete && el.naturalWidth > 0), true);
  log('WebView2: barra contraída, tooltip, formulario a 760 × 520 y recurso oficial de OpenAI');
  await setTimeout(200);

  if (process.env.STUDIO_QA_INSTALL === '1') {
    await page.getByRole('button', { name: 'Actualización disponible' }).click();
    const closed = page.waitForEvent('close', { timeout: 20_000 });
    await update.getByRole('button', { name: 'Reiniciar para actualizar' }).click({ noWaitAfter: true }).catch((error) => {
      if (!page.isClosed()) throw error;
    });
    await closed;
    log('La aplicación se cerró al lanzar el instalador NSIS de QA');
  }
}
