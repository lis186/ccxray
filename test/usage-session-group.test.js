'use strict';

const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { analyze, run } = require('../server/usage');

const turn = (model, cost, n) => ({
  id: `synthetic-turn-${n}`, sessionId: 'synthetic-codex-session',
  provider: 'openai', agent: 'codex', model, cost: { cost },
  receivedAt: 1000 + n * 60000,
});
const turns = [turn('gpt-5', 1.25, 0), turn('gpt-5-mini', 0.5, 1), turn('gpt-5', 0.75, 2)];
const fold = count => ({ count, fallbackCount: 0, fallbackCost: 0, unknownCount: 0 });

it('usage --json reports one Codex session with combined cost and every model', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-usage-session-group-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, 'logs'));
  const index = turns.map(e => JSON.stringify(e)).join('\n') + '\n';
  const indexPath = path.join(home, 'logs/index.ndjson');
  fs.writeFileSync(indexPath, index);
  const env = { ...process.env, HOME: home, USERPROFILE: home,
    CCXRAY_HOME: home, LOGS_DIR: path.join(home, 'logs'),
    CODEX_HOME: path.join(home, 'unused-codex'), CLAUDE_CONFIG_DIR: path.join(home, 'unused-claude'),
    CCXRAY_EXPORT_DISABLE: '1' };
  for (const name of ['CCXRAY_AGENT_ID', 'ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL']) delete env[name];
  const originalEnv = { ...process.env };
  const originalLog = console.log;
  const output = [];
  let result;
  try {
    process.env = env;
    console.log = line => output.push(line);
    await run(['--json']);
    assert.equal(output.length, 1);
    result = JSON.parse(output[0]);
  } finally {
    process.env = originalEnv;
    console.log = originalLog;
  }
  assert.equal(result.meta.totalSessions, 1);
  assert.equal(result.sessions.count, 1);
  assert.equal(result.sessions.topSessions.length, 1);
  const session = result.sessions.topSessions[0];
  assert.equal(session.sessionId, turns[0].sessionId);
  assert.equal(session.turns, 3);
  assert.equal(session.cost, 2.5);
  assert.equal(session.model, 'gpt-5'); // existing dominant-model string
  assert.equal(session.provider, 'openai');
  assert.deepEqual(session.costAgg, fold(3));
  assert.deepEqual(session.modelBreakdown, [
    { model: 'gpt-5', turns: 2, cost: 2, costAgg: fold(2) },
    { model: 'gpt-5-mini', turns: 1, cost: 0.5, costAgg: fold(1) },
  ]);
  assert.equal(fs.readFileSync(indexPath, 'utf8'), index);
});

it('model switches leave all existing session fields and summary counts unchanged', () => {
  const single = analyze(turns.map(e => ({ ...e, model: 'gpt-5' })));
  const mixed = analyze(turns);
  const { modelBreakdown: singleModels, ...singleSession } = single.sessions.topSessions[0];
  const { modelBreakdown: mixedModels, ...mixedSession } = mixed.sessions.topSessions[0];
  assert.deepEqual(mixedSession, singleSession);
  assert.deepEqual(mixed.meta, single.meta);
  assert.equal(mixed.sessions.count, single.sessions.count);
  assert.deepEqual(mixed.sessions.turnDistribution, single.sessions.turnDistribution);
  assert.equal(singleModels.length, 1);
  assert.equal(mixedModels.length, 2);
});

it('session model breakdown is uncapped and retains unknown/fallback confidence', () => {
  const entries = Array.from({ length: 12 }, (_, n) => turn(`synthetic-model-${n}`, 0.25, n));
  entries.push({ ...turn(null, null, 12), cost: { cost: null, confidence: 'unknown' } });
  entries.push({ ...turn('synthetic-model-0', 0.5, 13), cost: { cost: 0.5, confidence: 'fallback' } });
  const result = analyze(entries);
  assert.equal(result.sessions.count, 1);
  const session = result.sessions.topSessions[0];
  assert.equal(session.cost, 3.5);
  assert.equal(session.modelBreakdown.length, 13);
  assert.deepEqual(session.modelBreakdown[0], {
    model: 'synthetic-model-0', turns: 2, cost: 0.75,
    costAgg: { count: 2, fallbackCount: 1, fallbackCost: 0.5, unknownCount: 0 },
  });
  assert.deepEqual(session.modelBreakdown.find(m => m.model === 'unknown'), {
    model: 'unknown', turns: 1, cost: 0, costAgg: { ...fold(1), unknownCount: 1 },
  });
});
