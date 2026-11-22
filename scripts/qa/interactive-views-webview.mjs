import assert from 'node:assert/strict';
import { basename, join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { definition, deniedWidgetHost, rejected } from './interactive-views-content.mjs';

export async function checkInteractiveViews(qa) {
  const { page, invoke, projectId, projectPath, makeConversation, load, enqueue, req, finish,
    release, poll, evidence, check, startVideo, switchView, switchAgent } = qa;
  const title = 'Galería interactiva · QA';
  const alternate = 'Cambios rápidos · QA';
  const id = (await makeConversation(projectId, title)).id;
  const other = (await makeConversation(projectId, alternate)).id;
  const button = (scope, name) => scope.getByRole('button', { name, exact: true });
  const radio = (scope, name) => scope.getByRole('radio', { name, exact: true });
  const field = (scope, role, name) => scope.getByRole(role, { name, exact: true });
  const region = (scope, name) => scope.getByRole('region', { name, exact: true });
  const output = (scope, name) => scope.locator('output[aria-label="' + name + '"]');
  const article = (msg) => page.locator('#turn-' + msg.id);
  const panel = page.locator('#workbench');
  const modal = page.locator('dialog.visual-expanded[open]');
  const status = page.locator('.stage-slot [role="status"]');
  const composer = field(page, 'textbox', 'Mensaje');
  const openWorkbench = (scope) => button(scope, 'Abrir vista interactiva en Workbench');
  const waitStatus = (value) => poll(async () => (await status.textContent()).includes(value), 'No apareció el estado ' + value);
  const waitText = (locator, value) => poll(async () => (await locator.innerText()).includes(value), 'No apareció ' + value);
  const shot = (name) => page.screenshot({ path: join(evidence, name + '.png'), animations: 'disabled' });
  const shown = async (locator) => { await locator.scrollIntoViewIfNeeded(); await locator.waitFor(); };
  const reveal = async (scope, index, name) => {
    await shown(scope.locator('.widget-mount').nth(index));
    const widget = region(scope, name);
    await shown(widget);
    return widget;
  };
  const widgetAssets = () => page.evaluate(() => performance.getEntriesByType('resource')
    .map((entry) => entry.name).filter((url) => /InteractiveFence-|WidgetPreview-|WidgetViewer-/.test(url)));

  await load(id, projectId);
  await waitStatus('Listo para trabajar');
  assert.deepEqual(await widgetAssets(), []);
  await switchAgent('Codex');
  await composer.fill('[QA:HOLD-WIDGET-CODEX]');
  await composer.press('Enter');
  const live = page.locator('article.turn[data-status=running]');
  await live.locator('[data-stream-pending]').waitFor();
  assert.equal(await live.locator('.widget-frame').count(), 0);
  await release('HOLD-WIDGET-CODEX-FENCE');
  await wait(300);
  assert.equal(await live.locator('.widget-frame').count(), 0);
  assert.deepEqual(await widgetAssets(), []);
  await release('HOLD-WIDGET-CODEX-CLOSE');

  const calc = await reveal(live, 0, 'Calculadora');
  assert((await widgetAssets()).some((url) => url.includes('InteractiveFence-')));
  assert.equal(await output(calc, 'Resultado').innerText(), '10');
  await field(calc, 'spinbutton', 'Primer número').fill('12');
  await radio(calc, 'Sumar').focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  assert(await radio(calc, 'Multiplicar').isChecked());
  assert.equal(await output(calc, 'Resultado').innerText(), '24');
  await release('HOLD-WIDGET-CODEX-MORE');
  await live.getByText(/conserva sus valores mientras llega/).waitFor();
  assert.equal(await output(calc, 'Resultado').innerText(), '24');

  await switchAgent('Claude Code');
  await waitStatus('Codex');
  assert.equal(await page.locator('.stage.agent-activity').getAttribute('data-agent'), 'codex');
  await enqueue(req(id, 'WIDGET-CLAUDE', 'claude'), { defer: true });
  assert.equal((await invoke('message_queue', { conversationId: id })).entries.length, 1);
  await release('HOLD-WIDGET-CODEX');
  const codex = await finish(id, 'HOLD-WIDGET-CODEX');
  assert.equal(codex.agent, 'codex');
  assert(codex.content.includes(definition('calculator')));
  await waitStatus('Codex · Tarea completada');
  const completeCalc = await reveal(article(codex), 0, 'Calculadora');
  assert.equal(await output(completeCalc, 'Resultado').innerText(), '24');
  await waitStatus('Listo para trabajar');
  assert.match(await page.getByRole('button', { name: /^Agente para el próximo mensaje/ }).getAttribute('aria-label'), /Claude Code$/);
  check('Bloque Codex diferido hasta cierre confirmado, estado estable entre deltas y al terminar, agente activo separado de la elección y la cola');

  const endVideo = startVideo('interacciones-webview2.mp4');
  let claude;
  try {
    await openWorkbench(completeCalc).press('Enter');
    await panel.getByRole('tab', { name: 'Calculadora', exact: true }).waitFor();
    assert.equal(await output(panel, 'Resultado').innerText(), '24');
    await button(panel, 'Ampliar vista').press('Enter');
    await modal.waitFor();
    assert.equal(await button(modal, 'Cerrar vista ampliada').evaluate((node) => document.activeElement === node), true);
    await page.keyboard.press('Tab');
    assert(await modal.evaluate((node) => node.contains(document.activeElement)));
    await page.keyboard.press('Shift+Tab');
    assert(await modal.evaluate((node) => node.contains(document.activeElement)));
    if (process.argv.includes('--rc1')) {
      const size = await modal.evaluate((node) => ({ dialog: node.clientHeight, window: innerHeight }));
      assert(size.dialog < size.window * 0.75, 'La calculadora ampliada tiene demasiada altura vacía');
    }
    await field(modal, 'spinbutton', 'Segundo número').fill('3');
    assert.equal(await output(modal, 'Resultado').innerText(), '36');
    await shot('01-calculadora');
    await wait(475);
    await button(modal, 'Definición').click();
    assert.equal(await region(modal, 'Definición original').locator('code').innerText(), definition('calculator'));
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await button(modal, 'Copiar definición').click();
    await modal.getByText('Definición copiada', { exact: true }).waitFor({ state: 'attached' });
    await poll(async () => (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n') === definition('calculator'), 'La definición copiada cambió');
    await button(modal, 'Vista').click();
    assert.equal(await output(modal, 'Resultado').innerText(), '36');
    await modal.press('Escape');
    assert.equal(await modal.count(), 0);
    assert.equal(await button(panel, 'Ampliar vista').evaluate((node) => document.activeElement === node), true);
    await panel.getByRole('tab', { name: 'Actividad', exact: true }).click();
    await panel.getByRole('tab', { name: 'Calculadora', exact: true }).click();
    assert.equal(await output(panel, 'Resultado').innerText(), '36');
    await button(panel, 'Cerrar pestaña Calculadora').click();
    await button(panel, 'Cerrar Workbench').click();
    await openWorkbench(completeCalc).click();
    assert.equal(await output(panel, 'Resultado').innerText(), '36');
    await button(panel, 'Cerrar Workbench').click();

    await invoke('update_message_queue', { conversationId: id, action: { type: 'resume' } });
    claude = await finish(id, 'WIDGET-CLAUDE');
    assert.equal(claude.agent, 'claude');
    await waitStatus('Claude Code · Tarea completada');
    const turn = article(claude);
    assert.equal(await turn.locator('[data-visual-kind="widget"]').count(), 4);
    const dashboard = await reveal(turn, 0, 'Dashboard de entregas');
    await field(dashboard, 'combobox', 'Área').selectOption('Sur');
    assert.equal(await output(dashboard, 'Entregas').innerText(), '160');
    assert.equal(await output(dashboard, 'Objetivo').innerText(), '158');
    assert.equal(await dashboard.locator('svg.widget-plot rect').count(), 4);
    await shot('02-dashboard');
    await wait(475);

    const table = await reveal(turn, 1, 'Tabla de revisiones');
    const grid = table.getByRole('table');
    await button(grid, 'Pendientes').press('Enter');
    assert.equal(await grid.getByRole('columnheader', { name: 'Pendientes' }).getAttribute('aria-sort'), 'ascending');
    assert.match(await grid.getByRole('row').nth(1).innerText(), /Atlas/);
    await button(grid, 'Pendientes').press('Enter');
    assert.match(await grid.getByRole('row').nth(1).innerText(), /Brújula/);
    const row = table.getByRole('checkbox', { name: /Atlas/ });
    await row.press('Space');
    const filter = field(table, 'textbox', 'Filtrar por proyecto');
    await filter.fill('xyz');
    await table.getByText('No hay filas que coincidan.').waitFor();
    await filter.fill('ATL');
    assert(await row.isChecked());
    await filter.fill('');
    await shot('03-tabla');
    await wait(475);

    const form = await reveal(turn, 2, 'Configuración local');
    const name = field(form, 'textbox', 'Nombre del informe');
    await button(form, 'Validar configuración').press('Enter');
    await waitText(form, 'Completa este campo.');
    await poll(() => name.evaluate((node) => document.activeElement === node && node.getAttribute('aria-invalid') === 'true'), 'La validación no devolvió el foco al campo');
    await name.fill('Informe Sur');
    await field(form, 'combobox', 'Formato').selectOption('detallado');
    await field(form, 'checkbox', 'Incluir totales').press('Space');
    await button(form, 'Mostrar u ocultar selección').click();
    assert.equal(await output(form, 'Nombre').innerText(), 'Informe Sur');
    assert.equal(await output(form, 'Totales').innerText(), 'Sí');
    await waitText(form, 'Los valores son válidos.');
    await shot('04-formulario');
    await wait(475);

    const simulation = await reveal(turn, 3, 'Simulación de carga');
    await openWorkbench(simulation).click();
    await button(panel, 'Ampliar vista').click();
    const graph = modal.locator('polyline');
    const before = await graph.getAttribute('points');
    const slider = field(modal, 'slider', 'Carga final');
    await slider.press('End');
    assert.notEqual(await graph.getAttribute('points'), before);
    assert.match(await output(modal, 'Variación').innerText(), /^86/);
    await modal.getByText('Datos del gráfico', { exact: true }).press('Enter');
    const series = modal.getByRole('table', { name: 'Progresión de la carga' });
    await series.waitFor();
    assert.match(await series.getByRole('row').last().innerText(), /100/);
    await modal.getByText('Datos del gráfico', { exact: true }).press('Enter');
    await shot('05-simulacion-ampliada');
    await wait(475);
    await modal.press('Escape');
    await button(panel, 'Cerrar Workbench').click();
    assert(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches));
    assert.equal(await simulation.locator('.widget-ui').evaluate((node) => getComputedStyle(node).animationName), 'none');
    check('Cinco demos funcionales con teclado, validación con foco, datos del gráfico, definición copiable y estado compartido en Workbench');
  } finally {
    await endVideo();
  }

  await load(id, projectId);
  await waitStatus('Listo para trabajar');
  await reveal(article(codex), 0, 'Calculadora');
  assert.equal(await output(region(article(codex), 'Calculadora'), 'Resultado').innerText(), '10');
  assert((await invoke('list_messages', { conversationId: id })).messages.some((message) => message.id === claude.id
    && message.content.includes(definition('simulation'))));

  const project = basename(projectPath);
  await switchAgent('Codex');
  await composer.fill('[QA:HOLD-WIDGET-CHANGE]');
  await composer.press('Enter');
  await waitStatus('Codex');
  await openWorkbench(region(article(codex), 'Calculadora')).click();
  await switchView(project, alternate);
  await waitStatus('Listo para trabajar');
  assert.equal(await panel.getByRole('tab', { name: 'Calculadora', exact: true }).count(), 0);
  assert.equal(await page.locator('.widget-frame').count(), 0);
  await release('HOLD-WIDGET-CHANGE');
  await finish(id, 'HOLD-WIDGET-CHANGE');
  await switchView(project, title);
  await waitStatus('Listo para trabajar');
  check('Reapertura desde SQLite y cambio rápido entre conversaciones sin resucitar una finalización ni un widget de otro chat');

  const remote = [];
  const observer = (request) => {
    const url = new URL(request.url());
    if (url.hostname === deniedWidgetHost || (/^https?:$/.test(url.protocol) && !['tauri.localhost', 'ipc.localhost'].includes(url.hostname))) {
      remote.push(request.url());
    }
  };
  const checkWidgetIpc = async (interact) => {
    await page.evaluate(() => {
      const fetchNative = window.fetch;
      window.widgetQaCalls = [];
      window.fetch = function (request, ...args) {
        if (new URL(typeof request === 'string' ? request : request.url, location.href).hostname === 'ipc.localhost') {
          window.widgetQaCalls.push(request);
        }
        return fetchNative.call(this, request, ...args);
      };
      window.restoreWidgetQaFetch = () => { window.fetch = fetchNative; };
    });
    try {
      await interact();
      assert.deepEqual(await page.evaluate(() => ({
        calls: window.widgetQaCalls, executed: window.widgetQaExecuted ?? false,
      })), { calls: [], executed: false });
    } finally {
      await page.evaluate(() => window.restoreWidgetQaFetch());
    }
  };
  page.on('request', observer);
  try {
    await composer.fill('[QA:WIDGET-SECURITY]');
    await composer.press('Enter');
    const invalid = await finish(id, 'WIDGET-SECURITY');
    const blocks = article(invalid).locator('.widget-mount');
    await blocks.first().waitFor();
    assert.equal(await blocks.count(), rejected.length);
    for (const [index, [, source, diagnostic]] of rejected.entries()) {
      const block = blocks.nth(index);
      await shown(block);
      await block.getByText('No se pudo mostrar la vista interactiva.', { exact: false }).waitFor();
      await waitText(block, diagnostic);
      assert.equal(await block.locator('.widget-ui, iframe, script, a, img, [src], [href], [onclick]').count(), 0);
      await button(block, 'Definición').click();
      assert.equal(await region(block, 'Definición original').locator('code').innerText(), source);
      await button(block, 'Vista').click();
    }

    const last = blocks.last();
    await openWorkbench(last).click();
    await button(panel, 'Ampliar vista').waitFor();
    await checkWidgetIpc(async () => {
      await button(panel, 'Ampliar vista').click();
      await modal.getByText(/No se pudo mostrar la vista interactiva/).waitFor();
      await button(modal, 'Definición').click();
      assert.match(await region(modal, 'Definición original').innerText(), /invoke/);
      await modal.press('Escape');
    });
    // Al volver a Actividad, Workbench consulta sus propios datos mediante IPC.
    await button(panel, 'Cerrar pestaña Widget interactivo').click();
    await button(panel, 'Cerrar Workbench').click();

    const good = await reveal(article(codex), 0, 'Calculadora');
    await checkWidgetIpc(async () => {
      await field(good, 'spinbutton', 'Primer número').fill('20');
      assert.equal(await output(good, 'Resultado').innerText(), '22');
    });
    assert.deepEqual(remote, []);
    assert.match(page.url(), /tauri\.localhost/);
    await shot('06-aislamiento');
    check('WebView2 rechaza 11 entradas adversarias, conserva cada definición y recupera la interacción sin código, navegación, red remota ni llamadas IPC del widget');
  } finally {
    page.off('request', observer);
  }

  await page.keyboard.press('Control+f');
  const search = field(page, 'searchbox', 'Buscar en la conversación');
  await search.fill('Simulación de carga');
  await waitText(page.getByRole('search').locator('output'), '1 de 1');
  await search.press('Escape');
  await search.waitFor({ state: 'hidden' });

  const dimensions = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  try {
    const resize = (width) => page.setViewportSize({ width, height: 650 });
    const expand = button(panel, 'Ampliar vista');
    await resize(1440);
    const good = await reveal(article(codex), 0, 'Calculadora');
    await openWorkbench(good).press('Enter');
    await page.locator('#workbench[open]:not(:modal)').waitFor();
    const host = await panel.elementHandle();
    try {
      for (const widths of [[1360, 1000, 800, 760], [800, 1000, 1360, 1440]]) {
        await expand.press('Enter');
        const input = field(modal, 'spinbutton', 'Primer número');
        await input.focus();
        const original = await input.elementHandle();
        try {
          for (const width of widths) {
            await resize(width);
            assert(await original.evaluate((node) => node.isConnected && document.activeElement === node));
            assert.equal(await output(modal, 'Resultado').innerText(), '22');
            assert(await modal.evaluate((node) => node.getBoundingClientRect().width <= window.innerWidth));
            assert(await page.locator('.chat-scroll').evaluate((node) => node.scrollWidth <= node.clientWidth + 1));
          }
          if (widths.at(-1) === 760) await shot('07-ventana-estrecha');
        } finally {
          await original.dispose();
        }
        await page.keyboard.press('Escape');
        await modal.waitFor({ state: 'hidden' });
        await page.locator(widths.at(-1) === 760 ? '#workbench:modal' : '#workbench[open]:not(:modal)').waitFor();
        assert(await host.evaluate((node) => node.isConnected && node.matches(':modal') === (window.innerWidth === 760)));
        assert(await expand.evaluate((node) => document.activeElement === node));
        assert.equal(await panel.getByRole('tab', { selected: true }).innerText(), 'Calculadora');
      }
      assert(await host.evaluate((node) => node.clientHeight === node.parentElement.clientHeight));
      await resize(760);
      await page.locator('#workbench:modal').waitFor();
      assert(await host.evaluate((node) => node.isConnected));
      assert(await expand.evaluate((node) => document.activeElement === node));
      assert.equal(await output(panel, 'Resultado').innerText(), '22');
    } finally {
      await host.dispose();
    }
    await button(panel, 'Cerrar Workbench').click();
  } finally {
    await page.setViewportSize(dimensions);
  }
  check('RC-11: el mismo Workbench y el mismo control del widget conservan navegación, foco y valor al pasar entre 1440, 1360, 1000, 800 y 760 px');
}
