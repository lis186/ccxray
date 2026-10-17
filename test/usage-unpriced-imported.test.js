'use strict';

// #688: `ccxray usage` over (1) a model with no price and (2) an imported Claude
// session. The imported lines are produced by the real importer from a synthetic
// transcript, so the test pins the shape the importer actually writes
// (turnToolCallIds, no turnToolCalls/toolCalls) rather than a hand-made copy.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-usage-688-'));
process.env.CCXRAY_HOME = HOME;
fs.mkdirSync(path.join(HOME, 'logs'), { recursive: true });
const INDEX_PATH = path.join(HOME, 'logs', 'index.ndjson');
fs.writeFileSync(INDEX_PATH, '');

const { parseSessionFile } = require('../server/importer');
const { buildIndexLine } = require('../server/entry');
const { analyze } = require('../server/usage');
require('../server/pricing').__setContextTableForTests(null);

const UNPRICED = 'synthetic-unpriced-model';
const IMPORTED_SID = 'imported-session-0001';

const transcriptLine = (type, extra) => JSON.stringify({
  type, uuid: `uuid-${Math.random().toString(36).slice(2)}`, parentUuid: 'p',
  sessionId: IMPORTED_SID, cwd: '/synthetic/imported', ...extra,
});
const assistant = (ts, msgId, content) => transcriptLine('assistant', {
  timestamp: ts,
  message: {
    id: msgId, model: 'claude-sonnet-4-6', role: 'assistant', content, stop_reason: 'tool_use',
    usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  },
});

const proxyEntry = (overrides) => JSON.parse(buildIndexLine({
  id: '2026-07-15T11-00-00-000', ts: '11:00:00', sessionId: 'proxy-session-0001',
  provider: 'anthropic', agent: 'claude', model: 'claude-sonnet-4-6', msgCount: 2, toolCount: 0,
  toolCalls: {}, turnToolCalls: {}, isSubagent: false, cwd: '/synthetic/proxy',
  receivedAt: Date.parse('2026-07-15T11:00:00.000Z'),
  usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  cost: { cost: 1, confidence: 'exact' }, title: 'Synthetic proxy turn', toolFail: false,
  ...overrides,
}));

let lines;

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-usage-688-transcript-'));
  const file = path.join(dir, `${IMPORTED_SID}.jsonl`);
  fs.writeFileSync(file, [
    transcriptLine('user', { timestamp: '2026-07-15T10:29:50.000Z', message: { role: 'user', content: [{ type: 'text', text: 'Synthetic imported task' }] } }),
    assistant('2026-07-15T10:30:00.000Z', 'msg_synthetic_1', [
      { type: 'tool_use', id: 'toolu_synthetic_1', name: 'Read', input: {} },
      { type: 'tool_use', id: 'toolu_synthetic_2', name: 'Bash', input: {} },
    ]),
    transcriptLine('user', { timestamp: '2026-07-15T10:30:05.000Z', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'toolu_synthetic_1', content: 'ok' },
      { type: 'tool_result', tool_use_id: 'toolu_synthetic_2', content: 'ok' },
    ] } }),
    assistant('2026-07-15T10:30:10.000Z', 'msg_synthetic_2', [
      { type: 'tool_use', id: 'toolu_synthetic_3', name: 'Read', input: {} },
    ]),
    // A parsed response with no tool_use: turnToolCallIds is {} — zero, not unknown.
    assistant('2026-07-15T10:30:20.000Z', 'msg_synthetic_3', [{ type: 'text', text: 'done' }]),
  ].join('\n'));
  const imported = await parseSessionFile(file, '-synthetic-imported');
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(imported.length, 3);
  // Precondition of #688: the importer writes ids, not counts.
  for (const e of imported) {
    assert.equal(e.turnToolCalls, undefined);
    assert.equal(e.toolCalls, undefined);
    assert.equal(typeof e.turnToolCallIds, 'object');
  }
  lines = [
    ...imported.map(e => JSON.parse(buildIndexLine(e))),
    proxyEntry({}),
    proxyEntry({ id: '2026-07-15T11-01-00-000', receivedAt: Date.parse('2026-07-15T11:01:00.000Z'), cost: { cost: 3, confidence: 'exact' } }),
    proxyEntry({ id: '2026-07-15T11-02-00-000', receivedAt: Date.parse('2026-07-15T11:02:00.000Z'), model: UNPRICED, cost: { cost: null, confidence: 'unknown' } }),
  ];
  fs.writeFileSync(INDEX_PATH, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
});

