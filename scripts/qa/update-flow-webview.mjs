import assert from 'node:assert/strict';

export default async function verifyUpdate(page, { mode, invoke, log, startAgent }) {
  const dialog = page.getByRole('dialog', { name: 'Novedades de Duovra' });
  const link = page.locator('[data-update-link]').first();
  const screen = page.locator('dialog.update-screen');
  const confirm = dialog.getByRole('button', { name: 'Actualizar ahora' });
  const retry = screen.getByRole('button', { name: 'Reintentar', exact: true });
  const leave = screen.getByRole('button', { name: 'Volver a Duovra' });
  const error = async (text) => {
    const detail = screen.locator('[data-phase="error"] #update-detail').filter({ hasText: text });
    await detail.waitFor({ timeout: 45_000 });
    log(await detail.textContent());
  };
  const check = () => invoke('check_update');

  assert.equal(await check(), null);
  await mode('older');
  assert.equal(await check(), null);
  for (const bad of ['metadata', 'architecture']) {
    await mode(bad);
    await assert.rejects(check(), /No se pudo consultar el canal/);
  }
  await mode('download-error');
  await page.reload();
  await link.click({ timeout: 25_000 });
  await dialog.getByText(/Canal local de QA/).waitFor();
  await confirm.click();
  await error('No se pudo descargar');
  await mode('interrupted');
  await retry.click();
  await retry.waitFor({ state: 'hidden' });
  await error('No se pudo descargar');
  await mode('signature');
  await retry.click();
  await retry.waitFor({ state: 'hidden' });
  await error('No se pudo verificar');

  // Cambiar la versión del manifiesto requiere mostrar sus notas y pedir otra confirmación.
  await mode('version');
  await retry.click();
  await dialog.getByText('Duovra 9.9.9', { exact: true }).waitFor();
  await confirm.click();
  await error('No se pudo verificar');
  await mode('installer-failure');
  await retry.click();
  await dialog.getByText(/Canal local de QA/).waitFor();
  await confirm.click();
  await error('No se pudo iniciar el instalador verificado');
  assert.equal((await invoke('bootstrap')).settings['updates.pending'], null);
  await leave.click();

  // La comprobación elimina el instalador fallido y permite obtener el artefacto válido.
  await mode('current');
  await page.reload();
  assert.equal(await check(), null);
  await mode('valid');
  await page.reload();
  const tag = await startAgent();
  await link.click({ timeout: 25_000 });
  await confirm.click();
  await screen.locator('[role=progressbar][aria-valuenow]').first().waitFor({ timeout: 60_000 });
  await screen.getByRole('heading', { name: 'Esperando a los agentes' }).waitFor({ timeout: 90_000 });
  assert((await invoke('bootstrap')).activeRuns.length);
  await assert.rejects(invoke('install_update', { version: tag.version }), /Espera a que los agentes terminen/);
  log('Actualizador: 204, versión anterior, manifiesto y arquitectura inválidos, HTTP 503, corte, firma y versión manipuladas, fallo de NSIS, progreso y agentes activos.');
  const closed = page.waitForEvent('close', { timeout: 90_000 });
  await tag.release();
  // El runner verifica por CDP el reinicio automático y la base SQLite tras NSIS.
  await closed;
}
