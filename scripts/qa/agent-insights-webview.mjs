import assert from 'node:assert/strict';
import { join } from 'node:path';

// Usa el mismo arnés y la misma base aislada que las regresiones de la cola.
export async function checkAgentInsights(qa) {
  const { page, invoke, makeConversation, projectId, accountId, direct, finish, load, enqueue, req, history, poll, evidence, check } = qa;
  const conversation = await makeConversation(projectId, 'Actividad de proveedores · QA');
  const id = conversation.id;
  const projection = (message) => invoke('run_insights', { messageId: message.id });
  const stats = () => invoke('insights_usage', { scope: { conversationId: id, days: null, projectId: null } });

  await direct(id, 'INSIGHTS-CODEX', 'codex');
  const codex = await finish(id, 'INSIGHTS-CODEX');
  const codexData = await projection(codex);
  assert.equal(codexData.metrics.inputTokens, 1000);
  assert.equal(codexData.metrics.totalTokens, 1140);
  assert.equal(codexData.metrics.cachedInputTokens, 640);
  assert.equal(codexData.metrics.contextTokens, 500);
  assert.equal(codexData.metrics.contextWindow, 258400);
  assert.equal(codexData.details.plans.length, 2);
  assert.equal(codexData.details.compacted, true);
  assert.deepEqual(Object.keys(codexData.details.subagents).sort(), ['qa-sub-codex-a', 'qa-sub-codex-b']);
  assert.equal(codexData.details.subagents['qa-sub-codex-a'].status, 'completed');
  assert.equal(codexData.details.subagents['qa-sub-codex-b'].status, 'interrupted');
  assert.equal(codexData.details.continuity, 'new');

  await direct(id, 'INSIGHTS-CLAUDE', 'claude');
  const claude = await finish(id, 'INSIGHTS-CLAUDE');
  const claudeData = await projection(claude);
  assert.equal(claudeData.details.continuity, 'new');
  assert.equal(claudeData.metrics.freshInputTokens, 120);
  assert.equal(claudeData.metrics.inputTokens, 1920);
  assert.equal(claudeData.metrics.cachedInputTokens, 1500);
  assert.equal(claudeData.metrics.cacheWriteInputTokens, 300);
  assert.equal(claudeData.metrics.outputTokens, 84);
  assert.equal(claudeData.metrics.costKind, 'estimate');
  assert.equal(claudeData.metrics.costUsd, 0.0123);
  assert.equal(claudeData.metrics.contextWindow, 200000);
  assert(claudeData.details.plans.some((plan) => plan.source.endsWith('TodoWrite')));
  assert.equal(claudeData.details.plans.at(-1).tasks[0].status, 'failed');
  const workers = Object.values(claudeData.details.subagents);
  assert.equal(workers.length, 1);
  assert.equal(workers[0].id, 'qa-worker-claude');
  assert.deepEqual(workers[0].tools, ['Read']);
  assert.equal(workers[0].totalTokens, 320);
  const shared = (await history(id)).find((m) => m.id === claudeData.details.userMessageId).contextNote;
  assert.equal(shared.mode, 'shared');
  assert.deepEqual(shared.agents, ['codex']);
  assert(shared.sharedChars > 0);
  check('Planes y revisiones de ambos proveedores, tareas fallidas, delegaciones identificadas y contexto compartido');

  await direct(id, 'INSIGHTS-CLAUDE-RESUME', 'claude');
  const claudeResume = await finish(id, 'INSIGHTS-CLAUDE-RESUME');
  const claudeResumed = await projection(claudeResume);
  assert.equal(claudeResumed.details.continuity, 'resumed');
  assert.equal(claudeResumed.details.sessionId, claudeData.details.sessionId);
  assert(Math.abs(claudeResumed.metrics.costUsd - 0.005) < 1e-10);

  const later = req(id, 'INSIGHTS-RESUME', 'codex', 'gpt-6.2-sol');
  await enqueue(later, { defer: true, accountId });
  assert.equal((await stats()).reduce((sum, row) => sum + row.runs, 0), 3);
  await invoke('update_message_queue', { conversationId: id, action: { type: 'resume' } });
  const resumed = await finish(id, 'INSIGHTS-RESUME');
  const resumedData = await projection(resumed);
  assert.equal(resumedData.details.continuity, 'resumed');
  assert.equal(resumedData.details.sessionId, codexData.details.sessionId);
  assert.equal(resumedData.details.requestedModel, 'gpt-6.2-sol');
  assert.equal(resumedData.metrics.inputTokens, 1000);
  assert.equal(resumedData.metrics.threadTotal.inputTokens, 2000);
  assert.equal(resumedData.metrics.contextWindow, null);
  assert.equal(resumedData.details.plans, undefined);
  const rows = await stats();
  assert.equal(rows.reduce((sum, row) => sum + row.runs, 0), 4);
  assert.equal(rows.reduce((sum, row) => sum + row.inputTokens, 0), 5840);
  assert.equal(rows.reduce((sum, row) => sum + row.reportedCount, 0), 0);
  check('Cola despachada, snapshots repetidos, cambio de modelo, ventana desconocida y coste acumulado reconciliados');

  await load(id, projectId);
  assert.equal(await page.locator('#workbench').count(), 0);
  await page.getByRole('button', { name: 'Mostrar Workbench' }).press('Enter');
  const panel = page.locator('#workbench');
  // Workbench 1.0.0 Beta 2: Actividad, Archivos y Cambios. Actividad muestra un único turno.
  await panel.getByRole('tab', { name: 'Archivos' }).press('Home');
  await poll(() => panel.getByRole('tab', { name: 'Actividad' }).getAttribute('aria-selected').then((v) => v === 'true'), 'Fallo al enfocar Actividad por teclado');
  const picker = panel.getByLabel('Turno', { exact: true });
  await panel.locator('.ap-status').first().waitFor();
  await picker.selectOption(codex.id);
  await panel.locator('.ap-status', { hasText: 'Completado' }).waitFor();
  await panel.getByText('Reconciliar tokens y caché', { exact: true }).first().waitFor();
  await panel.getByText('Último estado del plan comunicado por el agente.', { exact: true }).waitFor();
  await panel.locator('.insight-plan time').first().waitFor();
  assert.equal(await panel.getByText('En progreso', { exact: true }).first().isVisible(), true);
  assert.equal(await panel.getByText('Pendiente', { exact: true }).first().isVisible(), true);
  await page.screenshot({ path: join(evidence, 'plan-incompleto.png') });
  await panel.locator('summary').filter({ hasText: 'Revisiones anteriores' }).press('Enter');
  await panel.getByText('Revisión 1', { exact: true }).waitFor();
  await page.screenshot({ path: join(evidence, 'tareas-codex.png') });
  const worker = panel.locator('.insight-worker').filter({ hasText: 'Revisar los snapshots acumulados del hilo.' });
  const result = 'La repetición del snapshot conserva el mismo consumo.';
  await worker.getByText(result, { exact: true }).first().scrollIntoViewIfNeeded();
  assert.equal(await worker.getByText('Identificador', { exact: true }).isVisible(), false);
  await page.screenshot({ path: join(evidence, 'subagentes-codex.png') });
  await worker.locator('summary').press('Enter');
  await worker.getByText('Identificador', { exact: true }).waitFor();
  await picker.selectOption(claude.id);
  await panel.getByText('Validar la persistencia', { exact: true }).first().waitFor();
  const task = panel.locator('summary').filter({ hasText: 'Validar la persistencia' }).first();
  await task.press('Space');
  await panel.getByText('Depende de #1', { exact: true }).waitFor();
  await page.screenshot({ path: join(evidence, 'tareas-claude.png') });
  await panel.locator('.insight-worker').filter({ hasText: 'Explore' }).locator('summary').press('Enter');
  await panel.getByText('Contrato comprobado.', { exact: false }).first().waitFor();
  await panel.getByText('Duración comunicada', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(evidence, 'subagentes.png') });

  // Los datos técnicos (sesión, consumo e historial compartido) viven en «Detalles».
  assert.equal(await panel.getByText('Enviado al proveedor', { exact: true }).isVisible(), false);
  await panel.locator('summary').filter({ hasText: /^\s*Detalles\s*$/ }).press('Enter');
  await panel.getByText('Enviado al proveedor', { exact: true }).waitFor();
  assert.equal(await panel.getByText('Caracteres del bloque compartido', { exact: true }).isVisible(), false);
  assert.equal(await panel.getByText('Sesión', { exact: true }).isVisible(), false);
  assert.equal(await panel.getByText('Lectura de caché', { exact: true }).isVisible(), false);
  assert.equal(await panel.locator('.activity-panel').evaluate((el) => getComputedStyle(el).animationName), 'none');
  await page.screenshot({ path: join(evidence, 'contexto.png') });
  await panel.locator('summary').filter({ hasText: 'Desglose del historial compartido' }).press('Space');
  await panel.getByText('Caracteres del bloque compartido', { exact: true }).waitFor();
  await panel.locator('summary').filter({ hasText: 'Detalles de la sesión' }).press('Enter');
  await panel.getByText('Sesión', { exact: true }).waitFor();
  await panel.locator('summary').filter({ hasText: 'Desglose de consumo' }).press('Enter');
  await panel.getByText('Lectura de caché', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(evidence, 'contexto-uso.png') });
  await panel.getByRole('button', { name: 'Ir al turno en la conversación' }).press('Enter');
  await poll(() => page.locator('#turn-' + claude.id).evaluate((el) => el === document.activeElement), 'No se devolvió el foco al turno');
  const viewport = page.viewportSize() ?? { width: 1360, height: 860 };
  await page.setViewportSize({ width: 780, height: 650 });
  await page.getByRole('button', { name: 'Mostrar Workbench' }).click();
  await page.getByRole('dialog', { name: 'Workbench' }).waitFor();
  await panel.getByRole('tab', { name: 'Actividad' }).click();
  await panel.locator('summary').filter({ hasText: /^\s*Detalles\s*$/ }).click();
  assert(await panel.locator('.activity-panel').evaluate((el) => el.scrollWidth <= el.clientWidth));
  await panel.getByRole('button', { name: 'Estadísticas de uso' }).press('Enter');
  const statHeading = page.getByRole('heading', { name: 'Estadísticas', exact: true });
  await poll(() => statHeading.evaluate((el) => el === document.activeElement), 'Las estadísticas no recibieron el foco');
  await page.setViewportSize(viewport);
  // Estadísticas 1.0.0 Beta 2: un solo selector de periodo y datos de todos los proyectos.
  const periods = page.locator('.stats-toolbar').getByRole('radiogroup');
  assert.deepEqual(await periods.getByRole('radio').allTextContents(), ['24 horas', '7 días', 'Último mes', 'Todo el historial']);
  assert.equal(await periods.getByRole('radio', { checked: true }).innerText(), '7 días');
  for (const removed of ['Ámbito', 'Proveedor', 'Modelo']) {
    assert.equal(await page.getByLabel(removed, { exact: true }).count(), 0);
  }
  await periods.getByRole('radio', { name: 'Todo el historial', exact: true }).click();
  assert.equal(await periods.getByRole('radio', { checked: true }).innerText(), 'Todo el historial');
  const offset = await page.evaluate(() => -new Date().getTimezoneOffset() * 60_000);
  const timeline = await invoke('insights_timeline', { scope: { since: 0, bucketMs: 86_400_000, offsetMs: offset } });
  const total = timeline.reduce((sum, row) => sum + row.runs, 0);
  assert(total > 4, 'La serie global debe incluir turnos de otras conversaciones del fixture');
  await poll(async () => (await page.locator('.stats-tile').first().locator('strong').innerText()) === String(total),
    'El resumen no coincide con la serie del backend');
  await statHeading.blur();
  await page.screenshot({ path: join(evidence, 'estadisticas.png') });
  for (const [period, grain, intervals] of [['24 horas', 'hora', 24], ['7 días', 'día', 7], ['Último mes', 'día', 30]]) {
    await periods.getByRole('radio', { name: period, exact: true }).click();
    assert.equal(await periods.getByRole('radio', { checked: true }).innerText(), period);
    const chart = page.getByRole('img', { name: 'Turnos por ' + grain, exact: true });
    await poll(async () => await chart.locator('.stats-col').count() === intervals, 'La serie no corresponde a ' + period);
  }
  await page.locator('.stats-models > summary').press('Enter');
  await page.screenshot({ path: join(evidence, 'uso-desglose.png') });
  // Ajustes se superpone a la conversación. El enlace se busca dentro de Estadísticas.
  await page.locator('.usage-chat-link').filter({ hasText: 'Actividad de proveedores · QA' }).press('Enter');
  const focusReturned = await poll(() => page.locator('#conversation-title').evaluate((el) => el === document.activeElement),
    'No se devolvió el foco a la conversación', 4000).then(() => true, () => false);
  assert(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches));
  check('Workbench cerrado al abrir, Actividad por teclado, Detalles, navegación con foco, periodos de Estadísticas y movimiento reducido en WebView2');
  return { id, codex, codexData, claude, claudeData, resumed, resumedData, rows, focusReturned };
}

export async function checkInsightsRestart(invoke, state, direct, finish) {
  for (const [message, expected] of [[state.codex, state.codexData], [state.claude, state.claudeData], [state.resumed, state.resumedData]]) {
    assert.deepEqual(await invoke('run_insights', { messageId: message.id }), expected);
  }
  assert.deepEqual(await invoke('insights_usage', { scope: { conversationId: state.id, projectId: null, days: null } }), state.rows);
  await direct(state.id, 'INSIGHTS-RESUME-RESTART', 'codex');
  const message = await finish(state.id, 'INSIGHTS-RESUME-RESTART');
  const next = await invoke('run_insights', { messageId: message.id });
  assert.equal(next.details.continuity, 'resumed');
  assert.equal(next.details.sessionId, state.resumedData.details.sessionId);
  assert.equal(next.metrics.inputTokens, 1000);
  assert.equal(next.metrics.threadTotal.inputTokens, 3000);
}