after(() => { fs.rmSync(HOME, { recursive: true, force: true }); });

const isolatedEnv = () => ({ ...process.env, HOME, USERPROFILE: HOME, CCXRAY_HOME: HOME,
  LOGS_DIR: path.join(HOME, 'logs'), CLAUDE_CONFIG_DIR: path.join(HOME, '.claude'),
  CODEX_HOME: path.join(HOME, '.codex') });
const cli = (...args) => execFileSync(process.execPath, ['server/index.js', 'usage', ...args],
  { env: isolatedEnv(), timeout: 10000 }).toString();
const plain = s => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('#688 usage: unpriced models', () => {
  it('--json reports the unpriced model as unknown and keeps it out of shares', () => {
    const r = JSON.parse(cli('--json'));
    const unpriced = r.models.find(m => m.model === UNPRICED);
    assert.equal(unpriced.cost, null);
    assert.equal(unpriced.costShare, null);
    assert.equal(unpriced.costStatus, 'unknown');
    assert.equal(unpriced.costAgg.unknownCount, 1);
    const priced = r.models.filter(m => m.model !== UNPRICED);
    for (const m of priced) assert.equal(m.costStatus, 'priced');
    // Shares are over the priced total only, so the priced rows sum to 1.
    const shareSum = priced.reduce((s, m) => s + m.costShare, 0);
    assert.ok(Math.abs(shareSum - 1) < 0.002, `priced shares sum to ${shareSum}`);
    assert.equal(r.meta.costAgg.unknownCount, 1);
    assert.deepEqual(r.meta.unpricedModels, [UNPRICED]);
  });

  it('text output prints unknown for the row and marks the total as a lower bound', () => {
    const out = plain(cli());
    assert.match(out, new RegExp(`${UNPRICED}: 1 turns · unknown\\n`));
    assert.doesNotMatch(out, new RegExp(`${UNPRICED}: .*\\$0`));
    const header = out.split('\n').find(l => l.startsWith('ccxray usage'));
    assert.match(header, /\$\d+\.\d\d\+ \(1 model unpriced\)/);
  });
});

describe('#688 usage: imported session tool counts', () => {
  it('--json derives tool counts from turnToolCallIds', () => {
    const r = JSON.parse(cli('--json', '--session', IMPORTED_SID));
    assert.equal(r.tools.totalCalls, 3);
    assert.deepEqual(r.tools.top, [{ name: 'Read', count: 2 }, { name: 'Bash', count: 1 }]);
  });

  it('text output shows non-zero tool counts', () => {
    const out = plain(cli('--session', IMPORTED_SID));
    assert.match(out, /Tools {2}3 calls/);
    assert.match(out, /\n {2}Read: 2\n/);
  });

  it('ADR 0018: null ids are unknown, {} ids are zero, recorded counts win', () => {
    const base = { sessionId: 's', model: 'm', cost: { cost: 1 } };
    assert.equal(analyze([{ ...base, turnToolCallIds: null }]).tools.totalCalls, 0);
    // A {} turn is a parsed zero-call response: it adds nothing itself and must
    // not displace the session's legacy per-tool-max fold of another row.
    assert.equal(analyze([{ ...base, turnToolCallIds: {} }, { ...base, toolCalls: { Bash: 5 } }]).tools.totalCalls, 5);
    // Proxy rows carry both counts and ids; the recorded counts are used.
    assert.equal(analyze([{ ...base, turnToolCalls: { Read: 1 }, turnToolCallIds: { a: 'Read', b: 'Bash' } }]).tools.totalCalls, 1);
    assert.equal(analyze([{ ...base, toolCalls: { Read: 1 }, turnToolCallIds: { a: 'Read', b: 'Bash' } }]).tools.totalCalls, 1);
  });
});
