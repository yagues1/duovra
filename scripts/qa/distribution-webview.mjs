import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

export default async function verifyReport(page, { mode, invoke, live, log }) {
  const trigger = page.getByRole('button', { name: 'Reportar un error', exact: true });
  await trigger.click();
  const report = page.getByRole('dialog', { name: 'Reportar un error' });
  const button = (name) => report.getByRole('button', { name, exact: true });
  const field = (name) => report.getByRole('textbox', { name, exact: true });
  await button('Enviar reporte').click();
  await report.getByRole('alert').filter({ hasText: 'Revisa el campo indicado' }).waitFor();
  assert(await field('Título del problema').evaluate((element) => document.activeElement === element));
  await field('Título del problema').fill('QA Duovra 1.0.1 - formulario de Windows');
  await field('Descripción').fill('Reporte sintético de prueba. Correo ficticio: demo@example.test');
  await field('Pasos para reproducirlo').fill('Abrir el formulario y adjuntar el icono de QA.');
  const input = report.locator('input[type=file]');
  await input.setInputFiles('src-tauri/icons/128x128.png');
  await report.getByAltText('Vista previa de la captura que se adjuntará').waitFor();
  const consent = report.getByRole('checkbox');
  await consent.check();
  if (!live) {
    await mode('report-unavailable');
    await button('Enviar reporte').click();
    await report.getByRole('alert').filter({ hasText: 'No se pudo confirmar' }).waitFor();
    await mode('report-error');
    await button('Reintentar').click();
    await report.getByRole('alert').filter({ hasText: 'No se recibió confirmación' }).waitFor();
    let draft = (await invoke('bootstrap')).settings['report.draft'];
    assert.equal(draft.attempted, true);
    assert.equal(draft.consent, undefined);
    assert.equal(draft.capture, undefined);
    await button('Cancelar').click();
    assert(await trigger.evaluate((element) => document.activeElement === element));
    await trigger.click();
    assert.equal(await field('Título del problema').inputValue(), draft.title);
    assert.equal(await consent.isChecked(), false);
    assert.equal((await invoke('bootstrap')).settings['report.draft'].id, draft.id);
    // La captura no persiste. El servidor ya procesó el envío anterior con ese UUID.
    await consent.check();
    await mode('current');
    await button('Enviar reporte').click();
    await report.getByRole('status').filter({ hasText: 'n.º 42' }).waitFor();
    log('Reportes en WebView2: validación, consentimiento, servicio ausente, conexión interrumpida, borrador y recibo duplicado.');
  } else {
    await button('Enviar reporte').click();
    const receipt = report.getByRole('status').filter({ hasText: /Reporte recibido · n.º \d+/i });
    await receipt.waitFor({ timeout: 45_000 });
    const number = /n.º (\d+)/.exec(await receipt.textContent())[1];
    const issue = JSON.parse(execFileSync('gh', ['issue', 'view', number, '-R', 'yagues1/duovra-reports',
      '--json', 'number,title,body'], { encoding: 'utf8' }));
    assert.equal(issue.title, 'QA Duovra 1.0.1 - formulario de Windows');
    assert.match(issue.body, /Captura privada: reports\/[a-f0-9-]+\.jpg/);
    assert.doesNotMatch(issue.body, /demo@example\.test/);
    log(`Reporte auténtico con captura confirmado en WebView2 y en el repositorio privado, incidencia #${number}.`);
  }
  await button('Cerrar').last().click();
}
