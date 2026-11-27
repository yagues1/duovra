import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const QA_IDENTIFIER = 'dev.duovra.studio.qa.agents';

// Nothing here may bootstrap, reload, select a conversation or change state.
// Check the native identifier before even looking at the loaded store.
export async function authorizeQaPage(page, qa) {
  const identifier = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:app|identifier'));
  assert.equal(identifier, QA_IDENTIFIER, 'Unauthorized QA application identifier');
  const state = await page.evaluate(async () => {
    const resource = performance.getEntriesByType('resource').find(e => new URL(e.name).pathname === '/src/state/store.ts');
    if (!resource) return null;
    const { useStore } = await import(resource.name);
    const s = useStore.getState();
    if (!s.ready) return null;
    return {
      accounts: ['claude', 'codex'].map(agent => {
        const account = s.accounts.find(x => x.id === s.settings['accounts.active.' + agent]);
        return account ? { id: account.id, agent: account.agent, label: account.label, configDir: account.configDir } : null;
      }),
      previous: s.activeConversationId,
    };
  });
  assert(state, 'QA store is not already loaded and ready');
  const accounts = {};
  for (const [i, agent] of ['claude', 'codex'].entries()) {
    const account = state.accounts[i];
    assert(account?.agent === agent && account.label?.startsWith('QA simulada') && account.id && account.configDir,
      'Unauthorized QA account: ' + agent);
    assert.equal(resolve(account.configDir), resolve(qa, agent === 'claude' ? 'claude-config' : 'codex-home'),
      'Unauthorized QA account directory: ' + agent);
    accounts[agent] = account.id;
  }
  assert.equal(JSON.parse(readFileSync(join(qa, 'claude-config', 'settings.json'), 'utf8')).env.ANTHROPIC_BASE_URL,
    'http://127.0.0.1:53396');
  const config = readFileSync(join(qa, 'codex-home', 'config.toml'), 'utf8');
  assert.match(config, /^\s*model_provider\s*=\s*"qa"\s*$/m);
  assert.match(config, /^\s*base_url\s*=\s*"http:\/\/127\.0\.0\.1:53397\/v1"\s*$/m);
  return { accounts, previous: state.previous };
}

export async function selectAuthorizedQaPage(browser, qa) {
  const pages = browser.contexts().flatMap(c => c.pages()).filter(p => p.url().startsWith('http://localhost:1420/'));
  assert.equal(pages.length, 1, 'Missing or ambiguous QA WebView');
  const page = pages[0];
  return { page, ...await authorizeQaPage(page, qa) };
}

// The log offsets are captured immediately before each request. A unique
// marker in the actual user text prevents unrelated requests matching.
export function assertPlanDelivery(records, { from, requestText, goalText }) {
  const matches = records.slice(from).filter(r =>
    r.api === 'responses' && r.scenario === 'QA-PLAN' && r.last?.includes(requestText));
  assert(matches.length, 'No current Codex QA-PLAN request');
  for (const r of matches) {
    assert.equal(r.planMode, true, 'Codex request did not use plan mode');
    assert.equal(r.context, true, 'Codex request omitted shared context');
    assert.equal(r.goal, true, 'Codex request omitted conversation goal');
    assert.equal(r.goalText, goalText, 'Codex request delivered the wrong conversation goal');
  }
  return { requests: matches.length, context: true, goal: true, goalText };
}

export function assertPlanHandoff(records, { from, handoffId, planVersion, planText }) {
  const current = records.slice(from);
  const matches = current.filter(r => r.api === 'anthropic' && r.phase7HandoffId === handoffId);
  assert(matches.length, 'No current Claude handoff request');
  for (const r of matches) {
    assert.equal(r.approvedPlan, String(planVersion), 'Wrong approved plan version on the wire');
    assert.equal(r.approvedPlanText, planText.trim(), 'Wrong approved plan content on the wire');
  }
  assert(!current.some(r => r.api === 'responses'), 'Unexpected Codex request during Claude handoff');
  return { requests: matches.length, version: planVersion, textVerified: true };
}
