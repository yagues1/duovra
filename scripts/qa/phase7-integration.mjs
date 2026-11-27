// Final cross-phase smoke test. Only the existing isolated loopback QA profile.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const qa = join(tmpdir(), 'duovra-qa-control');
const log = () => readFileSync(join(qa, 'mock-fase6', 'requests.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().startsWith('http://localhost:1420/'));
assert(page, 'Missing QA WebView');
const invoke = (c,a={}) => page.evaluate(([c,a])=>window.__TAURI_INTERNALS__.invoke(c,a),[c,a]);
const store = (body,arg) => page.evaluate(async ([body,arg])=>{
  const resource=performance.getEntriesByType('resource').find(e=>new URL(e.name).pathname==='/src/state/store.ts');
  const {useStore}=await import(resource.name);
  return (0,eval)(body)(useStore.getState(),arg);
},[body,arg]);
const boot = await invoke('bootstrap');
const accounts = {};
for (const a of ['claude','codex']) {
  const account = boot.accounts.find(x=>x.id===boot.settings['accounts.active.'+a]);
  assert(account?.label.startsWith('QA simulada'));
  assert.equal(resolve(account.configDir),resolve(qa,a==='claude'?'claude-config':'codex-home'));
  accounts[a]=account.id;
}
assert.equal(JSON.parse(readFileSync(join(qa,'claude-config','settings.json'),'utf8')).env.ANTHROPIC_BASE_URL,'http://127.0.0.1:53396');
const config=readFileSync(join(qa,'codex-home','config.toml'),'utf8');
assert.match(config,/^\s*model_provider\s*=\s*"qa"\s*$/m);
assert.match(config,/^\s*base_url\s*=\s*"http:\/\/127\.0\.0\.1:53397\/v1"\s*$/m);
assert.equal(boot.activeRuns.length,0);
const previous=await store('s=>s.activeConversationId');
const start=log().length, results=[], errors=[];
page.on('pageerror',e=>errors.push(String(e)));
const out=resolve(process.argv.slice(2).find(a=>!a.startsWith('--'))??'output/qa-phase7');
const controlOnly=process.argv.includes('--control-only');
const questionOnly=process.argv.includes('--question-only');
mkdirSync(out,{recursive:true});
const root=mkdtempSync(join(tmpdir(),'duovra-phase7-'));
const repo=join(root,'repo'); mkdirSync(repo);
const git=(...args)=>execFileSync('git',['-C',repo,...args],{windowsHide:true});
let project, wt, server;
const wait=async(fn,label,timeout=45000)=>{
  const since=Date.now();
  while(Date.now()-since<timeout){const v=await fn();if(v)return v;await new Promise(r=>setTimeout(r,200));}
  throw Error('Timeout: '+label);
};
const messages=async id=>(await invoke('list_messages',{conversationId:id,includeSessions:false})).messages;
const active=async id=>(await invoke('bootstrap')).activeRuns.find(r=>r.conversationId===id);
const interactions=id=>invoke('list_interactions',{conversationId:id});
const idle=id=>wait(async()=>!(await active(id))&&(await messages(id)).filter(m=>m.role==='assistant').at(-1),'idle');
const perms={claude:{mode:'manual'},codex:{sandbox:'read-only',approval:'never'}};
const req=(id,agent,text,workMode='build')=>({conversationId:id,agent,model:agent==='claude'?'haiku':'gpt-6-luna',effort:agent==='claude'?'medium':'high',text,attachments:[],speed:null,permissions:perms[agent],workMode});
const guard=async()=>{
  const s=(await invoke('bootstrap')).settings;
  for(const a of ['claude','codex'])assert.equal(s['accounts.active.'+a],accounts[a]);
};
const submit=async request=>{
  await guard();
  const r=await invoke('submit_message',{id:crypto.randomUUID(),request,accountId:accounts[request.agent]});
  assert.equal(r.mode,'started');return r.started;
};
const fresh=async(title)=>{
  const c=await invoke('create_conversation',{projectId:project.id,title});
  await invoke('set_draft',{conversationId:c.id,draft:'QA'});
  return c;
};
const open=async id=>{
  await page.reload();
  await wait(()=>store('s=>s.ready').catch(()=>false),'store ready');
  await store('(s,id)=>s.selectConversation(id)',id);
  await page.locator('.composer-input').waitFor();
};
const prepare=async(id,agent)=>{
  await guard();
  await store('(s,a)=>s.refreshCatalog(a,true)',agent);
  const {model,effort,permissions}=req(id,agent,'');
  const catalog=await store('(s,a)=>s.catalogs[a]',agent);
  assert(catalog?.models?.some(m=>m.id===model&&m.efforts.includes(effort)),'QA model not available');
  await store('(s,p)=>{s.setPrefs(p.id,{agent:p.agent,model:p.model,effort:p.effort});s.setPermissions(p.id,p.agent,p.permissions);s.setWorkMode(p.id,p.agent,"build");}',{id,agent,model,effort,permissions});
  assert.deepEqual(await store('(s,id)=>{const {agent,model,effort}=s.prefs[id];return {agent,model,effort};}',id),{agent,model,effort});
  await guard();
};
const sendFromStore=async(id,agent,text)=>{
  await guard();
  const {model,effort}=req(id,agent,'');
  const sent=await store('(s,p)=>{const v=s.prefs[p.id];if(s.settings["accounts.active."+p.agent]!==p.account||v?.agent!==p.agent||v.model!==p.model||v.effort!==p.effort)throw Error("Unsafe QA selection");return s.send(p.id,p.text,[]);}',{id,agent,model,effort,account:accounts[agent],text});
  assert.equal(sent,true,'Store rejected QA send');
};
const check=async(name,fn)=>{
  try{const detail=await fn();results.push({name,ok:true,detail});console.log('OK',name,JSON.stringify(detail));}
  catch(e){results.push({name,ok:false,error:String(e)});console.error('FAIL',name,String(e));}
};
try {
  git('init','-q'); writeFileSync(join(repo,'README.md'),'# Phase 7 fixture\n');
  git('add','README.md');git('-c','user.name=QA','-c','user.email=qa@example.invalid','commit','-qm','fixture');
  project=await invoke('create_project',{name:'QA Phase 7 '+crypto.randomUUID(),path:repo});
  if(!controlOnly&&!questionOnly)await check('Shared context, persistent goal, plan handoff and historical fork',async()=>{
    const c=await fresh('Phase7 handoff');
    const marker='Phase7 objective '+crypto.randomUUID();
    const before=log().length;
    await invoke('goal_set',{conversationId:c.id,content:marker});
    const m=await invoke('memory_save',{input:{conversationId:c.id,category:'decision',content:'Original decision',priority:1}});
    assert.equal(log().length,before,'Local memory started a turn');
    await submit(req(c.id,'claude','QA-CONTEXT Initial context')); const first=await idle(c.id);assert.equal(first.status,'done');
    const ctx=await invoke('context_status',{conversationId:c.id,agent:'codex',includeBlock:true});
    assert(ctx.shared.block.includes(marker)&&ctx.shared.block.includes('Original decision'));
    await submit(req(c.id,'codex','QA-PLAN Planifica una sección de QA en el README.','plan'));
    assert.equal((await idle(c.id)).status,'done');
    const plan=await wait(async()=>(await interactions(c.id)).find(i=>i.kind==='plan'&&i.status==='pending'),'Codex plan');
    assert.equal(plan.version,1);
    const transfer=log().length;
    await guard();
    const approved=await invoke('decide_plan',{interactionId:plan.id,action:'approve',feedback:null,request:req(c.id,'claude','Implementa el plan aprobado.')});
    assert.equal(approved.mode,'started');assert.equal((await idle(c.id)).status,'done');
    const list=await messages(c.id);
    assert.deepEqual(list.filter(m=>m.role==='user').at(-1).contextNote.approvedPlan,{id:plan.id,version:1,agent:'codex'});
    assert(log().slice(transfer).some(r=>r.api==='anthropic'&&r.approvedPlan==='1'));
    assert(!log().slice(transfer).some(r=>r.api==='responses'));
    await invoke('memory_save',{input:{id:m.id,conversationId:c.id,category:'decision',content:'Revised decision',priority:1}});
    const fork=await invoke('fork_conversation',{request:{conversationId:c.id,messageId:first.id,purpose:'fork'}});
    const historical=await invoke('memory_list',{conversationId:fork.id,includeArchived:false});
    assert(historical.some(m=>m.content==='Original decision'));
    assert(historical.some(m=>m.content===marker));
    assert(!historical.some(m=>m.content==='Revised decision'));
    assert(!(await interactions(fork.id)).some(i=>i.status==='pending'));
    assert.equal((await messages(c.id)).length,list.length);
    return {planVersion:1,goalPersisted:true,historicalFork:true,requests:log().length-before};
  });
  await check('Quick command, interactive question and Activity Center',async()=>{
    const c=await fresh('Phase7 question');
    // Bootstrap is a startup API: it purges abandoned empty chats. Keep
    // this conversation non-empty when the local slash command clears its draft.
    await invoke('goal_set',{conversationId:c.id,content:'QA question fixture'});
    await open(c.id);
    await prepare(c.id,'claude');
    const input=page.locator('.composer-input');
    await input.fill('/status');await input.press('Enter');
    await page.locator('.activity-center').waitFor();
    await page.keyboard.press('Escape');
    await sendFromStore(c.id,'claude','QA-ASK Phase7 decision');
    const q=await wait(async()=>(await interactions(c.id)).find(i=>i.kind==='question'&&i.status==='pending'),'question');
    await page.locator('[data-activity-center]').click();
    await page.locator('.ac-row[data-status="answer"]',{hasText:c.title}).waitFor();
    await page.keyboard.press('Escape');
    await assert.rejects(invoke('answer_question',{interactionId:q.id,answers:[{selected:['invalid']},{selected:['Tests']}]}));
    await invoke('answer_question',{interactionId:q.id,answers:[{selected:['Postgres']},{selected:['Tests']} ]});
    assert.equal((await idle(c.id)).status,'done');
    assert.equal((await interactions(c.id)).find(i=>i.id===q.id).status,'answered');
    assert.equal((await invoke('bootstrap')).conversations.find(x=>x.id===c.id).permissionPrefs.claude.mode,'manual');
    return {question:'answered',invalidRejected:true,activity:'answer',permissions:'manual'};
  });
  if(!questionOnly)await check('Codex steering and Claude queue/interrupt across the composer',async()=>{
    const c=await fresh('Phase7 run');
    await open(c.id);
    await prepare(c.id,'codex');
    await sendFromStore(c.id,'codex','QA-VERYSLOW Phase7 long turn');
    await wait(async()=>await page.locator('.send-btn').getAttribute('aria-keyshortcuts')==='Alt+Enter','steer ready');
    const input=page.locator('.composer-input');
    await input.fill('QA-STEER Phase7 additional direction');
    await page.locator('.send-more').click();
    await page.locator('.popover .menu-item',{hasText:/Enviar ahora|Send now/}).click();
    await wait(async()=>(await messages(c.id)).some(m=>m.role==='user'&&m.content.includes('Phase7 additional direction')),'steered message');
    assert.equal((await idle(c.id)).status,'done');
    // Steering can complete the mock turn immediately. Use a separate long
    // Claude turn for queue/interrupt, also verifying its unsupported steering.
    const q=await fresh('Phase7 queue');
    await open(q.id);
    await prepare(q.id,'claude');
    await sendFromStore(q.id,'claude','QA-VERYSLOW Phase7 queued turn');
    await page.locator('.composer[data-busy]').waitFor();
    await input.fill('QA-QUEUE Phase7 saved');
    await page.locator('.send-more').click();
    assert(await page.locator('.popover .menu-item',{hasText:/Enviar ahora|Send now/}).isDisabled());
    await page.locator('.popover .menu-item',{hasText:/Añadir a la cola|Add to queue/}).click();
    await wait(async()=>(await invoke('message_queue',{conversationId:q.id})).entries.length===1,'queue');
    await input.fill('QA-CONTINUE Phase7 replacement');
    await page.locator('.send-more').click();
    await page.locator('.popover .menu-item',{hasText:/Interrumpir y continuar|Interrupt and continue/}).click();
    await wait(async()=>(await messages(q.id)).some(m=>m.role==='user'&&m.content.includes('Phase7 replacement')),'replacement');
    assert.equal((await idle(q.id)).status,'done');
    assert.deepEqual((await messages(q.id)).filter(m=>m.role==='assistant').map(m=>m.status),['cancelled','done']);
    const queue=await invoke('message_queue',{conversationId:q.id});
    assert.equal(queue.entries.length,1);assert(queue.pauseReason);
    return {steer:true,queuePreserved:true,paused:true};
  });
  if(!controlOnly&&!questionOnly)await check('Git worktree, conversation and isolated Live Preview',async()=>{
    wt=await invoke('worktree_create',{projectId:project.id,request:{name:'QA branch',path:join(root,'branch'),branch:'qa-phase7',newBranch:true,base:'HEAD'}});
    const c=await invoke('create_conversation',{projectId:project.id,title:'Phase7 worktree',worktreeId:wt.id});
    await invoke('set_draft',{conversationId:c.id,draft:'QA'});
    assert.equal(c.worktreeId,wt.id);
    writeFileSync(join(root,'branch','README.md'),'# Branch-only fixture\n');
    const doc=await invoke('workspace_read',{projectId:wt.id,path:'README.md'});
    assert(JSON.stringify(doc).includes('Branch-only fixture'));
    server=createServer((_,res)=>res.end('<html><title>Phase7 worktree</title><body>QA</body></html>'));
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    const url='http://127.0.0.1:'+server.address().port;
    await invoke('live_preview_open',{space:wt.id,url,external:false,bounds:{x:200,y:100,width:320,height:250,cssWidth:await page.evaluate(()=>innerWidth),zoom:1}});
    const state=await wait(async()=>{const s=await invoke('live_preview_state',{space:wt.id});return s.alive&&JSON.stringify(s.nav).includes(url)?s:null;},'preview navigation');
    assert.equal(state.space,wt.id);
    assert.equal((await invoke('live_preview_state',{space:project.id})).alive,false);
    return {worktree:true,previewIsolated:true};
  });
} finally {
  if(wt)await invoke('live_preview_close',{space:wt.id}).catch(e=>errors.push(String(e)));
  if(server)await new Promise(r=>server.close(r));
  if(project){
    const b=await invoke('bootstrap');
    const ids=new Set(b.conversations.filter(c=>c.projectId===project.id).map(c=>c.id));
    for(const run of b.activeRuns.filter(r=>ids.has(r.conversationId)))await invoke('cancel_run',{runId:run.runId});
    await wait(async()=>!(await invoke('bootstrap')).activeRuns.some(r=>ids.has(r.conversationId)),'cleanup');
    await invoke('delete_project',{id:project.id});
    await page.reload();
    await wait(()=>store('s=>s.ready').catch(()=>false),'restore');
    if(previous)await store('(s,id)=>s.selectConversation(id)',previous);
  }
  rmSync(root,{recursive:true,force:true});
  writeFileSync(join(out,'integration.json'),JSON.stringify({results,errors,loopbackRequests:log().length-start,realModelCalls:0},null,2));
  await browser.close();
}
process.exit(results.length===(questionOnly?1:controlOnly?2:4)&&results.every(r=>r.ok)&&!errors.length?0:1);
