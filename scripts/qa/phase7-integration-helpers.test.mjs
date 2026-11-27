import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { QA_IDENTIFIER, selectAuthorizedQaPage, assertPlanDelivery, assertPlanHandoff } from './phase7-integration-helpers.mjs';

function fixture(qa, identifier, alter = state => state) {
  const state = {
    accounts: [
      { id: 'a', agent: 'claude', label: 'QA simulada Claude', configDir: join(qa, 'claude-config') },
      { id: 'b', agent: 'codex', label: 'QA simulada Codex', configDir: join(qa, 'codex-home') },
    ],
    previous: 'original',
  };
  const profile = { conversations: ['original', 'empty-provisional'], restoreNotice: 'pending' };
  const events = [];
  const page = {
    url: () => 'http://localhost:1420/',
    async evaluate(fn) {
      if (events.length === 0) {
        // Execute the actual native-identity callback, against a fake IPC.
        return runInNewContext(`(${fn.toString()})()`, {
          window: { __TAURI_INTERNALS__: { invoke(command) {
            events.push(command);
            if (command === 'bootstrap') {
              profile.conversations.pop();
              profile.restoreNotice = null;
            }
            assert.equal(command, 'plugin:app|identifier');
            return identifier;
          } } },
        });
      }
      events.push('loaded-store-read');
      assert.match(fn.toString(), /useStore\.getState\(\)/);
      assert.doesNotMatch(fn.toString(), /bootstrap|\.invoke\(|\.setState\(/);
      return alter(structuredClone(state));
    },
    reload() { throw Error('Unexpected reload'); },
  };
  const browser = { contexts: () => [{ pages: () => [page] }] };
  return { browser, page, events, profile };
}

test('reject non-QA CDP identity before store reads or mutating IPC (even with matching QA accounts)', async () => {
  const f = fixture('not-a-real-profile', 'dev.duovra.studio');
  const before = structuredClone(f.profile);
  await assert.rejects(selectAuthorizedQaPage(f.browser, 'not-a-real-profile'), /Unauthorized QA application identifier/);
  assert.deepEqual(f.events, ['plugin:app|identifier']);
  assert.deepEqual(f.profile, before);
});

test('reject ambiguous CDP page selection without any IPC', async () => {
  const f = fixture('unused', QA_IDENTIFIER);
  const browser = { contexts: () => [{ pages: () => [f.page, f.page] }] };
  await assert.rejects(selectAuthorizedQaPage(browser, 'unused'), /ambiguous QA WebView/);
  assert.deepEqual(f.events, []);
});

test('reject authorized identity with unloaded store or invalid active accounts, without bootstrap', async () => {
  for (const [alter, error] of [
    [() => null, /not already loaded/],
    [s => ({ ...s, accounts: [null, s.accounts[1]] }), /Unauthorized QA account: claude/],
    [s => ({ ...s, accounts: [s.accounts[0], { ...s.accounts[1], configDir: 'other-profile' }] }), /Unauthorized QA account directory: codex/],
    [s => ({ ...s, accounts: [s.accounts[0], { ...s.accounts[1], agent: 'claude' }] }), /Unauthorized QA account: codex/],
  ]) {
    const f = fixture('unused', QA_IDENTIFIER, alter);
    const before = structuredClone(f.profile);
    await assert.rejects(selectAuthorizedQaPage(f.browser, 'unused'), error);
    assert.deepEqual(f.events, ['plugin:app|identifier', 'loaded-store-read']);
    assert.deepEqual(f.profile, before);
  }
});

test('accept only loaded QA accounts with both isolated loopback configs', async () => {
  const qa = mkdtempSync(join(tmpdir(), 'duovra-phase7-guard-test-'));
  try {
    mkdirSync(join(qa, 'claude-config'));
    mkdirSync(join(qa, 'codex-home'));
    writeFileSync(join(qa, 'claude-config', 'settings.json'), JSON.stringify({env:{ANTHROPIC_BASE_URL:'http://127.0.0.1:53396'}}));
    const config = join(qa, 'codex-home', 'config.toml');
    writeFileSync(config, 'model_provider = "qa"\nbase_url = "http://127.0.0.1:53397/v1"\n');
    const f = fixture(qa, QA_IDENTIFIER);
    const accepted = await selectAuthorizedQaPage(f.browser, qa);
    assert.equal(accepted.page, f.page);
    assert.deepEqual(accepted.accounts, {claude:'a', codex:'b'});
    assert.equal(accepted.previous, 'original');
    assert.deepEqual(f.events, ['plugin:app|identifier','loaded-store-read']);
    writeFileSync(config, 'model_provider = "qa"\nbase_url = "https://example.invalid/v1"\n');
    await assert.rejects(selectAuthorizedQaPage(fixture(qa, QA_IDENTIFIER).browser, qa));
  } finally { rmSync(qa, {recursive:true, force:true}); }
});

const requestText = 'QA-PLAN Phase7 current-run';
const goalText = 'Phase7 objective current-goal';
const plan = {api:'responses', scenario:'QA-PLAN', last:requestText, planMode:true, context:true, goal:true, goalText};
const unrelated = {...plan, last:'QA-PLAN Phase7 different-run'};
const planArgs = {from:1, requestText, goalText};

test('accept the correlated current plan request only', () => {
  assert.deepEqual(assertPlanDelivery([plan, unrelated, plan], planArgs), {requests:1, context:true, goal:true, goalText});
  assert.throws(() => assertPlanDelivery([plan, unrelated], planArgs), /No current Codex/);
});

test('reject missing or wrong context and goal even with valid historic and unrelated requests', () => {
  for (const [change, error] of [
    [{context:false}, /omitted shared context/],
    [{context:undefined}, /omitted shared context/],
    [{goal:false}, /omitted conversation goal/],
    [{goal:undefined}, /omitted conversation goal/],
    [{goalText:'historical goal'}, /wrong conversation goal/],
    [{goalText:null}, /wrong conversation goal/],
    [{planMode:false}, /did not use plan mode/],
  ]) {
    assert.throws(() => assertPlanDelivery([plan, unrelated, {...plan,...change}], planArgs), error);
    assert.throws(() => assertPlanDelivery([plan, plan, {...plan,...change}], planArgs), error);
  }
});

const handoff = {api:'anthropic', phase7HandoffId:'current-run', approvedPlan:'1', approvedPlanText:'# Exact plan\n1. Read README'};
const handoffArgs = {from:1, handoffId:'current-run', planVersion:1, planText:handoff.approvedPlanText};

test('require the current Claude request to contain the exact approved version and text', () => {
  assert.deepEqual(assertPlanHandoff([handoff,handoff], handoffArgs), {requests:1, version:1, textVerified:true});
  assert.throws(() => assertPlanHandoff([handoff,{...handoff,phase7HandoffId:'other-run'}], handoffArgs), /No current Claude/);
  assert.throws(() => assertPlanHandoff([handoff,{...handoff,approvedPlan:null}], handoffArgs), /Wrong approved plan version/);
  assert.throws(() => assertPlanHandoff([handoff,{...handoff,approvedPlan:'2'}], handoffArgs), /Wrong approved plan version/);
  assert.throws(() => assertPlanHandoff([handoff,{...handoff,approvedPlanText:null}], handoffArgs), /Wrong approved plan content/);
  assert.throws(() => assertPlanHandoff([handoff,{...handoff,approvedPlanText:'Different text'}], handoffArgs), /Wrong approved plan content/);
  assert.throws(() => assertPlanHandoff([handoff,handoff,plan], handoffArgs), /Unexpected Codex request/);
});
