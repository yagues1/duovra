// QA dirigida sobre WebView2: conversación temporal, selección real de preferencias
// y ejecuciones simuladas exclusivamente en memoria. No envía mensajes a proveedores.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright-core';

const out = resolve(process.argv[2] ?? 'output/qa-composer-motion');
mkdirSync(out, { recursive: true });
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes('localhost:1420'));
assert.ok(page, 'QA WebView2 no disponible');
page.setDefaultTimeout(7000);
const invoke = (command, args = {}) => page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [command, args]);
const store = (body, arg) => page.evaluate(async ([body, arg]) => {
  const resource = performance.getEntriesByType('resource').find(e => new URL(e.name).pathname === '/src/state/store.ts');
  const { useStore } = await import(resource.name);
  return (0, eval)(body)(useStore, arg);
}, [body, arg]);
const results = [], errors = [];
page.on('pageerror', e => errors.push(String(e)));
const active = page.locator('[data-popup-motion][data-state="open"]');
const exiting = page.locator('[data-popup-motion][data-state="closed"]');
const input = page.locator('.composer-input');
const ready = async () => {
  await page.reload();
  await page.waitForFunction(async () => {
    const resource = performance.getEntriesByType('resource').find(e => new URL(e.name).pathname === '/src/state/store.ts');
    return resource && (await import(resource.name)).useStore.getState().ready;
  });
};
const waitClosed = () => page.waitForFunction(() => !document.querySelector('[data-popup-motion]'));
const settle = () => page.waitForFunction(() => {
  const els = document.querySelectorAll('[data-popup-motion][data-state="open"]');
  return els.length === 1 && getComputedStyle(els[0]).opacity === '1' && getComputedStyle(els[0]).visibility === 'visible';
});
const close = async () => {
  if (await active.count()) await page.keyboard.press('Escape');
  await waitClosed();
};
const check = async (name, fn) => {
  try { await fn(); results.push({ name, ok: true }); console.log('OK', name); }
  catch (e) {
    results.push({ name, ok: false, error: String(e) }); console.error('FAIL', name, String(e));
    await close().catch(() => {});
  }
};
await page.bringToFront();
await ready();
const boot = await invoke('bootstrap');
for (const agent of ['claude', 'codex']) {
  const account = boot.accounts.find(a => a.id === boot.settings['accounts.active.' + agent]);
  assert.ok(account?.label.startsWith('QA simulada'), 'Cuenta no aislada: ' + agent);
}
assert.equal(boot.activeRuns.length, 0, 'QA tiene una ejecución activa');
const project = boot.projects.find(p => p.name === 'QA · Activity & Instructions (datos de prueba)');
assert.ok(project);
const previous = await store('s=>s.getState().activeConversationId');
const fallback = boot.conversations.find(c => c.projectId === project.id && c.title === 'QA · Tareas (Codex)');
assert.ok(fallback);
const conv = await invoke('create_conversation', { projectId: project.id, title: 'QA temporal · Microanimaciones ' + Date.now(), worktreeId: null });
let traces = [];
try {
  await invoke('set_draft', { conversationId: conv.id, draft: 'Borrador temporal QA' });
  // No se recarga entre la creación y la selección: el frontend puede
  // restaurar su conversación anterior antes de incorporar el chat nuevo.
  await store('(s,c)=>{s.setState({conversations:[c,...s.getState().conversations.filter(x=>x.id!==c.id)]});return s.getState().selectConversation(c.id)}', { ...conv, draft: 'Borrador temporal QA' });
  assert.equal(await store('s=>s.getState().activeConversationId'), conv.id, 'El chat temporal no está activo');
  await input.waitFor();
  // Los únicos envíos posibles en este guion se interceptan en el store, sin IPC.
  await store('s=>{const setSetting=s.getState().setSetting;window.__qaDispatch=[];s.setState({settings:{...s.getState().settings,"appearance.intensity":"balanced","appearance.animations":true},send:async(...args)=>{window.__qaDispatch.push({type:"send",args});return false},steer:async(...args)=>{window.__qaDispatch.push({type:"steer",args});return false},setSetting:async(key,value)=>{if(key==="composer.fast"||key==="ui.sidebarCollapsed"){s.setState({settings:{...s.getState().settings,[key]:value}});return;}return setSetting(key,value)}})}');
  await page.waitForFunction(() => document.documentElement.dataset.intensity === 'balanced');
  await store('s=>s.getState().refreshCatalog("codex",true)');
  await store('s=>s.getState().refreshCatalog("claude",true)');
  const catalog = await store('s=>s.getState().catalogs.codex');
  assert.ok(catalog && Array.isArray(catalog.models));
  const groups = await page.evaluate(async models => {
    const resource = performance.getEntriesByType('resource').find(e => new URL(e.name).pathname === '/src/lib/modelGroups.ts');
    const { groupModels } = await import(resource.name);
    return groupModels(models);
  }, catalog.models);
  const model = groups.primary.find(m => m.fast && m.efforts?.length);
  const legacy = groups.more.find(m => m.efforts?.length);
  assert.ok(model && legacy, 'Se necesitan modelos actual, legacy y Fast en el catálogo QA');
  const prefs = id => store('(s,p)=>s.setState({prefs:{...s.getState().prefs,[p.id]:{agent:"codex",model:p.model,effort:p.effort}}})', { id: conv.id, model: id.id, effort: id.defaultEffort ?? id.efforts?.[0] ?? null });
  await prefs(model);

  // Cada transición se identifica por su nodo DOM y caso. El observador conserva
  // los datos aunque el elemento ya se haya desmontado al regresar de CDP.
  await page.evaluate(() => {
    const records = [], ids = new WeakMap(), states = new WeakMap();
    let serial = 0, currentCase = '';
    const id = el => { if (!ids.has(el)) ids.set(el, ++serial); return ids.get(el); };
    const measure = el => {
      const s = getComputedStyle(el), footer = el.querySelector('footer');
      return {
        width: parseFloat(s.width), height: parseFloat(s.height), left: parseFloat(s.left), top: parseFloat(s.top),
        origin: s.transformOrigin, mode: el.getAttribute('data-mode'),
        footerPadding: footer ? getComputedStyle(footer).padding : null,
        text: el.textContent, controls: [...el.querySelectorAll('button,[role="option"],input,textarea,select')].map(n =>
          [n.textContent, n.getAttribute('data-selected'), n.getAttribute('aria-selected'), n.getAttribute('aria-checked'), n.getAttribute('aria-current'), n.disabled ?? null, n.value ?? null, n.checked ?? null]),
      };
    };
    const inspect = el => {
      const state = el.dataset.state;
      if (states.get(el) === state) return;
      states.set(el, state);
      const s = getComputedStyle(el), rect = el.getBoundingClientRect();
      const record = {
        case: currentCase, id: id(el), state, label: el.getAttribute('aria-label') ?? el.getAttribute('data-mode'),
        frozen: el.hasAttribute('data-frozen'), inert: el.inert, hidden: el.getAttribute('aria-hidden'),
        pointer: s.pointerEvents, hit: !document.elementFromPoint(rect.x + rect.width/2, rect.y + rect.height/2)?.closest('[data-popup-motion][data-state="closed"]'),
        side: el.dataset.side, geometry: measure(el), animations: [], samples: [],
      };
      records.push(record);
      const start = performance.now();
      const sample = () => {
        if (!el.isConnected || el.dataset.state !== state) return;
        const computed = getComputedStyle(el);
        for (const animation of el.getAnimations()) {
          const prop = animation.transitionProperty;
          if (!prop || record.animations.some(a => a.property === prop)) continue;
          record.animations.push({ property: prop, duration: animation.effect.getTiming().duration, frames: animation.effect.getKeyframes() });
        }
        record.samples.push({ ms: performance.now() - start, opacity: Number(computed.opacity), transform: computed.transform,
          geometry: state === 'closed' ? measure(el) : undefined });
        if (performance.now() - start < 180) requestAnimationFrame(sample);
      };
      sample();
    };
    const observer = new MutationObserver(() => document.querySelectorAll('[data-popup-motion]').forEach(inspect));
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-state'], childList: true, subtree: true });
    window.__qaPopupMotion = { records, observer, id, measure, begin: name => { currentCase = name; return records.length; } };
  });
  const begin = name => page.evaluate(name => window.__qaPopupMotion.begin(name), name);
  const snapshot = () => page.evaluate(() => {
    const el = document.querySelector('[data-popup-motion][data-state="open"]');
    if (!el) throw Error('No hay menú activo');
    return { id: window.__qaPopupMotion.id(el), geometry: window.__qaPopupMotion.measure(el), label: el.getAttribute('aria-label') ?? el.getAttribute('data-mode') };
  });
  const readRecord = async (from, id, state) => {
    const records = await page.evaluate(from => window.__qaPopupMotion.records.slice(from), from);
    const matches = records.filter(r => r.id === id && r.state === state);
    assert.equal(matches.length, 1, 'Debe existir exactamente una transición ' + state + ' del nodo ' + id);
    return matches[0];
  };
  const stable = (before, after, label) => {
    for (const key of ['width','height','left','top']) assert.ok(Math.abs(before[key] - after[key]) <= .75, label + ': ' + key + ' cambió de ' + before[key] + ' a ' + after[key]);
    for (const key of ['origin','mode','footerPadding','text','controls']) assert.deepEqual(after[key], before[key], label + ': cambió ' + key);
  };
  const transition = (record, duration) => {
    for (const property of ['opacity','transform']) {
      const a = record.animations.find(a => a.property === property);
      assert.ok(a, record.case + ': no hay transición ' + property);
      assert.ok(Math.abs(a.duration - duration) < .5, record.case + ': duración de ' + property + ' (' + a.duration + ' ms)');
      assert.ok(a.frames.length >= 2, record.case + ': sin fotogramas');
    }
    assert.ok(record.samples.some(s => s.opacity > 0 && s.opacity < 1), record.case + ': no se observó un fotograma interpolado');
    const transform = record.animations.find(a => a.property === 'transform').frames;
    const matrix = value => {
      const n = String(value).match(/matrix\(([^)]+)\)/)?.[1]?.split(',').map(Number);
      if (n) return { scale: n[0], y: n[5] };
      const s = String(value).match(/scale\(([\d.]+)\)/), t = String(value).match(/translateY\((-?[\d.]+)px\)/);
      return { scale: s ? Number(s[1]) : 1, y: t ? Number(t[1]) : 0 };
    };
    const edge = matrix(record.state === 'open' ? transform[0].transform : transform.at(-1).transform);
    assert.ok(Math.abs(edge.scale - (record.state === 'open' ? .97 : .98)) < .005, record.case + ': escala incorrecta ' + JSON.stringify(edge));
    assert.ok(Math.abs(edge.y - (record.side === 'top' ? 1 : -1) * (record.state === 'open' ? 4 : 2)) < .2, record.case + ': desplazamiento incorrecto ' + JSON.stringify(edge));
  };
  const assertExit = async (from, before) => {
    const record = await readRecord(from, before.id, 'closed');
    transition(record, 100);
    assert.equal(record.frozen, true, record.case + ': no hay copia congelada');
    assert.equal(record.inert, true);
    assert.equal(record.hidden, 'true');
    assert.equal(record.pointer, 'none');
    assert.equal(record.hit, true, record.case + ': intercepta clics');
    stable(before.geometry, record.geometry, record.case);
    for (const s of record.samples) stable(before.geometry, s.geometry, record.case);
  };
  const opened = async (name, action, selector) => {
    const from = await begin(name + ' / apertura');
    await action();
    await active.waitFor();
    if (selector) assert.equal(await page.locator(selector).getAttribute('aria-expanded'), 'true');
    await settle();
    const before = await snapshot();
    transition(await readRecord(from, before.id, 'open'), 150);
    return before;
  };
  const closed = async (name, before, action, selector) => {
    const from = await begin(name + ' / cierre');
    await action();
    if (selector) assert.equal(await page.locator(selector).getAttribute('aria-expanded'), 'false');
    await waitClosed();
    await assertExit(from, before);
  };
  const click = selector => () => page.locator(selector).click();
  const esc = () => page.keyboard.press('Escape');
  const request = kind => () => store('(s,p)=>s.getState().requestComposer(p.id,p.kind)', { id: conv.id, kind });
  const outside = async () => {
    const point = await page.evaluate(() => {
      const el = document.querySelector('[data-popup-motion][data-state="open"]');
      for (const y of [100,140,180,240]) for (const x of [innerWidth*.65,innerWidth*.8,innerWidth*.5]) {
        const hit = document.elementFromPoint(x,y);
        if (hit && !el.contains(hit) && !hit.closest('button,a,input,textarea,[role="button"],[data-tauri-drag-region]')) return {x,y};
      }
      throw Error('No hay punto exterior seguro');
    });
    await page.mouse.click(point.x, point.y);
  };
  const menus = [
    ['Agente','.agent-btn','agent'], ['Modelo','.model-btn','model'],
    ['Esfuerzo','.effort-btn','effort'], ['Permisos','.perm-btn','perm'],
    ['Construir/Planificar','.mode-btn','mode'], ['Contexto','.ctx-btn','context'],
    ['Velocidad','.fast-btn:not(:disabled)','fast'],
  ];
  const contextReady = () => page.waitForFunction(() => {
    const card = document.querySelector('.ctx-card');
    return card && !/Cargando|Comprobando si/.test(card.textContent);
  });
  for (const [name, selector, kind] of menus) {
    await check(name + ' · botón/clic exterior', async () => {
      await close();
      await opened(name, click(selector), selector);
      // La carga de contexto puede cambiar contenido mientras el menú está activo.
      if (kind === 'context') await contextReady();
      const before = await snapshot();
      if (kind === 'model') await page.screenshot({path:join(out,'modelo-abierto.png')});
      await closed(name, before, outside, selector);
    });
    await check(name + ' · teclado/Escape', async () => {
      await opened(name, () => page.locator(selector).press('Enter'), selector);
      if (kind === 'context') await contextReady();
      await closed(name, await snapshot(), esc, selector);
    });
    await check(name + ' · petición/toggle', async () => {
      await opened(name, request(kind), selector);
      if (kind === 'context') await contextReady();
      await closed(name, await snapshot(), click(selector), selector);
    });
  }

  // Selecciones reales sobre la conversación temporal, incluida la regresión de ModelPicker.
  for (const [name, fromModel, marker] of [
    ['Modelo legacy', legacy, '.mp-legacy'], ['Modelo retirado', {id:'qa-modelo-retirado',efforts:[]}, '.mp-retired'],
  ]) await check(name + ' → actual', async () => {
    await prefs(fromModel);
    await opened(name, click('.model-btn'), '.model-btn');
    await active.locator(marker).waitFor();
    const before = await snapshot();
    await page.screenshot({path:join(out, marker === '.mp-legacy' ? 'modelo-legacy.png' : 'modelo-retirado.png')});
    const option = active.locator('.mp-model').filter({has:page.locator('.mp-model-name', {hasText:model.label})}).first();
    await closed(name, before, () => option.click(), '.model-btn');
    assert.equal(await store('(s,id)=>s.getState().prefs[id].model', conv.id), model.id);
    await opened(name + ' actualizado', click('.model-btn'), '.model-btn');
    assert.equal(await active.locator(marker).count(), 0, 'El estado antiguo sobrevivió a la reapertura');
    await closed(name + ' actualizado', await snapshot(), esc, '.model-btn');
  });
  for (const [name, selector, option] of [
    ['Esfuerzo','.effort-btn','.effort-row:not([data-selected])'],
    ['Permisos','.perm-btn','.perm-row[data-risk="safe"]:not([data-selected])'],
    ['Construir/Planificar','.mode-btn','[role="menuitemradio"]:not([data-selected])'],
    ['Velocidad','.fast-btn:not(:disabled)','[role="menuitemradio"]:not([data-selected])'],
  ]) await check(name + ' · selección', async () => {
    const before = await opened(name, click(selector), selector);
    await closed(name, before, () => active.locator(option).first().click(), selector);
  });
  await check('Agente · selección y restauración', async () => {
    const before = await opened('Agente', click('.agent-btn'), '.agent-btn');
    await closed('Agente', before, () => active.locator('[role="menuitemradio"]:not([data-selected])').first().click(), '.agent-btn');
    assert.equal(await store('(s,id)=>s.getState().prefs[id].agent', conv.id), 'claude');
    await prefs(model);
  });

  const type = text => async () => { await input.fill(text); await input.press('End'); };
  for (const [name, text, mode] of [['Comandos','/','command'], ['Archivos','@','file']]) {
    const prepare = async () => {
      await input.fill('');
      await input.focus();
      await opened(name, type(text));
      assert.equal(await active.getAttribute('data-mode'), mode);
      await active.locator('[role="option"]').first().waitFor();
    };
    await check(name + ' · Escape', async () => {
      await prepare();
      if (mode === 'command') await page.screenshot({path:join(out,'comandos-abiertos.png')});
      await closed(name, await snapshot(), () => input.press('Escape'));
    });
    await check(name + ' · clic exterior', async () => {
      await prepare();
      await closed(name, await snapshot(), outside);
    });
    await check(name + ' · selección', async () => {
      await input.fill('');
      await input.focus();
      const query = mode === 'command' ? '/build' : '@';
      await opened(name, type(query));
      await active.locator('[role="option"]:not([aria-disabled="true"])').first().waitFor();
      await closed(name, await snapshot(), () => active.locator('[role="option"]:not([aria-disabled="true"])').first().click());
      if (mode === 'file') assert.match(await input.inputValue(), /^@"/);
    });
  }
  await check('Comandos · alineación al plegar y desplegar navegación', async () => {
    const original = await store('s=>s.getState().settings["ui.sidebarCollapsed"]===true');
    try {
      await input.fill(''); await input.focus();
      await opened('Comandos navegación', type('/'));
      const aligned = () => page.waitForFunction(() => {
        const menu = document.querySelector('.composer-suggestions[data-state="open"]');
        const composer = document.querySelector('.composer');
        if (!menu || !composer) return false;
        const r = composer.getBoundingClientRect(), m = menu.getBoundingClientRect();
        return Math.abs(m.left - r.left) < 1 && Math.abs(m.bottom - (r.top - 7)) < 1;
      });
      for (const collapsed of [!original, original]) {
        const oldLeft = await page.locator('.composer').evaluate(el => el.getBoundingClientRect().left);
        await input.press('Control+b');
        assert.equal(await store('s=>s.getState().settings["ui.sidebarCollapsed"]===true'), collapsed);
        await page.waitForFunction(left => Math.abs(document.querySelector('.composer').getBoundingClientRect().left-left)>10, oldLeft);
        // Dejar terminar el spring de la navegación y la traslación del chat.
        await page.waitForTimeout(600);
        await aligned();
      }
      await closed('Comandos navegación', await snapshot(), () => input.press('Escape'));
    } finally {
      await store('(s,v)=>s.getState().setSetting("ui.sidebarCollapsed",v)', original);
    }
  });
  await input.fill('Borrador temporal QA');

  for (const [name, kind] of [['Revisión','review'], ['Objetivo','goal']]) {
    await check(name + ' · petición/Escape', async () => {
      const before = await opened(name, request(kind));
      await closed(name, before, esc);
    });
    await check(name + ' · petición/clic exterior', async () => {
      const before = await opened(name, request(kind));
      await closed(name, before, outside);
    });
  }
  await check('Revisión · cancelar formulario', async () => {
    const before = await opened('Revisión', request('review'));
    await closed('Revisión', before, () => active.locator('.review-form button[type="button"]').click());
  });
  await check('Objetivo · guardar y retirar (cambio de altura/cápsula)', async () => {
    await opened('Objetivo', request('goal'));
    await active.locator('textarea').fill('Objetivo temporal de QA');
    await closed('Objetivo guardar', await snapshot(), () => active.locator('.btn-primary').click());
    await page.locator('.goal-capsule').waitFor();
    const before = await opened('Objetivo desde cápsula', click('.goal-capsule'), '.goal-capsule');
    await closed('Objetivo retirar', before, () => active.locator('.goal-actions button').filter({hasText:'Retirar'}).click());
    await page.locator('.goal-capsule').waitFor({state:'detached'});
  });

  const run = async id => store('(s,p)=>s.setState({runs:{...s.getState().runs,[p.id]:{runId:p.run,conversationId:p.id,messageId:p.run,agent:"codex",model:p.model,items:[],usage:null,approvals:[],ready:true,steerable:true,startedAt:Date.now()}}})', { id: conv.id, run: id, model: model.id });
  const end = () => store('(s,id)=>{const runs={...s.getState().runs};delete runs[id];s.setState({runs})}', conv.id);
  await input.fill('Borrador temporal QA');
  await run('qa-motion-1');
  for (const [route, action] of [['Escape',esc], ['clic exterior',outside], ['toggle',click('.send-more')]]) {
    await check('Envío · ' + route, async () => {
      const before = await opened('Envío', click('.send-more'), '.send-more');
      await closed('Envío', before, action, '.send-more');
    });
  }
  for (const [i, kind] of ['steer','send','interrupt'].entries()) await check('Envío · selección ' + kind, async () => {
    const before = await opened('Envío ' + kind, click('.send-more'), '.send-more');
    const row = active.locator('[role="menuitem"]').nth(i);
    assert.equal(await row.isEnabled(), true);
    const prior = await page.evaluate(() => window.__qaDispatch.length);
    await closed('Envío ' + kind, before, () => row.click(), '.send-more');
    const calls = await page.evaluate(() => window.__qaDispatch);
    assert.equal(calls.length, prior + 1);
    assert.equal(calls.at(-1).type, kind === 'steer' ? 'steer' : 'send');
    if (kind === 'interrupt') assert.equal(calls.at(-1).args[3].interrupt,true);
  });
  await check('Envío · fin de ejecución, sugerencias y nuevo turno', async () => {
    const before = await opened('Envío fin', click('.send-more'), '.send-more');
    await closed('Envío fin', before, end);
    assert.equal(await page.locator('.send-more').count(), 0);
    await input.fill('');
    await input.focus();
    await opened('Comandos tras finalizar', type('/'));
    await closed('Comandos tras finalizar', await snapshot(), () => input.press('Escape'));
    await input.fill('Borrador temporal QA');
    await run('qa-motion-2');
    await page.locator('.send-more').waitFor();
    assert.equal(await page.locator('.send-more').getAttribute('aria-expanded'), 'false');
    assert.equal(await active.count(), 0);
    await end();
  });
  await check('Velocidad · desaparición de capacidad con menú abierto', async () => {
    const before = await opened('Velocidad retirada', click('.fast-btn:not(:disabled)'), '.fast-btn');
    await closed('Velocidad retirada', before, () => prefs({id:'qa-retirado-sin-fast',efforts:[]}));
    assert.equal(await active.count(), 0);
    await prefs(model);
    assert.equal(await page.locator('.fast-btn').getAttribute('aria-expanded'), 'false');
  });
  await check('Cambio entre menús · salidas y entradas independientes', async () => {
    let before = await opened('Cambio agente', click('.agent-btn'), '.agent-btn');
    for (const selector of ['.model-btn','.perm-btn','.mode-btn','.ctx-btn','.agent-btn']) {
      const from = await begin('Cambio → ' + selector);
      await page.locator(selector).click();
      await settle();
      await exiting.waitFor({state:'detached'});
      const next = await snapshot();
      assert.notEqual(before.id,next.id);
      await assertExit(from,before);
      transition(await readRecord(from,next.id,'open'),150);
      before = await snapshot();
    }
    await closed('Cambio final',before,esc);
  });
  await check('Reapertura durante salida · mismo nodo e inversión continua', async () => {
    const before = await opened('Reapertura', click('.agent-btn'), '.agent-btn');
    const observed = await page.evaluate(async () => {
      const trigger = document.querySelector('.agent-btn'), el = document.querySelector('[data-popup-motion][data-state="open"]');
      trigger.click();
      await new Promise(requestAnimationFrame);
      const closed = el.isConnected && el.dataset.state === 'closed' && el.inert;
      const opacity = Number(getComputedStyle(el).opacity);
      trigger.click();
      await new Promise(requestAnimationFrame);
      return {closed,opacity, same:el === document.querySelector('[data-popup-motion][data-state="open"]'), reopened:Number(getComputedStyle(el).opacity),inert:el.inert};
    });
    assert.ok(observed.closed && observed.same && !observed.inert, JSON.stringify(observed));
    assert.ok(observed.reopened >= observed.opacity - .12 && observed.reopened > 0, JSON.stringify(observed));
    await settle();
    assert.equal((await snapshot()).id,before.id);
    await closed('Reapertura final',await snapshot(),esc,'.agent-btn');
  });

  await page.emulateMedia({reducedMotion:'reduce'});
  await page.waitForFunction(() => document.documentElement.dataset.intensity === 'reduced');
  const reduced = async (name, action, dismiss) => {
    const from = await begin(name + ' / reducido');
    await action();
    await settle();
    const before = await snapshot();
    const record = await readRecord(from,before.id,'open');
    assert.equal(record.animations.length,0, name + ': movimiento en modo reducido');
    await dismiss();
    assert.equal(await active.count(),0);
    assert.equal(await exiting.count(),0);
  };
  for (const [name,selector] of menus) await check(name + ' · movimiento reducido', () => reduced(name,click(selector),esc));
  for (const [name,kind] of [['Revisión','review'],['Objetivo','goal']]) await check(name + ' · movimiento reducido', () => reduced(name,request(kind),esc));
  for (const [name,text] of [['Comandos','/'],['Archivos','@']]) await check(name + ' · movimiento reducido', async () => {
    await input.fill(''); await input.focus();
    await reduced(name,type(text),() => input.press('Escape'));
  });
  await check('Envío · movimiento reducido al finalizar', async () => {
    await input.fill('Borrador temporal QA'); await run('qa-motion-reduced');
    await reduced('Envío',click('.send-more'),end);
  });
  await page.emulateMedia({reducedMotion:null});
  traces = await page.evaluate(() => window.__qaPopupMotion.records);
  writeFileSync(join(out,'frames.json'),JSON.stringify(traces,null,2));
  assert.equal((await invoke('bootstrap')).activeRuns.length,0,'Se inició una ejecución real');
  assert.equal((await invoke('list_messages',{conversationId:conv.id,includeSessions:false})).messages.length,0,'Se enviaron mensajes');
} finally {
  await page.evaluate(() => { window.__qaPopupMotion?.observer.disconnect(); delete window.__qaPopupMotion; }).catch(()=>{});
  await page.emulateMedia({reducedMotion:null}).catch(()=>{});
  // Descartar exclusivamente la conversación temporal creada por este guion.
  await store('(s,id)=>{const runs={...s.getState().runs};delete runs[id];s.setState({runs})}',conv.id).catch(()=>{});
  await invoke('delete_conversation',{id:conv.id}).catch(e=>errors.push('Limpieza: '+String(e)));
  await ready().catch(e=>errors.push('Recarga: '+String(e)));
  await store('(s,id)=>s.getState().selectConversation(s.getState().conversations.some(c=>c.id===id)?id:null)', previous ?? fallback.id).catch(()=>{});
  if (!(await input.isVisible().catch(()=>false))) await store('(s,id)=>s.getState().selectConversation(id)',fallback.id).catch(()=>{});
  await page.bringToFront().catch(()=>{});
  writeFileSync(join(out,'report.json'),JSON.stringify({results,errors,modelCalls:0,records:traces.length},null,2));
  await browser.close();
}
if (results.some(r=>!r.ok)||errors.length) process.exitCode=1;
