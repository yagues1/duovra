import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deniedHost, flow, html, icon } from './visual-previews-content.mjs';

export async function checkVisualPreviews(qa) {
  const { page, invoke, makeConversation, projectId, projectPath, session, load, enqueue, req, finish, release, poll, evidence, check, startVideo } = qa;
  const id = (await makeConversation(projectId, 'Vistas visuales · QA')).id;
  const fileHtml = join(projectPath, 'estado.html');
  const fileSvg = join(projectPath, 'orbita.svg');
  writeFileSync(fileHtml, html);
  writeFileSync(fileSvg, icon);
  writeFileSync(join(projectPath, 'ilustracion.svg'), '<svg viewBox="0 0 2200 1400"><title>Ilustración amplia</title>' +
    '<circle cx="1100" cy="700" r="615" fill="#8498cf"/><circle cx="1300" cy="330" r="150" fill="#b3e2d2"/></svg>');
  writeFileSync(join(projectPath, 'grande.html'), '<main>' + 'a'.repeat(200_000) + '</main>');
  writeFileSync(join(session, 'externo-qa.html'), '<p>Archivo temporal fuera del proyecto</p>');

  const shot = (name) => page.screenshot({ path: join(evidence, name + '.png') });
  const panel = page.locator('#workbench');
  const modal = page.locator('dialog.visual-expanded[open]');
  const preview = (root) => root.getByRole('button', { name: 'Vista previa', exact: true });
  const code = (root) => root.getByRole('button', { name: 'Código', exact: true });
  const controls = (root, name) => root.getByRole('button', { name, exact: true });
  const iframe = (root) => root.frameLocator('iframe');
  const focused = (locator) => locator.evaluate((node) => node === node.ownerDocument.activeElement);
  const frameArea = () => modal.locator('.visual-canvas[tabindex]');
  const frameClose = () => controls(modal, 'Cerrar vista HTML ampliada');
  const resizeExpanded = async (element) => {
    const initial = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    const original = await element.elementHandle();
    const active = await page.evaluateHandle(() => document.activeElement);
    try {
      for (const width of [1440, 1360, 1000, 800, 760]) {
        await page.setViewportSize({ width, height: 650 });
        assert(await original.evaluate((node) => node.isConnected && node.closest('dialog').matches(':modal')));
        assert(await active.evaluate((node) => document.activeElement === node));
        assert.equal(await element.count(), 1);
      }
    } finally {
      await page.setViewportSize(initial);
      await active.dispose();
      await original.dispose();
    }
  };
  const diagram = (root) => root.locator('[data-visual-kind="mermaid"]');
  const article = (id) => page.locator('#turn-' + id);
  const imageReady = async (target) => {
    await target.waitFor();
    await poll(() => target.evaluate((img) => img.complete && img.naturalWidth > 0), 'La imagen visual no se decodificó');
  };
  const sendUI = async (tag, agent = 'Codex') => {
    const picker = page.getByRole('button', { name: /^Agente para el próximo mensaje/ });
    if (!(await picker.getAttribute('aria-label')).endsWith(agent)) {
      await picker.click();
      await page.getByRole('menuitemradio', { name: agent, exact: true }).click();
    }
    await page.getByRole('textbox', { name: 'Mensaje', exact: true }).fill('[QA:' + tag + ']');
    await controls(page, 'Enviar mensaje').click();
    return poll(async () => {
      const { messages } = await invoke('list_messages', { conversationId: id });
      const index = messages.findIndex((row) => row.role === 'user' && row.content.includes('[QA:' + tag + ']'));
      return index >= 0 && messages[index + 1];
    }, 'El envío desde el compositor no llegó a SQLite');
  };
  const requests = [];
  page.on('request', (request) => { if (request.url().includes(deniedHost)) requests.push(request.url()); });
  await page.route('https://' + deniedHost + '/**', (route) => route.abort());
  await load(id, projectId);
  const visualChunks = () => page.evaluate(() => performance.getEntriesByType('resource')
    .map((entry) => entry.name).filter((name) => /\/(?:mermaid\.|mermaid-|html-|VisualViewer-)/.test(name)));
  assert.deepEqual(await visualChunks(), []);

  const c = await sendUI('HOLD-VISUAL-CODEX');
  const live = article(c.id);
  await live.locator('[data-stream-pending]').waitFor();
  assert.equal(await live.locator('img').count(), 0);
  assert.equal(await live.getByText(/No se pudo dibujar el diagrama/).count(), 0);
  await shot('mermaid-streaming');
  release('HOLD-VISUAL-CODEX-CLOSE');
  await imageReady(diagram(live).first().locator('img'));
  assert.equal(await live.locator('.live-text').count() > 0, true);
  assert((await visualChunks()).some((name) => name.includes('mermaid.core')));
  release('HOLD-VISUAL-CODEX');
  const codex = await finish(id, 'HOLD-VISUAL-CODEX');
  assert.equal(codex.agent, 'codex');
  assert(codex.content.includes(flow));
  for (const block of await diagram(article(codex.id)).all()) {
    await block.scrollIntoViewIfNeeded();
    await imageReady(block.locator('img'));
  }
  check('Codex simulado: streaming parcial sin errores y cerca cerrada renderizada durante el turno, flujo, secuencia y clases');

  await invoke('send_message', { request: {
    ...req(id, 'VISUAL-CLAUDE', 'claude'), text: 'Muestra @"estado.html" [QA:VISUAL-CLAUDE]', attachments: [fileSvg],
  } });
  const claude = await finish(id, 'VISUAL-CLAUDE');
  assert.equal(claude.agent, 'claude');
  assert(claude.content.includes(html));
  await load(id, projectId);
  const cl = article(claude.id);
  const before = diagram(article(codex.id)).first();
  const openDiagram = controls(before, 'Ampliar diagrama en Workbench');
  await before.scrollIntoViewIfNeeded();
  const endVideo = startVideo('vistas-webview2.mp4');
  try {
    await imageReady(before.locator('img'));
    await shot('mermaid-chat');
    await openDiagram.click();
    await panel.getByRole('tab', { name: 'Diagrama Mermaid', exact: true }).waitFor();
    await imageReady(panel.locator('.visual-canvas img'));
    await controls(panel, 'Ampliar vista').press('Enter');
    await imageReady(modal.locator('img'));
    const small = modal.getByRole('region', { name: 'Área del diagrama' });
    const centered = await small.evaluate((box) => {
      const image = box.querySelector('img').getBoundingClientRect();
      const area = box.getBoundingClientRect();
      return Math.abs(image.left + image.width / 2 - area.left - box.clientWidth / 2) < 2
        && Math.abs(image.top + image.height / 2 - area.top - box.clientHeight / 2) < 2;
    });
    assert(centered, 'El diagrama pequeño no quedó centrado en ambos ejes');
    await shot('mermaid-ampliado');
    await controls(modal, 'Aumentar zoom').click();
    await modal.getByLabel('Nivel de zoom').waitFor();
    await controls(modal, 'Ajustar a vista').click();
    assert.equal(await controls(modal, 'Ajustar a vista').getAttribute('aria-pressed'), 'true');
    await resizeExpanded(modal.locator('img'));
    assert.equal(await controls(modal, 'Ajustar a vista').getAttribute('aria-pressed'), 'true');
    await modal.press('Escape');
    assert.equal(await modal.count(), 0);
    assert(await controls(panel, 'Ampliar vista').evaluate((node) => document.activeElement === node));
    await code(panel).click();
    assert.match(await panel.locator('.visual-source').innerText(), /flowchart LR/);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await controls(panel, 'Copiar Mermaid').click();
    await poll(async () => await page.evaluate(async () => (await navigator.clipboard.readText()).replace(/\r\n/g, '\n')) === flow, 'La copia no conservó el código Mermaid');
    await controls(panel, 'Diagrama').click();

    await preview(cl).first().scrollIntoViewIfNeeded();
    const readPosition = () => page.locator('.chat-scroll').evaluate((node) => node.scrollTop);
    const top = await readPosition();
    await preview(cl).first().click();
    await iframe(panel).getByRole('heading', { name: 'Estado de publicación' }).waitFor();
    assert(Math.abs(await readPosition() - top) < 2, 'El chat cambió de posición al cambiar el visor');
    assert.equal(await panel.getByRole('tab', { name: 'Diagrama Mermaid', exact: true }).count(), 1);
    await shot('html-workbench');
    await controls(panel, 'Ampliar vista').click();
    await iframe(modal).getByRole('heading', { name: 'Estado de publicación' }).waitFor();
    await shot('html-ampliado');
    await modal.getByLabel('Anchura de la vista HTML').selectOption('mobile');
    assert.equal(await modal.locator('iframe').evaluate((node) => node.clientWidth), 390);
    await resizeExpanded(modal.locator('iframe'));
    assert.equal(await modal.getByLabel('Anchura de la vista HTML').inputValue(), 'mobile');
    await frameArea().focus();
    for (let i = 0; i < 2 && !await focused(frameClose()); i++) await page.keyboard.press('Tab');
    assert(await focused(frameClose()), 'El documento sin controles no devolvió el foco al cierre del diálogo');
    await page.keyboard.press('Enter');
    await modal.waitFor({ state: 'hidden' });
    assert(await focused(controls(panel, 'Ampliar vista')));
    await code(panel).click();
    assert.match(await panel.locator('.visual-source').innerText(), /<style>/);
    await preview(panel).click();
    await controls(panel, 'Recargar HTML').click();
    await iframe(panel).getByRole('heading', { name: 'Estado de publicación' }).waitFor();

    await preview(cl).nth(1).click();
    await imageReady(panel.locator('.visual-canvas img'));
    await panel.getByText('SVG · 360 × 220', { exact: true }).waitFor();
    await shot('svg-workbench');
    await controls(panel, 'Fondo claro').click();
    assert.equal(await panel.locator('.visual-canvas').getAttribute('data-background'), 'light');
    await controls(panel, 'Aumentar zoom').click();
    await controls(panel, 'Reducir zoom').click();
    await controls(panel, 'Ampliar vista').press('Enter');
    await imageReady(modal.locator('.visual-canvas img'));
    await resizeExpanded(modal.locator('img'));
    assert.equal(await modal.locator('.visual-canvas').getAttribute('data-background'), 'light');
    await modal.press('Escape');
    await controls(panel, 'Copiar SVG').click();
    await poll(async () => await page.evaluate(async () => (await navigator.clipboard.readText()).replace(/\r\n/g, '\n')) === icon, 'La copia no conservó el código SVG');
    await controls(panel, 'Cerrar pestaña SVG').click();
    assert.equal(await panel.getByRole('tab', { name: 'HTML', exact: true }).getAttribute('aria-selected'), 'true');
    await preview(cl).nth(2).click();
    await iframe(panel).getByRole('heading', { name: 'HTML reparado & visible' }).waitFor();
    await controls(panel, 'Ampliar vista').press('Enter');
    await iframe(modal).getByRole('heading', { name: 'HTML reparado & visible' }).waitFor();
    await modal.press('Escape');
    assert(await focused(controls(panel, 'Ampliar vista')));
  } finally {
    await endVideo();
  }
  check('Claude simulado: HTML y SVG visibles, HTML malformado recuperado, código, copiado, recarga, zoom, fondo, modal y retorno a la pestaña anterior');

  const activity = cl.locator('.activity-head');
  assert.equal(await activity.getAttribute('aria-expanded'), 'false');
  await activity.click();
  await cl.getByRole('button', { name: /RenderReport/ }).click();
  await cl.getByRole('button', { name: 'Vista previa HTML' }).click();
  await iframe(panel).getByRole('heading', { name: 'Resultado de herramienta' }).waitFor();
  const user = page.locator('.msg-user').filter({ hasText: 'VISUAL-CLAUDE' });
  await controls(user, 'Abrir estado.html en Workbench').click();
  await iframe(panel).getByRole('heading', { name: 'Estado de publicación' }).waitFor();
  await controls(user, 'Abrir orbita.svg en Workbench').click();
  await imageReady(panel.locator('.visual-canvas img'));
  await panel.getByRole('tab', { name: 'Archivos', exact: true }).click();
  await panel.getByRole('button', { name: 'grande.html', exact: true }).click();
  await poll(async () => (await panel.locator('.visual-source').innerText({ timeout: 800 })).includes('<main>'),
    'El archivo grande no terminó de cargar en la vista de código');
  await preview(panel).click();
  await panel.getByText(/supera el límite/).waitFor();
  assert.equal(await panel.locator('iframe').count(), 0);
  await panel.getByRole('tab', { name: 'Archivos', exact: true }).click();
  await panel.getByRole('button', { name: 'estado.html', exact: true }).click();
  await preview(panel).click();
  await iframe(panel).getByRole('heading', { name: 'Estado de publicación' }).waitFor();
  writeFileSync(fileHtml, html.replace('Estado de publicación', 'Estado actualizado'));
  await controls(panel, 'Recargar archivo').click();
  await iframe(panel).getByRole('heading', { name: 'Estado actualizado' }).waitFor();
  await panel.getByRole('tab', { name: 'Archivos', exact: true }).click();
  await panel.getByRole('button', { name: 'ilustracion.svg', exact: true }).click();
  await preview(panel).click();
  await imageReady(panel.locator('.visual-canvas img'));
  await panel.getByText(/2200 × 1400/).waitFor();
  await assert.rejects(invoke('workspace_read', { projectId, path: '../externo-qa.html' }));
  check('Herramienta, referencia @, adjunto SVG interno, explorador, lectura segura, recarga desde disco y límite de tamaño');

  await sendUI('VISUAL-SEGURIDAD');
  const blocked = await finish(id, 'VISUAL-SEGURIDAD');
  const securityTurn = article(blocked.id);
  await preview(securityTurn).first().click();
  const safe = iframe(panel);
  await safe.getByRole('heading', { name: 'Vista estática · prueba' }).waitFor();
  assert.equal(await panel.locator('iframe').getAttribute('sandbox'), '');
  assert.equal(await panel.locator('iframe').getAttribute('referrerpolicy'), 'no-referrer');
  assert.doesNotMatch(await panel.locator('iframe').getAttribute('srcdoc'), /visual-preview\.invalid/);
  const boundary = await safe.locator('html').evaluate((node) => {
    let parentReadable = true;
    try { void parent.document.body; } catch { parentReadable = false; }
    return { origin: window.origin, parentReadable, nativeBridge: typeof window.chrome?.webview,
      ipcPolicy: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content.includes("connect-src 'none'"),
      executed: node.dataset.previewExecuted, loaded: node.dataset.previewLoaded, frame: location.href };
  });
  assert.deepEqual(boundary, { origin: 'null', parentReadable: false, nativeBridge: 'undefined', ipcPolicy: true, executed: undefined, loaded: undefined, frame: 'about:srcdoc' });
  assert.equal(await safe.locator('script, iframe, [onload], [onclick], [action], [formaction], a[href], base, meta[http-equiv="refresh"]').count(), 0);
  await safe.getByText('Enlace de prueba', { exact: true }).click();
  await safe.getByRole('button', { name: 'Enviar formulario' }).click();
  await safe.getByRole('heading', { name: 'Vista estática · prueba' }).waitFor();
  assert.match(page.url(), /tauri\.localhost/);
  await panel.getByText(/JavaScript desactivado/).waitFor();
  await shot('html-seguridad');
  await controls(panel, 'Ampliar vista').press('Enter');
  const expandedFrame = iframe(modal);
  const local = expandedFrame.getByRole('textbox', { name: 'Campo local' });
  assert(await expandedFrame.getByRole('textbox', { name: 'Campo deshabilitado' }).isDisabled());
  await frameArea().focus();
  await page.keyboard.press('Tab');
  assert(await focused(local));
  await resizeExpanded(modal.locator('iframe'));
  assert(await focused(local));
  await page.keyboard.press('Escape');
  assert(await modal.isVisible(), 'El Escape del documento aislado no debe requerir acceso al diálogo padre');
  await page.keyboard.press('Shift+Tab');
  assert(await focused(frameArea()));
  await page.keyboard.press('Escape');
  await modal.waitFor({ state: 'hidden' });
  assert(await focused(controls(panel, 'Ampliar vista')));
  await page.keyboard.press('Enter');
  await local.waitFor();
  await frameArea().focus();
  await page.keyboard.press('Tab');
  assert(await focused(local));
  await page.keyboard.press('Tab');
  assert(await focused(expandedFrame.getByRole('button', { name: 'Enviar formulario' })));
  await page.keyboard.press('Tab');
  assert(await focused(frameClose()));
  await page.keyboard.press('Space');
  await modal.waitFor({ state: 'hidden' });
  assert(await focused(controls(panel, 'Ampliar vista')));
  check('RC-12: Tab y Mayús+Tab salen del HTML aislado, cierre con Escape, Enter y Espacio y retorno al disparador con HTML sin controles, malformado y formulario bloqueado');

  await preview(securityTurn).nth(1).click();
  const svg = panel.locator('.visual-canvas img');
  await imageReady(svg);
  const sanitized = decodeURIComponent((await svg.getAttribute('src')).split(',').slice(1).join(','));
  assert.doesNotMatch(sanitized, /<script|onload=|onclick=|<foreignObject|https:\/\/visual-preview|<animate\b/);
  await code(panel).click();
  assert.match(await panel.locator('.visual-source').innerText(), /onclick=/);

  const secureDiagrams = diagram(securityTurn);
  await secureDiagrams.nth(0).scrollIntoViewIfNeeded();
  await imageReady(secureDiagrams.nth(0).locator('img'));
  const isolatedSvg = decodeURIComponent((await secureDiagrams.nth(0).locator('img').getAttribute('src')).split(',').slice(1).join(','));
  assert.doesNotMatch(isolatedSvg, /<img\b|<(?:a|image)\b[^>]*(?:href|src)\s*=\s*["']https:/i);
  await secureDiagrams.nth(1).scrollIntoViewIfNeeded();
  await secureDiagrams.nth(1).getByText(/No se pudo dibujar el diagrama/).waitFor();
  assert.match(await secureDiagrams.nth(1).locator('pre').innerText(), /A\[/);
  await secureDiagrams.nth(2).scrollIntoViewIfNeeded();
  await imageReady(secureDiagrams.nth(2).locator('img'));
  await controls(secureDiagrams.nth(2), 'Ampliar diagrama en Workbench').click();
  await controls(panel, 'Ampliar vista').click();
  await imageReady(modal.locator('img'));
  const canvas = modal.getByRole('region', { name: 'Área del diagrama' });
  const scrollX = () => canvas.evaluate((node) => node.scrollLeft);
  const scale = async () => Number.parseInt(await modal.getByLabel('Nivel de zoom').innerText(), 10);
  assert(await scale() >= 65);
  assert(await canvas.evaluate((node) => node.scrollWidth > node.clientWidth));
  await canvas.press('ArrowRight');
  await poll(async () => await scrollX() > 0, 'El lienzo no se desplazó con el teclado');
  const x = await scrollX();
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 180, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await poll(async () => await scrollX() > x + 100, 'El lienzo no se desplazó al arrastrar');
  const moved = await scrollX();
  await code(modal).click();
  await controls(modal, 'Diagrama').click();
  await poll(async () => Math.abs(await scrollX() - moved) < 4, 'La vista no conservó la posición al volver de código');
  await controls(modal, 'Ajustar a anchura').click();
  await poll(async () => await canvas.evaluate((node) => node.scrollWidth <= node.clientWidth + 1), 'El ajuste a anchura dejó desbordamiento');
  await controls(modal, 'Escala real').click();
  assert.equal(await scale(), 100);
  await controls(modal, 'Ajustar a vista').click();
  assert(await scale() < 65);
  await controls(modal, 'Escala real').click();
  await shot('mermaid-grande');
  await modal.press('Escape');

  const tall = secureDiagrams.nth(5);
  await tall.scrollIntoViewIfNeeded();
  await imageReady(tall.locator('img'));
  await controls(tall, 'Ampliar diagrama en Workbench').click();
  await controls(panel, 'Ampliar vista').click();
  await imageReady(modal.locator('img'));
  assert(await scale() >= 65);
  assert(await canvas.evaluate((node) => node.scrollHeight > node.clientHeight));
  await canvas.press('ArrowDown');
  await poll(() => canvas.evaluate((node) => node.scrollTop > 0), 'El diagrama vertical no se desplazó');
  await shot('mermaid-vertical');
  await modal.press('Escape');
  check('Mermaid centrado y legible en tamaños pequeño, horizontal y vertical, zoom, ajustes, arrastre, flechas y posición conservada');
  for (const index of [3, 4]) {
    const block = secureDiagrams.nth(index);
    await block.scrollIntoViewIfNeeded();
    await imageReady(block.locator('img'));
  }
  assert.deepEqual(requests, []);
  check('Mermaid Entidad–Relación y Gantt en WebView2');
  check('Seguridad en WebView2: origen opaco, sin transporte WebView2 ni acceso al padre y con IPC HTTP bloqueado, scripts/eventos, navegación, formularios, red, SVG y Mermaid sin acciones');

  await enqueue(req(id, 'VISUAL-EN-COLA', 'claude'), { defer: true });
  await invoke('update_message_queue', { conversationId: id, action: { type: 'resume' } });
  const queued = await finish(id, 'VISUAL-EN-COLA');
  assert.equal(queued.agent, 'claude');
  await sendUI('HOLD-VISUAL-STEER');
  const steer = page.getByRole('button', { name: 'Intervenir en el turno activo de Codex' });
  await steer.waitFor();
  await page.getByRole('textbox', { name: 'Mensaje', exact: true }).fill('Continúa con un diagrama de estados.');
  await steer.click();
  const steered = await finish(id, 'HOLD-VISUAL-STEER');
  assert.equal(steered.agent, 'codex');
  await load(id, projectId);
  await diagram(article(steered.id)).first().scrollIntoViewIfNeeded();
  await imageReady(diagram(article(steered.id)).locator('img'));
  await preview(article(queued.id)).click();
  await imageReady(panel.locator('.visual-canvas img'));
  await page.setViewportSize({ width: 800, height: 620 });
  await page.locator('dialog#workbench[open]').waitFor();
  await controls(panel, 'Ampliar vista').click();
  await imageReady(modal.locator('img'));
  await shot('ventana-estrecha');
  await modal.press('Escape');
  await controls(panel, 'Cerrar Workbench').click();
  assert.equal(await panel.count(), 0);
  await controls(page, 'Mostrar Workbench').click();
  await imageReady(panel.locator('.visual-canvas img'));
  check('Cola y Steer con fixtures, conversación reabierta desde SQLite, ventana estrecha, cierre y reapertura del Workbench');
}
