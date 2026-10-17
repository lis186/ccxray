'use strict';

const { it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadNotebook, parseNotebook } = require('../server/agentflow/notebook');
const { buildWindows, disclose } = require('../server/agentflow/windows');
const { attributeHosts } = require('../server/agentflow/host');
const input = require('./fixtures/agentflow/v8.4.15/manual-input.json');
const fixture = path.join(__dirname, 'fixtures/agentflow/v8.4.15');
const at = minute => Date.UTC(2026, 5, 1, 10, minute);

it('Claude host uses manual append-input; omitted capture degrades to window', () => {
  const root = '/work/repo';
  const submissions = [
    { key: 'u1', sessionId: 'S1', sessionIds: ['S1'], at: at(1), text: input.startupText },
    { key: 'u2', sessionId: 'S2', sessionIds: ['S2'], at: at(2), text: input.ownerText },
  ];
  const transcripts = new Map(submissions.map(s => [s.sessionId, {
    submissions: [s], tools: [{ id: 'capture', input: input.command }],
  }]));
  for (const captured of [true, false]) {
    const text = `# → Ask / A-001\n\n+ ${input.startupText}\n\n${captured ? '+ ' + input.ownerText + '\n\n' : ''}# ← Reply / A-001\n\n* _${input.stamp} (claude/unknown)_\n\nDone.\n`;
    const built = buildWindows(parseNotebook(text), submissions, { now: at(30) });
    const nb = { abs: root + '/.agentflow/devlog.md', rel: '.agentflow/devlog.md', isDefault: true,
      workspaceAbs: root + '/.agentflow', workspaceRel: '.agentflow', windows: built.windows };
    const turns = submissions.map(s => ({ id: s.key, sessionId: s.sessionId, cwd: root, receivedAt: s.at + 1000 }));
    const result = attributeHosts({ turns, checkoutRoot: root, notebooks: [nb], transcripts });
    assert.deepEqual(result.rows.map(r => [r.session, r.evidence]), captured ? input.expectedCaptured : input.expectedOmitted);
    assert.deepEqual(result.rows.flatMap(r => r.turns.map(t => t.id)), ['u1', 'u2']);
    assert.equal(disclose(built.windows[0], 'S2', built).unmatched, captured ? 0 : 1);
  }
});

it('compaction keeps latest completed Ask live and loads older archive rounds once', () => {
  const asks = loadNotebook(path.join(fixture, 'devlog.md'), path.join(fixture, 'devlog.archive.md'));
  assert.deepEqual(asks.map(a => [a.id, a.hasReply, a.bullets]), [
    ['A-001', true, ['initial task']], ['A-002', true, ['latest completed task']], ['A-003', false, []],
  ]);
  const live = loadNotebook(path.join(fixture, 'devlog.md'));
  assert.deepEqual(live.map(a => a.id), ['A-002', 'A-003']);
  const subs = asks.slice(0, 2).map((a, i) => ({ key: a.id, sessionIds: ['S1'], at: at(i * 10 + 1), text: a.bullets[0] }));
  const { windows } = buildWindows(asks, subs, { now: at(30) });
  assert.deepEqual(windows.map(w => [w.id, w.startKind]), [['A-001', 'matched'], ['A-002', 'matched'], ['A-003', null]]);
  assert.equal(windows[1].start, at(11));
});
