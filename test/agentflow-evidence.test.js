'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readClaudeTranscript, readCodexTranscript, collectSubmissions } = require('../server/agentflow/evidence');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-agentflow-ev-'));
process.on('exit', () => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {} });
let n = 0;
function write(rows) {
  const f = path.join(DIR, `t${n++}.jsonl`);
  fs.writeFileSync(f, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  return f;
}
const ts = s => new Date(Date.UTC(2026, 5, 1, 10, 0, s)).toISOString();
const user = (uuid, s, content, extra = {}) => ({ type: 'user', uuid, sessionId: 'S1', timestamp: ts(s), message: { role: 'user', content }, ...extra });

describe('readClaudeTranscript: owner submissions', () => {
  const t = readClaudeTranscript(write([
    user('u1', 1, 'plain prompt'),
    user('u2', 2, [{ type: 'image', source: {} }, { type: 'text', text: 'with an image' }]),
    user('u3', 3, 'meta', { isMeta: true }),
    user('u4', 4, [{ type: 'tool_result', tool_use_id: 'x', content: 'r' }]),
    user('u5', 5, '<command-name>/clear</command-name>'),
    user('u6', 6, '<local-command-stdout>ok</local-command-stdout>'),
    user('u7', 7, '<task-notification>done</task-notification>'),
    user('u8', 8, '<system-reminder>only a reminder</system-reminder>'),
    user('u9', 9, [{ type: 'text', text: 'Base directory for this skill: /x' }]),
    user('u10', 10, '<system-reminder>ctx</system-reminder>\nreal text after a reminder'),
    user('u1', 1, 'plain prompt'),
  ]));

  it('keeps owner text only and deduplicates events by uuid', () => {
    assert.deepEqual(t.submissions.map(s => [s.key, s.text]), [['u1', 'plain prompt'], ['u2', 'with an image'], ['u10', 'real text after a reminder']]);
    assert.equal(t.sessionId, 'S1');
    assert.equal(t.submissions[0].at, Date.UTC(2026, 5, 1, 10, 0, 1));
  });
});

describe('readClaudeTranscript: tool events (F20)', () => {
  it('counts one message once but keeps every distinct tool block written across its lines', () => {
    const msg = id => ({ id: 'msg_1', role: 'assistant', content: id });
    const t = readClaudeTranscript(write([
      { type: 'assistant', uuid: 'a1', sessionId: 'S1', timestamp: ts(1), message: msg([{ type: 'thinking', thinking: '' }]) },
      { type: 'assistant', uuid: 'a2', sessionId: 'S1', timestamp: ts(1), message: msg([{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }]) },
      { type: 'assistant', uuid: 'a3', sessionId: 'S1', timestamp: ts(1), message: msg([{ type: 'tool_use', id: 'tu2', name: 'Read', input: { file_path: '/x' } }]) },
      { type: 'assistant', uuid: 'a3', sessionId: 'S1', timestamp: ts(1), message: msg([{ type: 'tool_use', id: 'tu2', name: 'Read', input: { file_path: '/x' } }]) },
      user('r1', 2, [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'out' }] }]),
    ]));
    assert.deepEqual(t.tools.map(x => [x.id, x.name, x.result ?? null]), [['tu1', 'Bash', 'out'], ['tu2', 'Read', null]]);
    assert.equal(t.tools[0].input, '{"command":"ls"}');
  });
});

describe('readCodexTranscript', () => {
  const meta = (source) => ({ type: 'session_meta', timestamp: ts(0), payload: { id: 'C1', cwd: '/w', thread_source: source } });
  const item = (s, payload) => ({ type: 'response_item', timestamp: ts(s), payload });
  const rows = [
    item(1, { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] }),
    item(2, { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for /w' }] }),
    item(3, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'owner prompt' }] }),
    item(4, { type: 'function_call', call_id: 'c1', name: 'exec_command', arguments: '{"cmd":"ls"}' }),
    item(5, { type: 'function_call_output', call_id: 'c1', output: 'listing' }),
    item(6, { type: 'custom_tool_call', call_id: 'c2', name: 'apply_patch', input: 'patch' }),
    item(7, { type: 'custom_tool_call_output', call_id: 'c2', output: [{ type: 'input_text', text: 'applied' }] }),
  ];

  it('keeps owner messages and pairs function and custom tool calls by call id', () => {
    const t = readCodexTranscript(write([meta('user'), ...rows]));
    assert.deepEqual(t.submissions.map(s => s.text), ['owner prompt']);
    assert.equal(t.sessionId, 'C1');
    assert.deepEqual(t.tools.map(x => [x.id, x.input, x.result]), [['c1', '{"cmd":"ls"}', 'listing'], ['c2', 'patch', 'applied']]);
  });

  it('takes no owner input from a background thread', () => {
    const t = readCodexTranscript(write([meta('memory_consolidation'), ...rows]));
    assert.equal(t.background, true);
    assert.deepEqual(t.submissions, []);
  });
});

describe('collectSubmissions', () => {
  it('merges an identical uuid across files and remembers both sessions (F3a), but not equal text', () => {
    const a = { submissions: [{ key: 'u1', sessionId: 'S1', at: 1, text: 'x' }] };
    const b = { submissions: [{ key: 'u1', sessionId: 'S2', at: 1, text: 'x' }, { key: 'u9', sessionId: 'S2', at: 2, text: 'x' }] };
    assert.deepEqual(collectSubmissions([a, b]).map(s => [s.key, s.sessionIds]), [['u1', ['S1', 'S2']], ['u9', ['S2']]]);
  });
});
