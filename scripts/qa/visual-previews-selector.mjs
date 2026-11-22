import assert from 'node:assert/strict';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export async function checkSelectorCold(qa) {
  const { boot, close, getPage, invoke, setting, controls, makeConversation, projectId, poll, session, evidence, check, finish } = qa;
  const labels = { claude: 'Claude Code', codex: 'Codex' };
  const versions = { claude: ['haiku', 'medium'], codex: ['gpt-6-luna', 'high'] };
  const selector = () => getPage().getByRole('button', { name: /^Agente para el próximo mensaje/ });
  const model = () => getPage().getByRole('button', { name: /^Modelo:/ });
  const draft = () => getPage().getByRole('textbox', { name: 'Mensaje', exact: true });
  const button = (name) => getPage().getByRole('button', { name, exact: true });
  const choose = async (agent) => {
    await selector().click();
    await getPage().getByRole('menuitemradio', { name: labels[agent], exact: true }).click();
    assert.equal(await selector().getAttribute('aria-label'), 'Agente para el próximo mensaje: ' + labels[agent]);
  };

  for (const [from, to] of [['claude', 'codex'], ['codex', 'claude']]) {
    const conversation = await makeConversation(projectId, 'Arranque · ' + labels[from]);
    await setting('defaults.agent', from);
    await setting('ui.lastConversationId', conversation.id);
    await setting('ui.lastProjectId', projectId);
    await close();
    for (const agent of ['claude', 'codex']) {
      rmSync(join(session, 'catalog-' + agent + '.requested'), { force: true });
      rmSync(join(session, 'catalog-' + agent + '.release'), { force: true });
      controls(agent, { holdCatalog: true });
    }

    await boot();
    await draft().waitFor();
    await poll(() => ['claude', 'codex'].every((agent) => existsSync(join(session, 'catalog-' + agent + '.requested'))), 'Los catálogos no alcanzaron su barrera');
    assert.equal(await selector().getAttribute('aria-label'), 'Agente para el próximo mensaje: ' + labels[from]);
    await choose(to);
    await choose(from);
    await choose(to);
    await draft().fill('[QA:SELECTOR-' + to.toUpperCase() + ']');
    await draft().press('Enter');
    assert(await button('Enviar mensaje').isDisabled());
    assert.equal((await invoke('list_messages', { conversationId: conversation.id })).messages.length, 0);
    await poll(async () => (await invoke('bootstrap')).conversations.find((row) => row.id === conversation.id).lastAgent === to, 'La elección sin modelo no llegó a SQLite');
    await getPage().screenshot({ path: join(evidence, 'selector-carga-' + to + '.png') });

    writeFileSync(join(session, 'catalog-' + from + '.release'), '');
    assert.match(await model().getAttribute('aria-label'), /Cargando/);
    writeFileSync(join(session, 'catalog-' + to + '.release'), '');
    await poll(() => button('Enviar mensaje').isEnabled(), 'Enviar no se habilitó con el catálogo correcto');
    assert.equal(await selector().getAttribute('aria-label'), 'Agente para el próximo mensaje: ' + labels[to]);
    await draft().press('Enter');
    const reply = await finish(conversation.id, 'SELECTOR-' + to.toUpperCase());
    assert.deepEqual([reply.agent, reply.model, reply.effort], [to, ...versions[to]]);
    await getPage().screenshot({ path: join(evidence, 'selector-confirmado-' + to + '.png') });
    check('WebView2 en frío, ' + labels[from] + ' → ' + labels[to] + ', cambios rápidos, SQLite y envío con catálogo propio');
  }
  controls('claude', {});
  controls('codex', {});

  const conversation = await makeConversation(projectId, 'Reintentos de catálogo · RC-09');
  const id = conversation.id;
  await setting('defaults.agent', 'codex');
  await setting('ui.lastConversationId', id);
  await setting('ui.lastProjectId', projectId);
  await getPage().reload();
  await poll(async () => (await model().getAttribute('aria-label')) === 'Modelo: gpt-6-luna', 'No se cargó el modelo inicial');
  const picker = () => getPage().getByRole('dialog', { name: 'Modelo', exact: true });
  const focusIs = (target) => target.evaluate((node) => node === document.activeElement);
  await model().click();
  await picker().getByRole('button', { name: 'gpt-6.2-sol', exact: true }).click();
  await button('Esfuerzo: Alto').click();
  // El menú de esfuerzo se cierra al elegir.
  await getPage().getByRole('menuitemradio', { name: 'Medio', exact: true }).click();
  await poll(async () => {
    const row = (await invoke('bootstrap')).conversations.find((item) => item.id === id);
    return row?.lastModel === 'gpt-6.2-sol' && row.lastEffort === 'medium';
  }, 'La elección manual no llegó a SQLite');

  await close();
  controls('codex', { catalogError: true });
  await boot();
  await poll(async () => (await model().getAttribute('aria-label')) === 'Modelo: Modelos no disponibles', 'El catálogo no mostró el primer fallo');
  await draft().fill('Borrador con elección manual');
  await model().press('Enter');
  const retry = () => picker().getByRole('button', { name: 'Reintentar', exact: true });
  await poll(() => focusIs(retry()), 'El fallo inicial no enfocó Reintentar');
  const requested = join(session, 'catalog-codex.requested');
  const released = join(session, 'catalog-codex.release');
  const retryWith = async (catalogError) => {
    rmSync(requested, { force: true });
    rmSync(released, { force: true });
    controls('codex', { holdCatalog: true, catalogError });
    await getPage().keyboard.press('Enter');
    await poll(() => existsSync(requested), 'El reintento no alcanzó la barrera');
    const loading = picker().getByText('Consultando modelos…', { exact: true });
    await poll(() => focusIs(loading), 'El estado de carga perdió el foco');
    assert(await button('Enviar mensaje').isDisabled());
    assert.equal(await getPage().locator('.composer-defer').count(), 0);
    assert.equal(await selector().getAttribute('aria-label'), 'Agente para el próximo mensaje: Codex');
    assert.equal(await draft().inputValue(), 'Borrador con elección manual');
    writeFileSync(released, '');
  };

  await retryWith(true);
  await poll(() => focusIs(retry()), 'El segundo fallo no devolvió el foco a Reintentar');
  await getPage().screenshot({ path: join(evidence, 'selector-segundo-fallo.png') });
  await retryWith(false);
  const selectedModel = picker().getByRole('button', { name: 'gpt-6.2-sol', exact: true });
  await poll(() => focusIs(selectedModel), 'El modelo manual no recuperó el foco al reintentar');
  assert.equal(await selectedModel.getAttribute('aria-current'), 'true');
  assert(await button('Esfuerzo: Medio').isVisible());
  assert(await button('Enviar mensaje').isEnabled());
  await getPage().keyboard.press('Escape');
  await poll(() => focusIs(model()), 'Cerrar el menú no devolvió el foco al disparador');
  assert.equal((await invoke('list_messages', { conversationId: id })).messages.length, 0);
  controls('codex', {});
  check('RC-09 en WebView2: dos fallos, carga y recuperación con foco, agente y elección manual estables, validación de Enviar');
}

