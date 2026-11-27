// Regresión visual dirigida en WebView2. --closure-only añade los escenarios pendientes con APIs locales.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const menusOnly = args.includes('--menus-only');
const closureOnly = args.includes('--closure-only') || menusOnly;
const out = resolve(args.find(a => !a.startsWith('--')) ?? (menusOnly ? 'output/qa-fase6-technical-menus' : closureOnly ? 'output/qa-fase6-technical-closure' : 'output/qa-fase6-visual-corrections'));
mkdirSync(out, { recursive: true });
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes('localhost:1420'));
assert.ok(page, 'WebView QA de desarrollo no disponible');
const invoke = (command, args = {}) => page.evaluate(([c,a]) => window.__TAURI_INTERNALS__.invoke(c,a), [command,args]);
const store = (body, arg) => page.evaluate(async ([body,arg]) => {
  const { useStore } = await import(performance.getEntriesByType('resource').find(e=>new URL(e.name).pathname==='/src/state/store.ts').name);
  return await (0,eval)(body)(useStore.getState(),arg);
}, [body,arg]);
const sleep = ms => new Promise(r => setTimeout(r,ms));
const results = [], errors = [];
const closureChecks = ['Retirada de Ajustes, comandos e IPC; contexto y memoria', 'Fast y opciones de envío: cierre y paso de clics', 'Retirada en bifurcación nativa: entrega y confirmación simuladas'];
page.on('pageerror', e => errors.push(String(e)));
async function check(name, fn) {
  if (menusOnly && name !== closureChecks[1]) return;
  if (closureOnly && !closureChecks.includes(name)) return;
  try { const detail = await fn(); results.push({name,ok:true,detail}); console.log('OK',name,JSON.stringify(detail)); }
  catch(e) { results.push({name,ok:false,error:String(e)}); console.error('FAIL',name,String(e)); }
  writeFileSync(join(out,'report.json'),JSON.stringify({results,errors,modelCalls:0},null,2));
}
const exe = resolve('src-tauri/target/debug/duovra.exe').replaceAll("'","''");
function native(action, w=0,h=0) {
  const script = `$ErrorActionPreference='Stop'
$p=@(Get-Process -Name duovra | Where-Object {$_.Path -eq '${exe}'})
if ($p.Count -ne 1) {throw 'No hay exactamente una ventana QA verificada'}
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class QAWin {
 public delegate bool EnumProc(IntPtr h, IntPtr l);
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f,IntPtr l);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,StringBuilder t,int n);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h,StringBuilder t,int n);
 public static IntPtr Find(uint pid) {
  IntPtr found=IntPtr.Zero;
  EnumWindows((h,l)=>{uint p;GetWindowThreadProcessId(h,out p);if(p!=pid)return true;
   var t=new StringBuilder(256);var c=new StringBuilder(256);GetWindowText(h,t,256);GetClassName(h,c,256);
   if(c.ToString()=="Tauri Window"&&t.ToString().StartsWith("Duovra QA")){found=h;return false;}return true;},IntPtr.Zero);
  return found;
 }
 [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h,int n);
 [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h,IntPtr z,int x,int y,int w,int hgt,uint f);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out RECT r);
 [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
}
"@
$h=[QAWin]::Find($p[0].Id)
if ($h -eq [IntPtr]::Zero) {throw 'Ventana Tauri QA no encontrada'}
if ('${action}' -eq 'min') {[void][QAWin]::ShowWindowAsync($h,6)}
if ('${action}' -eq 'restore') {[void][QAWin]::ShowWindowAsync($h,9)}
if ('${action}' -eq 'resize') {if (-not [QAWin]::SetWindowPos($h,[IntPtr]::Zero,0,0,${w},${h},22)) {throw 'SetWindowPos fallo'}}
Start-Sleep -Milliseconds 250
$r=New-Object QAWin+RECT
[void][QAWin]::GetWindowRect($h,[ref]$r)
@{min=[QAWin]::IsIconic($h);w=($r.R-$r.L);h=($r.B-$r.T)} | ConvertTo-Json -Compress`;
  return JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true}).trim());
}
await page.reload();
await page.waitForFunction(async()=> {
  const resource=performance.getEntriesByType('resource').find(e=>new URL(e.name).pathname==='/src/state/store.ts');
  return resource && (await import(resource.name)).useStore.getState().ready;
});
const boot=await invoke('bootstrap');
const project=boot.projects.find(p=>p.name==='QA · Activity & Instructions (datos de prueba)');
assert.ok(project);
for(const agent of ['claude','codex']) {
  const account=boot.accounts.find(a=>a.id===boot.settings['accounts.active.'+agent]);
  assert.ok(account?.label.startsWith('QA simulada'), 'Cuenta no aislada: '+agent);
}
const conv=boot.conversations.find(c=>c.projectId===project.id&&c.title==='QA · Instrucciones (Claude Code)');
const other=boot.conversations.find(c=>c.projectId===project.id&&c.title==='QA · Tareas (Codex)');
assert.ok(conv&&other);
const original=native('get');
if(original.min) native('restore');
const initialPrefs = boot.conversations.find(c=>c.id===conv.id);
const initialSidebar=boot.settings['ui.sidebarCollapsed']===true;
const temporary = new Set();
const createTemporary = async title => {
  const c = await invoke('create_conversation',{projectId:project.id,title});
  temporary.add(c.id);
  await invoke('set_draft',{conversationId:c.id,draft:'Borrador temporal de QA'});
  return c;
};
const qaDir = join(process.env.TEMP,'duovra-qa-control');
const mockLog = () => readFileSync(join(qaDir,'mock-fase6','requests.jsonl'),'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
const verifyMock = () => {
  for(const agent of ['claude','codex']) {
    const account=boot.accounts.find(a=>a.id===boot.settings['accounts.active.'+agent]);
    assert.equal(resolve(account.configDir),resolve(qaDir,agent==='claude'?'claude-config':'codex-home'));
  }
  const settings=JSON.parse(readFileSync(join(qaDir,'claude-config','settings.json'),'utf8'));
  assert.equal(settings.env.ANTHROPIC_BASE_URL,'http://127.0.0.1:53396');
  const config=readFileSync(join(qaDir,'codex-home','config.toml'),'utf8');
  assert.match(config,/^\s*model_provider\s*=\s*"qa"\s*$/m);
  assert.match(config,/^\s*base_url\s*=\s*"http:\/\/127\.0\.0\.1:53397\/v1"\s*$/m);
};
const wait = async (fn,description,timeout=35000) => {
  const start=Date.now();
  while(Date.now()-start<timeout){const value=await fn();if(value)return value;await sleep(150);}
  throw new Error('Tiempo agotado: '+description);
};
const activeRun = async id => (await invoke('bootstrap')).activeRuns.find(r=>r.conversationId===id);
const listMessages = async id => (await invoke('list_messages',{conversationId:id,includeSessions:false})).messages;
const submitMock = async (c,agent,text) => {
  verifyMock();
  const model=agent==='codex'?'gpt-6-luna':'haiku', effort=agent==='codex'?'high':'medium';
  const accountId=boot.settings['accounts.active.'+agent];
  assert.equal((await invoke('bootstrap')).settings['accounts.active.'+agent],accountId);
  const result=await invoke('submit_message',{id:crypto.randomUUID(),accountId,request:{conversationId:c.id,agent,model,effort,text,attachments:[],speed:null,
    permissions:agent==='codex'?{sandbox:'read-only',approval:'never'}:{mode:'manual'},workMode:'build'}});
  assert.equal(result.mode,'started');
  return result.started.assistantMessage.id;
};
const done = async (c,id) => wait(async()=>{
  const m=(await listMessages(c.id)).find(m=>m.id===id);
  return m&&m.status!=='running'&&!await activeRun(c.id)?m:null;
},'turno simulado terminado');
const reloadReady = async () => {
  await page.reload();
  await page.waitForFunction(async()=>{
    const resource=performance.getEntriesByType('resource').find(e=>new URL(e.name).pathname==='/src/state/store.ts');
    return resource&&(await import(resource.name)).useStore.getState().ready;
  });
};
const open=async id=>{await store('(s,id)=>s.selectConversation(id)',id); await page.locator('.composer-input').waitFor();};
const collapse=async b=>{
  await store("(s,b)=>s.setSetting('ui.sidebarCollapsed',b)",b);
  await page.waitForFunction(async b=>{
    const {useStore}=await import(performance.getEntriesByType('resource').find(e=>new URL(e.name).pathname==='/src/state/store.ts').name);
    const {viewport}=await import('/src/lib/viewport.ts');
    const rail=b||viewport().width<840;
    const btns=document.querySelectorAll('[data-activity-center]');
    return useStore.getState().settings['ui.sidebarCollapsed']===b&&btns.length===1&&btns[0].classList.contains(rail?'rail-btn':'side-link');
  },b,{timeout:8000});
  await sleep(550);
};
const mode=page.locator('.mode-btn');
const snapshot=()=>page.evaluate(async()=>{
  const {useStore}=await import(performance.getEntriesByType('resource').find(e=>new URL(e.name).pathname==='/src/state/store.ts').name);
  const {viewport}=await import('/src/lib/viewport.ts');
  const s=useStore.getState(),root=document.getElementById('root'),actor=document.querySelector('.mascot-actor');
  const r=root.getBoundingClientRect();
  return {raw:[innerWidth,innerHeight],stable:viewport(),root:[r.width,r.height],dpr:devicePixelRatio,
    mascot:actor?.style.transform??null,panel:s.panel.open,active:s.panel.active,drawer:s.navDrawer,settings:s.settingsOpen,conversation:s.activeConversationId};
});
try {
  await open(conv.id);
  await store('s=>s.closePanel()');
  await collapse(false);
  await check('Separación de Actividad y Apoyo (expandida y contraída)',async()=>{
    const data=[];
    for(const collapsed of [false,true]){
      await collapse(collapsed);
      const metrics=await page.evaluate(()=>{
        const a=document.querySelector('[data-activity-center]'),b=document.querySelector('[data-support-link]');
        const r=a.getBoundingClientRect(),q=b.getBoundingClientRect();
        const next=b.nextElementSibling.getBoundingClientRect();
        const parent=getComputedStyle(a.parentElement);
        const siblings=[...a.parentElement.children].filter(e=>e.tagName==='BUTTON').map(e=>e.getBoundingClientRect());
        const gaps=siblings.slice(1).map((r,i)=>r.top-siblings[i].bottom).filter((g,i)=>i>=siblings.findIndex(r=>r.y===a.getBoundingClientRect().y));
        return {a:[r.x,r.y,r.width,r.height],b:[q.x,q.y,q.width,q.height],gap:q.top-r.bottom,nextGap:next.top-q.bottom,cssGap:parseFloat(parent.rowGap),
          gaps,hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('[data-activity-center]')===a};
      });
      assert.ok(metrics.gap>=0&&metrics.hit);
      assert.ok(collapsed?metrics.a[2]<45:metrics.a[2]>100);
      assert.ok(Math.abs(metrics.a[2]-metrics.b[2])<1&&Math.abs(metrics.a[3]-metrics.b[3])<1);
      assert.ok(metrics.gaps.every(g=>Math.abs(g-metrics.cssGap)<1),JSON.stringify(metrics));
      data.push({collapsed,...metrics});
    }
    await collapse(false);
    return data;
  });
  await check('Minimización/restauración nativa (3 ciclos)',async()=>{
    const data=[];
    for(const [collapsed,panel] of [[false,false],[false,true],[true,true]]){
      await collapse(collapsed);
      await store('(s,p)=>p?s.openPanel("files"):s.closePanel()',panel);
      await sleep(500);
      const before=await snapshot();
      await page.evaluate(async()=>{
        const {viewport}=await import('/src/lib/viewport.ts');
        const {useStore}=await import(performance.getEntriesByType('resource').find(e=>new URL(e.name).pathname==='/src/state/store.ts').name);
        window.__qaSamples=[];
        if(window.__qaResize) removeEventListener('resize',window.__qaResize);
        window.__qaResize=()=>{const s=useStore.getState(),r=document.getElementById('root').getBoundingClientRect();window.__qaSamples.push({raw:[innerWidth,innerHeight],stable:viewport(),root:[r.width,r.height],dpr:devicePixelRatio,panel:s.panel.open,drawer:s.navDrawer,settings:s.settingsOpen,mascot:document.querySelector('.mascot-actor')?.style.transform??null});};
        addEventListener('resize',window.__qaResize);
      });
      assert.equal(native('min').min,true);
      await sleep(450);
      assert.equal(native('restore').min,false);
      await sleep(750);
      const after=await snapshot(),samples=await page.evaluate(()=>window.__qaSamples);
      const tiny=samples.filter(s=>s.raw[0]<320||s.raw[1]<200);
      assert.ok(tiny.length,'No se observó el tamaño transitorio de Windows');
      for(const t of tiny){
        assert.deepEqual(t.stable,before.stable);
        assert.deepEqual(t.root,before.root);
        assert.equal(t.panel,before.panel);assert.equal(t.drawer,before.drawer);assert.equal(t.settings,before.settings);assert.equal(t.dpr,before.dpr);assert.equal(t.mascot,before.mascot);
      }
      for(const key of ['stable','root','dpr','mascot','panel','active','drawer','settings','conversation']) assert.deepEqual(after[key],before[key],key);
      data.push({collapsed,panel,before,after,tiny});
    }
    return data;
  });
  await check('Redimensionamiento legítimo y barra estrecha',async()=>{
    await store('s=>s.closePanel()');await collapse(false);
    const before=await snapshot();
    const current=native('get');
    native('resize',Math.max(760,Math.min(820,current.w-150)),Math.max(540,Math.min(650,current.h-60)));
    await sleep(700);
    const narrow=await snapshot();
    assert.notDeepEqual(narrow.raw,before.raw);
    assert.equal(narrow.stable.width,narrow.raw[0]);
    assert.equal(narrow.stable.height,narrow.raw[1]);
    const gap=await page.evaluate(()=>{const a=document.querySelector('[data-activity-center]').getBoundingClientRect(),b=document.querySelector('[data-support-link]').getBoundingClientRect();return b.top-a.bottom;});
    assert.ok(gap>=0);
    native('resize',current.w,current.h);await sleep(700);
    return {before:before.raw,narrow:narrow.raw,gap};
  });
  await check('Cierre inmediato de selectores y cambio entre menús',async()=>{
    const checked=[];
    for(const selector of ['.agent-btn','.model-btn','.effort-btn','.perm-btn','.mode-btn','.fast-btn','.ctx-btn']){
      const b=page.locator(selector);
      if(!await b.isVisible()||await b.isDisabled())continue;
      await b.click();
      const id=await b.getAttribute('aria-controls');assert.ok(id);
      const popup=page.locator('[id="'+id+'"]');await popup.waitFor();
      const outside=await page.evaluate(id=>{
        const menu=document.getElementById(id);
        for(const y of [100,140,180,240])for(const x of [innerWidth*0.65,innerWidth*0.8,innerWidth*0.5]){
          const hit=document.elementFromPoint(x,y);
          if(hit&&!menu.contains(hit)&&!hit.closest('button,a,input,textarea,[role="button"],[data-tauri-drag-region]'))return {x,y};
        }
        throw new Error('No se encontró un punto fuera del menú');
      },id);
      await page.mouse.move(outside.x,outside.y);await page.mouse.down();
      const removed=await popup.count();await page.mouse.up();assert.equal(removed,0,selector);
      checked.push(selector);
    }
    await page.locator('.agent-btn').click();
    const id=await page.locator('.agent-btn').getAttribute('aria-controls');
    await mode.click();assert.equal(await page.locator('[id="'+id+'"]').count(),0);
    assert.equal(await mode.getAttribute('aria-expanded'),'true');await page.keyboard.press('Escape');
    assert.equal(await mode.getAttribute('aria-expanded'),'false');
    return checked;
  });
  await check('Construir/Planificar: dimensiones, agentes, conversaciones y persistencia',async()=>{
    const set=async value=>{
      await mode.click();
      const id=await mode.getAttribute('aria-controls');
      await page.locator('[id="'+id+'"] [role="menuitemradio"]').nth(value==='build'?0:1).click();
      assert.equal(await mode.getAttribute('data-mode'),value);
      assert.equal(await mode.getAttribute('aria-expanded'),'false');
      return mode.evaluate(b=>({w:b.getBoundingClientRect().width,h:b.getBoundingClientRect().height,labels:[...b.querySelectorAll('.mode-label > span')].filter(x=>getComputedStyle(x).visibility==='visible').map(x=>x.textContent)}));
    };
    const a=await set('build'),b=await set('plan');
    assert.equal(a.w,b.w);assert.equal(a.h,b.h);assert.equal(a.labels.length,1);assert.equal(b.labels.length,1);
    await set('build');await set('plan');
    await page.locator('.agent-btn').click();
    await page.locator('.composer-popup[data-state="open"] [role="menuitemradio"]').nth(1).click();
    await set('plan');await set('build');
    await page.locator('.agent-btn').click();
    await page.locator('.composer-popup[data-state="open"] [role="menuitemradio"]').nth(0).click();
    assert.equal(await mode.getAttribute('data-mode'),'plan');
    await open(other.id);await open(conv.id);
    assert.equal(await mode.getAttribute('data-mode'),'plan');
    await sleep(400);
    const saved=(await invoke('bootstrap')).conversations.find(c=>c.id===conv.id);
    assert.equal(saved.workModes.claude,'plan');assert.equal(saved.workModes.codex,'build');
    assert.deepEqual(saved.permissionPrefs,initialPrefs.permissionPrefs);
    assert.equal((await invoke('bootstrap')).activeRuns.length,boot.activeRuns.length);
    return {build:a,plan:b,saved:saved.workModes};
  });
  await check('Retirada de Ajustes, comandos e IPC; contexto y memoria',async()=>{
    await store("s=>s.setView('settings')");
    await page.locator('.settings-nav-list').waitFor();
    const tabs=await page.locator('.settings-nav-list [role="tab"]').allTextContents();
    assert.ok(tabs.length>=8);assert.ok(!tabs.some(t=>/^(Instrucciones|Instructions|Prompts)$/i.test(t.trim())));
    await store('s=>s.closeSettings()');
    const registry=await page.evaluate(async()=> (await import('/src/lib/commands.ts')).LOCAL_COMMANDS.map(c=>c.name));
    assert.ok(!registry.includes('/instructions')&&!registry.includes('/prompts'));
    for(const command of ['instructions_list','prompts_list']) await assert.rejects(invoke(command));
    // Verifica la evidencia concreta del fixture, incluyendo las revisiones ya sustituidas.
    const db=new DatabaseSync(join(process.env.APPDATA,'dev.duovra.studio.qa.agents','studio.sqlite3'),{readOnly:true});
    let historic;
    try {
      historic=db.prepare(`SELECT DISTINCT r.content FROM instruction_revisions r
        JOIN instruction_deliveries d ON d.instruction_id=r.instruction_id
        WHERE d.conversation_id=? AND d.agent='claude' AND d.account_id=? AND r.revision<=d.revision`).all(conv.id,boot.settings['accounts.active.claude']).map(r=>r.content);
    } finally {db.close();}
    assert.ok(historic.length>=2&&historic.some(s=>s.includes('QA-INS-GLOBAL'))&&historic.some(s=>s.includes('QA-INS-CONV-CLAUDE')),'No hay fixture legado verificable');
    const status=await invoke('context_status',{conversationId:conv.id,agent:'claude',includeBlock:true});
    assert.ok(!status.shared.block.includes('<duovra_instructions>'));
    const notice=status.shared.block.includes('<retired_instructions>');
    assert.equal(notice,true,'La sesión antigua no recibe el aviso de retirada');
    for(const content of historic)assert.ok(!status.shared.block.includes(content),'Se reinyectó una instrucción histórica');
    const fresh=await createTemporary('QA temporal · Contexto nuevo');
    try {
      const newStatus=await invoke('context_status',{conversationId:fresh.id,agent:'claude',includeBlock:true});
      assert.equal(newStatus.native.hasSession,false);
      assert.ok(!newStatus.shared.block.includes('<retired_instructions>'));
      assert.ok(!newStatus.shared.block.includes('<duovra_instructions>'));
      for(const content of historic)assert.ok(!newStatus.shared.block.includes(content));
    }finally{await invoke('delete_conversation',{id:fresh.id});temporary.delete(fresh.id);}
    const memory=await invoke('memory_save',{input:{conversationId:conv.id,content:'QA visual temporal: preservar memoria compartida '+crypto.randomUUID(),category:'instruction',priority:1}});
    try{
      const list=await invoke('memory_list',{conversationId:conv.id,includeArchived:false});
      assert.ok(list.some(m=>m.id===memory.id));
      const context=await invoke('context_status',{conversationId:conv.id,agent:'claude',includeBlock:true});
      assert.ok(context.shared.block.includes(memory.content));
    }finally{await invoke('memory_delete',{id:memory.id});}
    return {tabs,commands:registry.length,legacyWithdrawalPreview:notice,historicRevisionsExcluded:historic.length,freshHasNotice:false,memory:true};
  });
  if(closureOnly) {
    await check('Fast y opciones de envío: cierre y paso de clics',async()=>{
      verifyMock();
      const fresh=await createTemporary('QA temporal · Menús de envío');
      const closeCheck=async selector=>{
        const trigger=page.locator(selector);
        await trigger.click();
        const id=await trigger.getAttribute('aria-controls');assert.ok(id);
        const popup=page.locator('[id="'+id+'"]');await popup.waitFor();
        const rect=await popup.boundingBox();
        assert.ok(rect);
        const outside=await page.evaluate(id=>{
          const menu=document.getElementById(id);
          for(const y of [100,140,180,240])for(const x of [innerWidth*.65,innerWidth*.8,innerWidth*.5]){
            const hit=document.elementFromPoint(x,y);
            if(hit&&!menu.contains(hit)&&!hit.closest('button,a,input,textarea,[role="button"],[data-tauri-drag-region]'))return {x,y};
          }
          throw new Error('No hay punto exterior seguro');
        },id);
        await page.mouse.move(outside.x,outside.y);await page.mouse.down();
        assert.equal(await popup.count(),0,selector+' permanece montado tras pointerdown');
        assert.equal(await trigger.getAttribute('aria-expanded'),'false');
        const hit=await page.evaluate(({id,x,y})=>{const e=document.elementFromPoint(x,y);return !!e&&!e.closest('[id="'+id+'"],.composer-popup');},{id,x:rect.x+rect.width/2,y:rect.y+rect.height/2});
        assert.equal(hit,true,'La región del menú cerrado sigue interceptando clics');
        await page.mouse.up();
        // Abrir otro selector debe cerrar el anterior sin una segunda pulsación.
        await trigger.click();const secondId=await trigger.getAttribute('aria-controls');
        await page.locator('.mode-btn').click();
        assert.equal(await page.locator('[id="'+secondId+'"]').count(),0);
        assert.equal(await page.locator('.mode-btn').getAttribute('aria-expanded'),'true');
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('.mode-btn').getAttribute('aria-expanded'),'false');
        return {closedOnPointerDown:true,hitTest:true,switched:true};
      };
      try {
        await reloadReady();await open(fresh.id);
        const catalogs={};
        const fast=[];
        for(const agent of ['claude','codex']){
          await store('(s,a)=>s.refreshCatalog(a,true)',agent);
          const catalog=await store('(s,a)=>s.catalogs[a]',agent);
          assert.ok(catalog&&Array.isArray(catalog.models),'Catálogo QA no disponible: '+agent);
          catalogs[agent]=catalog.models;
          const m=catalog.models.find(m=>m.fast);
          if(!m){fast.push({agent,status:'NOT TESTED',reason:'El catálogo QA no declara Fast'});continue;}
          await store('(s,p)=>s.setPrefs(p.id,p.prefs)',{id:fresh.id,prefs:{agent,model:m.id,effort:m.defaultEffort??m.efforts?.[0]??null}});
          await page.locator('.fast-btn:not(:disabled)').waitFor({timeout:10000});
          fast.push({agent,model:m.id,status:'PASS',...await closeCheck('.fast-btn')});
        }
        console.log('FAST',JSON.stringify(fast));
        assert.ok(catalogs.codex.some(m=>m.id==='gpt-6-luna'),'Modelo QA de Codex no disponible');
        await store('(s,p)=>s.setPrefs(p.id,p.prefs)',{id:fresh.id,prefs:{agent:'codex',model:'gpt-6-luna',effort:'high'}});
        await store('(s,id)=>{s.setPermissions(id,"codex",{sandbox:"read-only",approval:"never"});s.setWorkMode(id,"codex","build");}',fresh.id);
        const token='QA-SLOW QA-MENU '+crypto.randomUUID(),from=mockLog().length;
        const sent=await store('(s,p)=>{const prefs=s.prefs[p.id];if(s.settings["accounts.active.codex"]!==p.account||prefs?.agent!=="codex"||prefs.model!=="gpt-6-luna"||prefs.effort!=="high")throw new Error("Cuenta/modelo QA no verificados");return s.send(p.id,p.text,[]);}',{id:fresh.id,account:boot.settings['accounts.active.codex'],text:token});
        assert.equal(sent,true);
        const id=await wait(()=>store('(s,id)=>s.runs[id]?.messageId',fresh.id),'ejecución visible en el compositor');
        await wait(()=>activeRun(fresh.id),'ejecución activa');
        await page.locator('.composer-input').fill('Borrador de QA: no enviar');
        await page.locator('.send-more').waitFor({timeout:10000});
        const send=await closeCheck('.send-more');
        assert.ok(await activeRun(fresh.id),'La ejecución terminó antes de comprobar el menú');
        assert.equal(await page.locator('.composer-input').inputValue(),'Borrador de QA: no enviar');
        await page.locator('.composer-input').fill('');
        const completed=await done(fresh,id);assert.equal(completed.status,'done');
        const requests=mockLog().slice(from).filter(r=>r.api==='responses'&&r.last?.includes(token));
        assert.ok(requests.length>0,'No se observó el turno en la API local');
        for(const r of requests){assert.equal(r.retiredInstructions,false);assert.deepEqual(r.instructions,[]);assert.equal(r.duovraBlock,false);}
        return {fast,send,requests:requests.length,realModelCalls:0};
      }finally{
        const run=await activeRun(fresh.id);
        if(run){await invoke('cancel_run',{runId:run.runId});await wait(async()=>!await activeRun(fresh.id),'cancelación QA');}
        await open(conv.id);
        await invoke('delete_conversation',{id:fresh.id});temporary.delete(fresh.id);
      }
    });
    await check('Retirada en bifurcación nativa: entrega y confirmación simuladas',async()=>{
      verifyMock();
      const source=boot.conversations.find(c=>c.projectId===project.id&&c.title==='QA · Instrucciones (Codex)');
      assert.ok(source);
      const fork=async id=>{
        const m=(await listMessages(id)).filter(m=>m.role==='assistant'&&m.status==='done').at(-1);
        assert.ok(m);
        const c=await invoke('fork_conversation',{request:{conversationId:id,messageId:m.id,purpose:'fork'}});
        temporary.add(c.id);return c;
      };
      const b=await fork(source.id),c=await fork(b.id);
      assert.equal(c.origin.native.codex.state,'pending');
      await invoke('delete_conversation',{id:b.id});temporary.delete(b.id);
      const preview=await invoke('context_status',{conversationId:c.id,agent:'codex',includeBlock:true});
      assert.ok(preview.shared.block.includes('<retired_instructions>'),'No hay aviso después de eliminar el padre');
      assert.ok(!/QA-INS-|<duovra_instructions>/.test(preview.shared.block));
      try {
        const from=mockLog().length;
        const first='QA-RETIRE '+crypto.randomUUID();
        const id=await submitMock(c,'codex',first);
        assert.equal((await done(c,id)).status,'done');
        const after=(await invoke('bootstrap')).conversations.find(x=>x.id===c.id);
        assert.equal(after.origin.native.codex.state,'native','La CLI no bifurcó nativamente');
        const requests=mockLog().slice(from).filter(r=>r.api==='responses'&&r.last?.includes(first));
        assert.ok(requests.length>0);
        for(const r of requests){assert.equal(r.retiredInstructions,true);assert.deepEqual(r.instructions,[]);assert.equal(r.duovraBlock,false);}
        const confirmed=await invoke('context_status',{conversationId:c.id,agent:'codex',includeBlock:true});
        assert.ok(!confirmed.shared.block.includes('<retired_instructions>'),'Se volvió a preparar el aviso confirmado');
        const second='QA-RETIRE '+crypto.randomUUID(),from2=mockLog().length;
        const id2=await submitMock(c,'codex',second);
        assert.equal((await done(c,id2)).status,'done');
        const requests2=mockLog().slice(from2).filter(r=>r.api==='responses'&&r.last?.includes(second));
        assert.ok(requests2.length>0);
        for(const r of requests2){assert.equal(r.retiredInstructions,false);assert.deepEqual(r.instructions,[]);assert.equal(r.duovraBlock,false);}
        return {native:true,firstRequests:requests.length,secondRequests:requests2.length,duplicate:false};
      }finally{
        const run=await activeRun(c.id);
        if(run){await invoke('cancel_run',{runId:run.runId});await wait(async()=>!await activeRun(c.id),'cancelación QA');}
        await invoke('delete_conversation',{id:c.id});temporary.delete(c.id);
      }
    });
  }
}finally{
  for(const id of temporary){
    const run=await activeRun(id).catch(()=>null);
    if(run){await invoke('cancel_run',{runId:run.runId});await wait(async()=>!await activeRun(id),'cancelación QA');}
    await invoke('delete_conversation',{id}).catch(()=>{});
  }
  if(native('get').min)native('restore');
  if(!original.min)native('resize',original.w,original.h);
  await store('s=>s.closeSettings()').catch(()=>{});
  await store('s=>s.closePanel()').catch(()=>{});
  await collapse(initialSidebar).catch(()=>{});
  await open(conv.id).catch(()=>{});
  await page.screenshot({path:join(out,'review-ready.png')}).catch(()=>{});
  await browser.close();
}
console.log('TOTAL',results.filter(r=>r.ok).length+'/'+results.length,'page errors',errors.length);
process.exit(results.length===(menusOnly?1:closureOnly?3:6)&&results.every(r=>r.ok)&&!errors.length?0:1);