export async function checkChatJump({ page, setting, makeConversation, projectId, load, release, finish, poll, evidence, check }) {
  const id = (await makeConversation(projectId, 'Navegación del historial · RC-10')).id;
  await setting('appearance.intensity', 'balanced');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await load(id, projectId);
  const draft = page.getByRole('textbox', { name: 'Mensaje', exact: true });
  const jump = page.getByRole('button', { name: 'Ir al final', exact: true });
  const scroller = page.locator('.chat-scroll');
  const focusIs = (locator) => locator.evaluate((node) => node === document.activeElement);
  const atBottom = () => scroller.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop < 2);
  const showJump = async () => {
    await scroller.hover();
    await page.mouse.wheel(0, -600);
    await jump.waitFor();
  };
  const afterJump = async () => {
    await poll(atBottom, 'El historial no llegó al final');
    await jump.waitFor({ state: 'hidden' });
    assert(await focusIs(draft), 'Ir al final no dejó el foco en el compositor');
  };

  await draft.fill('[QA:HOLD-CHAT-JUMP]');
  await draft.press('Enter');
  await scroller.getByText('Párrafo largo de comprobación 70.', { exact: true }).waitFor();
  await poll(atBottom, 'El streaming no ancló inicialmente el historial');
  await showJump();
  await scroller.evaluate((node) => {
    const initial = node.scrollTop;
    const end = node.scrollHeight - node.clientHeight;
    const onScroll = () => {
      if (node.scrollTop > initial + 2 && node.scrollTop < end - 2) node.dataset.qaSmoothJump = 'true';
      if (node.scrollTop >= end - 1) node.removeEventListener('scroll', onScroll);
    };
    node.addEventListener('scroll', onScroll);
  });
  await jump.click();
  await afterJump();
  assert.equal(await scroller.getAttribute('data-qa-smooth-jump'), 'true');

  await showJump();
  await page.keyboard.press('Shift+Tab');
  assert(await focusIs(jump), 'Shift+Tab no alcanzó Ir al final');
  await page.keyboard.press('Tab');
  assert(await focusIs(draft), 'Tab no continuó hacia el compositor');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Enter');
  await afterJump();

  await showJump();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Space');
  await afterJump();

  await showJump();
  const readPosition = await scroller.evaluate((node) => node.scrollTop);
  release('HOLD-CHAT-JUMP-MORE');
  await scroller.getByText('Último fragmento de la respuesta.', { exact: true }).waitFor();
  assert(Math.abs((await scroller.evaluate((node) => node.scrollTop)) - readPosition) < 2, 'El streaming desplazó la posición de lectura');
  await page.keyboard.press('Shift+Tab');
  assert(await focusIs(jump));
  await page.mouse.wheel(0, 1200);
  await afterJump();
  release('HOLD-CHAT-JUMP');
  await finish(id, 'HOLD-CHAT-JUMP');
  await poll(atBottom, 'El resultado terminó fuera de vista');
  await page.screenshot({ path: join(evidence, 'historial-final-foco-compositor.png') });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  check('RC-10 en WebView2: clic suave, Enter, Espacio, Tab, Shift+Tab, rueda y foco durante una respuesta larga en streaming');
}
