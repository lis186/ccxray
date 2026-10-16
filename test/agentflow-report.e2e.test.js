'use strict';

// End to end through `ccxray agentflow report`: a throwaway git checkout with a
// notebook, a synthetic index (proxy + imported twins, a proxy-only prompt
// suggestion with cwd null) and a synthetic Claude transcript. Nothing real is
// read: CCXRAY_HOME and the transcript roots point into a temp dir.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-agentflow-e2e-')));
process.on('exit', () => { try { fs.rmSync(BASE, { recursive: true, force: true }); } catch {} });

const REPO = path.join(BASE, 'repo');
const HOME = path.join(BASE, 'ccxray-home');
const CLAUDE = path.join(BASE, 'claude', 'projects');
const CODEX = path.join(BASE, 'codex', 'sessions');
const SID = '11111111-2222-3333-4444-555555555555';
const PROMPT = 'please build the frobnicator';
const t = s => Date.UTC(2026, 5, 1, 10, 0, s);
const iso = s => new Date(t(s)).toISOString();

fs.mkdirSync(path.join(REPO, '.agentflow'), { recursive: true });
execFileSync('git', ['init', '-q', REPO]);
fs.writeFileSync(path.join(REPO, 'ag.json'), JSON.stringify({ switches: { 'target-doc': '.agentflow/devlog.md', 'workspace-dir': '.agentflow' } }));
fs.writeFileSync(path.join(REPO, '.agentflow', 'devlog.md'), [
  '# → Ask / A-001', '', `+ ${PROMPT}`, '',
  '# ← Reply / A-001', '', '* _2026-06-01 10:10:00 +0000 (claude/unknown)_', '', 'done', '',
  '# → Ask / A-002', '', '+', '',
].join('\n'));

const usage = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 70, cache_creation_input_tokens: 0 };
const row = (id, s, extra) => ({ id, sessionId: SID, provider: 'anthropic', model: 'claude-test', receivedAt: t(s), usage, cost: { cost: 0.5, confidence: 'exact' }, ...extra });
fs.mkdirSync(path.join(HOME, 'logs'), { recursive: true });
fs.writeFileSync(path.join(HOME, 'logs', 'index.ndjson'), [
  row('i1', 61, { cwd: REPO, responseId: 'msg_1', imported: true, effort: 'high' }),
  row('p1', 60, { cwd: null, responseId: 'msg_1' }),
  row('i2', 181, { cwd: REPO, responseId: 'msg_2', imported: true, effort: 'high' }),
  row('p2', 180, { cwd: null, responseId: 'msg_2' }),
  row('p3', 200, { cwd: null, responseId: 'msg_suggestion', cost: { cost: 0.25, confidence: 'exact' } }),
].map(r => JSON.stringify(r)).join('\n') + '\n');

const proj = path.join(CLAUDE, REPO.replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(proj, { recursive: true });
fs.mkdirSync(CODEX, { recursive: true });
fs.writeFileSync(path.join(proj, `${SID}.jsonl`), [
  { type: 'user', uuid: 'u1', sessionId: SID, cwd: REPO, timestamp: iso(55), message: { role: 'user', content: PROMPT } },
  { type: 'assistant', uuid: 'a1', sessionId: SID, cwd: REPO, timestamp: iso(61), message: { id: 'msg_1', role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'agf status' } }] } },
  { type: 'user', uuid: 'r1', sessionId: SID, cwd: REPO, timestamp: iso(62), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] } },
  { type: 'assistant', uuid: 'a2', sessionId: SID, cwd: REPO, timestamp: iso(181), message: { id: 'msg_2', role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
].map(r => JSON.stringify(r)).join('\n') + '\n');

// A Codex host in its own checkout: the owner's prompt follows an attached
// image, and the transcript holds three usage turns of which one is imported.
// `tokens` is used again below by its subagent thread.
const REPO2 = path.join(BASE, 'repo2');
const SID2 = '66666666-7777-8888-9999-aaaaaaaaaaaa';
const PROMPT2 = 'describe the attached mockup';
fs.mkdirSync(path.join(REPO2, '.agentflow'), { recursive: true });
execFileSync('git', ['init', '-q', REPO2]);
fs.writeFileSync(path.join(REPO2, '.agentflow', 'devlog.md'), [
  '# → Ask / A-001', '', `+ ${PROMPT2}`, '',
  '# ← Reply / A-001', '', '* _2026-06-01 10:10:00 +0000 (gpt/high)_', '', 'done', '',
].join('\n'));
fs.appendFileSync(path.join(HOME, 'logs', 'index.ndjson'), JSON.stringify({
  id: 'c1', sessionId: SID2, provider: 'openai', model: 'gpt-test', receivedAt: t(70), cwd: REPO2, imported: true, importSource: 'codex',
  usage, cost: { cost: 0.5, confidence: 'exact' },
}) + '\n');
const codexDay = path.join(CODEX, '2026', '06', '01');
fs.mkdirSync(codexDay, { recursive: true });
const tokens = s => ({ timestamp: iso(s), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 70, output_tokens: 20 } } } });
fs.writeFileSync(path.join(codexDay, `rollout-2026-06-01T10-00-00-${SID2}.jsonl`), [
  { timestamp: iso(50), type: 'session_meta', payload: { id: SID2, cwd: REPO2, thread_source: 'user' } },
  { timestamp: iso(55), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `<image name="m.png"></image>\n${PROMPT2}` }] } },
  { timestamp: iso(60), type: 'response_item', payload: { type: 'function_call', call_id: 'c1', name: 'exec_command', arguments: '{"cmd":"agf status"}' } },
  tokens(70), tokens(80), tokens(90),
].map(r => JSON.stringify(r)).join('\n') + '\n');

// A subagent thread of that host launches the runner synchronously; the worker
// turns run in the clone. Lineage files the launch under the host.
const CLONE = path.join(BASE, 'T', 'agentflow-external-runner-ABCD', 'clone');
const CHILD = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
fs.writeFileSync(path.join(codexDay, `rollout-2026-06-01T10-01-20-${CHILD}.jsonl`), [
  { timestamp: iso(80), type: 'session_meta', payload: { id: CHILD, session_id: SID2, parent_thread_id: SID2, cwd: REPO2, thread_source: 'subagent' } },
  { timestamp: iso(90), type: 'response_item', payload: { type: 'function_call', call_id: 'k1', name: 'exec_command', arguments: '{"cmd":"node external-runner.js"}' } },
  { timestamp: iso(120), type: 'response_item', payload: { type: 'function_call_output', call_id: 'k1', output: JSON.stringify({ working_directory: CLONE, clone: { root: CLONE } }) } },
  tokens(125),
].map(r => JSON.stringify(r)).join('\n') + '\n');
fs.appendFileSync(path.join(HOME, 'logs', 'index.ndjson'), JSON.stringify({
  id: 'w1', sessionId: 'worker-1', provider: 'anthropic', model: 'claude-test', receivedAt: t(100), cwd: CLONE, responseId: 'msg_w1',
  usage, cost: { cost: 0.5, confidence: 'exact' },
}) + '\n');

// A Claude host whose transcript was never imported: the proxy logged its first
// turn only, so the second turn is in no index line and had no proxy twin.
const REPO3 = path.join(BASE, 'repo3');
const SID3 = '33333333-4444-5555-6666-777777777777';
const PROMPT3 = 'tidy the parser';
fs.mkdirSync(path.join(REPO3, '.agentflow'), { recursive: true });
execFileSync('git', ['init', '-q', REPO3]);
fs.writeFileSync(path.join(REPO3, '.agentflow', 'devlog.md'), [
  '# → Ask / A-001', '', `+ ${PROMPT3}`, '',
  '# ← Reply / A-001', '', '* _2026-06-01 10:10:00 +0000 (claude/unknown)_', '', 'done', '',
  '# → Ask / A-002', '', '+', '',
].join('\n'));
fs.appendFileSync(path.join(HOME, 'logs', 'index.ndjson'), JSON.stringify(row('q1', 60, { sessionId: SID3, cwd: REPO3, responseId: 'msg_q1' })) + '\n');
const proj3 = path.join(CLAUDE, REPO3.replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(proj3, { recursive: true });
fs.writeFileSync(path.join(proj3, `${SID3}.jsonl`), [
  { type: 'user', uuid: 'v1', sessionId: SID3, cwd: REPO3, timestamp: iso(55), message: { role: 'user', content: PROMPT3 } },
  { type: 'assistant', uuid: 'b1', sessionId: SID3, cwd: REPO3, timestamp: iso(61), message: { id: 'msg_q1', role: 'assistant', content: [{ type: 'text', text: 'one' }] } },
  { type: 'assistant', uuid: 'b2', sessionId: SID3, cwd: REPO3, timestamp: iso(121), message: { id: 'msg_q2', role: 'assistant', content: [{ type: 'text', text: 'two' }] } },
].map(r => JSON.stringify(r)).join('\n') + '\n');

// Two Codex hosts in one Ask: one read from the proxy (its imported copy is
// dropped by the one-source rule), one from import, which has notebook evidence.
const REPO4 = path.join(BASE, 'repo4');
const SID4P = '44444444-0000-0000-0000-00000000000a';
const SID4I = '44444444-0000-0000-0000-00000000000b';
const PROMPT4 = 'port the importer';
fs.mkdirSync(path.join(REPO4, '.agentflow'), { recursive: true });
execFileSync('git', ['init', '-q', REPO4]);
fs.writeFileSync(path.join(REPO4, '.agentflow', 'devlog.md'), [
  '# → Ask / A-001', '', `+ ${PROMPT4}`, '',
  '# ← Reply / A-001', '', '* _2026-06-01 10:10:00 +0000 (gpt/high)_', '', 'done', '',
].join('\n'));
const codexRow = (id, sid, s, extra) => ({ id, sessionId: sid, provider: 'openai', model: 'gpt-test', receivedAt: t(s), cwd: REPO4, usage, cost: { cost: 0.5, confidence: 'exact' }, ...extra });
fs.appendFileSync(path.join(HOME, 'logs', 'index.ndjson'), [
  codexRow('x1', SID4P, 70), codexRow('x2', SID4P, 80), codexRow('x3', SID4P, 90),
  codexRow('x1i', SID4P, 70, { imported: true, importSource: 'codex' }),
  codexRow('y1', SID4I, 100, { imported: true, importSource: 'codex' }),
].map(r => JSON.stringify(r)).join('\n') + '\n');
fs.writeFileSync(path.join(codexDay, `rollout-2026-06-01T10-00-01-${SID4P}.jsonl`), [
  { timestamp: iso(50), type: 'session_meta', payload: { id: SID4P, cwd: REPO4, thread_source: 'user' } },
  { timestamp: iso(55), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: PROMPT4 }] } },
  tokens(70), tokens(80), tokens(90),
].map(r => JSON.stringify(r)).join('\n') + '\n');
fs.writeFileSync(path.join(codexDay, `rollout-2026-06-01T10-00-02-${SID4I}.jsonl`), [
  { timestamp: iso(52), type: 'session_meta', payload: { id: SID4I, cwd: REPO4, thread_source: 'user' } },
  { timestamp: iso(58), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'review what the other session does' }] } },
  { timestamp: iso(95), type: 'response_item', payload: { type: 'function_call', call_id: 'g1', name: 'exec_command', arguments: '{"cmd":"agf status"}' } },
  tokens(100),
].map(r => JSON.stringify(r)).join('\n') + '\n');

// F24 end to end: A-002 ran on another machine, and a local host turn falls
// inside its bounds after A-001's tail.
const REPO5 = path.join(BASE, 'repo5');
const SID5 = '55555555-0000-0000-0000-000000000000';
const PROMPT5 = 'start the migration';
fs.mkdirSync(path.join(REPO5, '.agentflow'), { recursive: true });
execFileSync('git', ['init', '-q', REPO5]);
fs.writeFileSync(path.join(REPO5, '.agentflow', 'devlog.md'), [
  '# → Ask / A-001', '', `+ ${PROMPT5}`, '',
  '# ← Reply / A-001', '', '* _2026-06-01 10:10:00 +0000 (claude/unknown)_', '', 'done', '',
  '# → Ask / A-002', '', '+ finish it on the laptop', '',
  '# ← Reply / A-002', '', '* _2026-06-01 10:20:00 +0000 (claude/unknown)_', '', 'done', '',
].join('\n'));
fs.appendFileSync(path.join(HOME, 'logs', 'index.ndjson'), [
  row('z1', 61, { sessionId: SID5, cwd: REPO5, responseId: 'msg_z1', imported: true }),
  row('z2', 900, { sessionId: SID5, cwd: REPO5, responseId: 'msg_z2', imported: true }),
].map(r => JSON.stringify(r)).join('\n') + '\n');
const proj5 = path.join(CLAUDE, REPO5.replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(proj5, { recursive: true });
fs.writeFileSync(path.join(proj5, `${SID5}.jsonl`), [
  { type: 'user', uuid: 'v1', sessionId: SID5, cwd: REPO5, timestamp: iso(55), message: { role: 'user', content: PROMPT5 } },
  { type: 'assistant', uuid: 'c1', sessionId: SID5, cwd: REPO5, timestamp: iso(61), message: { id: 'msg_z1', role: 'assistant', content: [{ type: 'text', text: 'one' }] } },
  { type: 'assistant', uuid: 'c2', sessionId: SID5, cwd: REPO5, timestamp: iso(900), message: { id: 'msg_z2', role: 'assistant', content: [{ type: 'text', text: 'two' }] } },
].map(r => JSON.stringify(r)).join('\n') + '\n');

// Two notebooks directly in one workspace, both with A-002 open: a dispatch
// record fixes A-002 but no notebook (the notebooks share the workspace), and a
// strong chain launched inside both A-002 windows names both notebooks. The run
// is ambiguous between them and must be shown under A-002 by each.
const REPO6 = path.join(BASE, 'repo6');
const SID6 = '66660000-0000-0000-0000-000000000006';
const CLONE6 = path.join(BASE, 'T', 'agentflow-external-runner-SIX', 'clone');
fs.mkdirSync(path.join(REPO6, '.agentflow', 'artifacts', 'A-002-x', 'dispatch'), { recursive: true });
execFileSync('git', ['init', '-q', REPO6]);
const nb6 = p => ['# → Ask / A-001', '', `+ ${p} one`, '', '# ← Reply / A-001', '', '* _2026-06-01 10:05:00 +0000 (claude/unknown)_', '', 'done', '', '# → Ask / A-002', '', `+ ${p} two`, ''].join('\n');
fs.writeFileSync(path.join(REPO6, '.agentflow', 'devlog.md'), nb6('north'));
fs.writeFileSync(path.join(REPO6, '.agentflow', 'notes.devlog.md'), nb6('mill'));
fs.writeFileSync(path.join(REPO6, '.agentflow', 'artifacts', 'A-002-x', 'dispatch', 'review-dispatch.json'), JSON.stringify({ stage: 'review', started: iso(490), finished: iso(530), clone: CLONE6 }));
fs.appendFileSync(path.join(HOME, 'logs', 'index.ndjson'), [
  row('s6a', 70, { sessionId: SID6, cwd: REPO6, responseId: 'msg_s6a', imported: true }),
  row('s6b', 500, { sessionId: SID6, cwd: REPO6, responseId: 'msg_s6b', imported: true }),
  row('w6', 510, { sessionId: 'worker-6', cwd: CLONE6, responseId: 'msg_w6' }),
].map(r => JSON.stringify(r)).join('\n') + '\n');
const proj6 = path.join(CLAUDE, 'repo6');
fs.mkdirSync(proj6, { recursive: true });
const u6 = (uuid, s, content) => ({ type: 'user', uuid, sessionId: SID6, cwd: REPO6, timestamp: iso(s), message: { role: 'user', content } });
fs.writeFileSync(path.join(proj6, `${SID6}.jsonl`), [
  u6('n1', 60, 'north one'), u6('m1', 61, 'mill one'), u6('n2', 400, 'north two'), u6('m2', 401, 'mill two'),
  { type: 'assistant', uuid: 'b6', sessionId: SID6, cwd: REPO6, timestamp: iso(500), message: { id: 'msg_s6b', role: 'assistant', content: [{ type: 'tool_use', id: 'k6', name: 'Bash', input: { command: 'node external-runner.js' } }] } },
  u6('r6', 520, [{ type: 'tool_result', tool_use_id: 'k6', content: JSON.stringify({ working_directory: CLONE6, stdin_closed: true, clone: { root: CLONE6 } }) }]),
].map(r => JSON.stringify(r)).join('\n') + '\n');

// A notebook whose only Ask is open, worked on for two days: its matched
// submission and first turn are two days old, older than a day before any stamp
// (there is none).
const REPO7 = path.join(BASE, 'repo7');
const SID7 = '77770000-0000-0000-0000-000000000007';
const ago = h => new Date(Date.now() - h * 3600e3).toISOString();
fs.mkdirSync(path.join(REPO7, '.agentflow'), { recursive: true });
execFileSync('git', ['init', '-q', REPO7]);
fs.writeFileSync(path.join(REPO7, '.agentflow', 'devlog.md'), ['# → Ask / A-001', '', '+ keep going on the long task', ''].join('\n'));
const row7 = (id, h) => ({ id, sessionId: SID7, provider: 'anthropic', model: 'claude-test', receivedAt: Date.parse(ago(h)), cwd: REPO7, responseId: `msg_${id}`, imported: true, usage, cost: { cost: 0.5, confidence: 'exact' } });
fs.appendFileSync(path.join(HOME, 'logs', 'index.ndjson'), [row7('l1', 47.9), row7('l2', 1)].map(r => JSON.stringify(r)).join('\n') + '\n');
const proj7 = path.join(CLAUDE, REPO7.replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(proj7, { recursive: true });
fs.writeFileSync(path.join(proj7, `${SID7}.jsonl`), [
  { type: 'user', uuid: 'l0', sessionId: SID7, cwd: REPO7, timestamp: ago(48), message: { role: 'user', content: 'keep going on the long task' } },
  { type: 'assistant', uuid: 'la1', sessionId: SID7, cwd: REPO7, timestamp: ago(47.9), message: { id: 'msg_l1', role: 'assistant', content: [{ type: 'text', text: 'one' }] } },
  { type: 'assistant', uuid: 'la2', sessionId: SID7, cwd: REPO7, timestamp: ago(1), message: { id: 'msg_l2', role: 'assistant', content: [{ type: 'text', text: 'two' }] } },
].map(r => JSON.stringify(r)).join('\n') + '\n');

// The runner's default clone sits under os.tmpdir(), on macOS /var/folders/...,
// a symlink, while a worker records its cwd resolved (/private/var/...). Here a
// dispatch record (A-001) and a runner result (A-002) name their clones through
// a symlinked directory, the index names them resolved, and both clones are
// gone, as the runner leaves them.
const REPO8 = path.join(BASE, 'repo8');
const SID8 = '88880000-0000-0000-0000-000000000008';
fs.mkdirSync(path.join(BASE, 'T8'));
fs.symlinkSync(path.join(BASE, 'T8'), path.join(BASE, 'T8link'));
const viaLink = k => path.join(BASE, 'T8link', `agentflow-external-runner-${k}`, 'clone');
const resolved = k => path.join(BASE, 'T8', `agentflow-external-runner-${k}`, 'clone');
fs.mkdirSync(path.join(REPO8, '.agentflow', 'artifacts', 'A-001-x', 'dispatch'), { recursive: true });
execFileSync('git', ['init', '-q', REPO8]);
fs.writeFileSync(path.join(REPO8, '.agentflow', 'devlog.md'), [
  '# → Ask / A-001', '', '+ eight one', '', '# ← Reply / A-001', '', '* _2026-06-01 10:05:00 +0000 (claude/unknown)_', '', 'done', '',
  '# → Ask / A-002', '', '+ eight two', '', '# ← Reply / A-002', '', '* _2026-06-01 10:10:00 +0000 (claude/unknown)_', '', 'done', '',
].join('\n'));
fs.writeFileSync(path.join(REPO8, '.agentflow', 'artifacts', 'A-001-x', 'dispatch', 'implement-dispatch.json'), JSON.stringify({ stage: 'implement', started: iso(90), finished: iso(150), clone: viaLink('EIGHT') }));
fs.appendFileSync(path.join(HOME, 'logs', 'index.ndjson'), [
  row('h8a', 20, { sessionId: SID8, cwd: REPO8, responseId: 'msg_h8a', imported: true }),
  row('h8b', 410, { sessionId: SID8, cwd: REPO8, responseId: 'msg_h8b', imported: true }),
  row('w8a', 100, { sessionId: 'worker-8a', cwd: resolved('EIGHT'), responseId: 'msg_w8a' }),
  row('w8b', 430, { sessionId: 'worker-8b', cwd: resolved('NINE'), responseId: 'msg_w8b' }),
].map(r => JSON.stringify(r)).join('\n') + '\n');
const proj8 = path.join(CLAUDE, 'repo8');
fs.mkdirSync(proj8, { recursive: true });
const u8 = (uuid, s, content) => ({ type: 'user', uuid, sessionId: SID8, cwd: REPO8, timestamp: iso(s), message: { role: 'user', content } });
fs.writeFileSync(path.join(proj8, `${SID8}.jsonl`), [
  u8('e1', 10, 'eight one'),
  { type: 'assistant', uuid: 'e1a', sessionId: SID8, cwd: REPO8, timestamp: iso(20), message: { id: 'msg_h8a', role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
  u8('e2', 400, 'eight two'),
  { type: 'assistant', uuid: 'e2a', sessionId: SID8, cwd: REPO8, timestamp: iso(410), message: { id: 'msg_h8b', role: 'assistant', content: [{ type: 'tool_use', id: 'k8', name: 'Bash', input: { command: 'node external-runner.js' } }] } },
  u8('e2r', 450, [{ type: 'tool_result', tool_use_id: 'k8', content: JSON.stringify({ working_directory: viaLink('NINE'), stdin_closed: true, clone: { root: viaLink('NINE') } }) }]),
].map(r => JSON.stringify(r)).join('\n') + '\n');

// Two hosts in one Ask: H1 went through the proxy and was imported; H2 has a
// transcript turn but no index line at all, so the proxy never saw it.
const REPO9 = path.join(BASE, 'repo9');
const SID9A = '99990000-0000-0000-0000-00000000000a';
const SID9B = '99990000-0000-0000-0000-00000000000b';
fs.mkdirSync(path.join(REPO9, '.agentflow'), { recursive: true });
execFileSync('git', ['init', '-q', REPO9]);
fs.writeFileSync(path.join(REPO9, '.agentflow', 'devlog.md'), [
  '# → Ask / A-001', '', '+ nine one', '', '+ nine two', '', '# ← Reply / A-001', '', '* _2026-06-01 10:10:00 +0000 (claude/unknown)_', '', 'done', '',
].join('\n'));
fs.appendFileSync(path.join(HOME, 'logs', 'index.ndjson'), [
  row('n1p', 20, { sessionId: SID9A, cwd: REPO9, responseId: 'msg_n1' }),
  row('n1i', 20, { sessionId: SID9A, cwd: REPO9, responseId: 'msg_n1', imported: true }),
].map(r => JSON.stringify(r)).join('\n') + '\n');
const proj9 = path.join(CLAUDE, REPO9.replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(proj9, { recursive: true });
const said9 = (sid, uuid, s, text, id) => [
  { type: 'user', uuid, sessionId: sid, cwd: REPO9, timestamp: iso(s), message: { role: 'user', content: text } },
  { type: 'assistant', uuid: `${uuid}a`, sessionId: sid, cwd: REPO9, timestamp: iso(s + 10), message: { id, role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
].map(r => JSON.stringify(r)).join('\n') + '\n';
fs.writeFileSync(path.join(proj9, `${SID9A}.jsonl`), said9(SID9A, 'g1', 10, 'nine one', 'msg_n1'));
fs.writeFileSync(path.join(proj9, `${SID9B}.jsonl`), said9(SID9B, 'g2', 30, 'nine two', 'msg_n2'));

// The checkout's default notebook (ag.json target-doc) has a name the
// `*.devlog.md` scan does not find; reporting the root devlog, a host matched to
// both must still be ambiguous between them.
const REPO10 = path.join(BASE, 'repo10');
const SID10 = '10100000-0000-0000-0000-000000000010';
fs.mkdirSync(path.join(REPO10, '.agentflow'), { recursive: true });
execFileSync('git', ['init', '-q', REPO10]);
fs.writeFileSync(path.join(REPO10, 'ag.json'), JSON.stringify({ switches: { 'target-doc': '.agentflow/plan.md' } }));
const nb10 = p => ['# → Ask / A-001', '', `+ ${p} one`, '', '# ← Reply / A-001', '', '* _2026-06-01 10:05:00 +0000 (claude/unknown)_', '', 'done', ''].join('\n');
fs.writeFileSync(path.join(REPO10, '.agentflow', 'devlog.md'), nb10('north'));
fs.writeFileSync(path.join(REPO10, '.agentflow', 'plan.md'), nb10('mill'));
fs.appendFileSync(path.join(HOME, 'logs', 'index.ndjson'), JSON.stringify(row('t10', 70, { sessionId: SID10, cwd: REPO10, responseId: 'msg_t10', imported: true })) + '\n');
const proj10 = path.join(CLAUDE, REPO10.replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(proj10, { recursive: true });
const u10 = (uuid, s, content) => ({ type: 'user', uuid, sessionId: SID10, cwd: REPO10, timestamp: iso(s), message: { role: 'user', content } });
fs.writeFileSync(path.join(proj10, `${SID10}.jsonl`), [
  u10('x1', 60, 'north one'), u10('x2', 61, 'mill one'),
  { type: 'assistant', uuid: 'x3', sessionId: SID10, cwd: REPO10, timestamp: iso(70), message: { id: 'msg_t10', role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
].map(r => JSON.stringify(r)).join('\n') + '\n');

function report(...args) { return reportIn(REPO, ...args); }
function reportIn(cwd, ...args) {
  const env = { ...process.env, CCXRAY_HOME: HOME, CCXRAY_IMPORT_HOMES: CLAUDE, CCXRAY_IMPORT_CODEX_HOMES: CODEX };
  delete env.LOGS_DIR;
  return spawnSync(process.execPath, [path.join(__dirname, '../server/index.js'), 'agentflow', 'report', ...args],
    { cwd, env, encoding: 'utf8', timeout: 20000 });
}

describe('ccxray agentflow report (e2e)', () => {
  it('reports effective proxy retention without guessing transcript retention', () => {
    const file = path.join(HOME, 'export-enrollment.json');
    const old = process.env.LOG_RETENTION_DAYS;
    try {
      process.env.LOG_RETENTION_DAYS = '7';
      assert.match(report().stdout, /proxy logs are pruned \(configured retention: 7 days/);
      process.env.LOG_RETENTION_DAYS = '0';
      assert.match(report().stdout, /proxy logs are not pruned/);
      fs.writeFileSync(file, JSON.stringify({ state: 'enrolled', retentionDays: 45 }));
      const out = report().stdout;
      assert.match(out, /configured retention: 45 days/);
      assert.match(out, /provider transcripts are cleaned up/);
      assert.doesNotMatch(out, /transcript deletion \(30 days\)/);
    } finally {
      fs.rmSync(file, { force: true });
      if (old === undefined) delete process.env.LOG_RETENTION_DAYS;
      else process.env.LOG_RETENTION_DAYS = old;
    }
  });

  it('files a proxied host, its twin-merged turns and a proxy-only request under the Ask', () => {
    const r = report('--json');
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    const a1 = out.asks.find(a => a.id === 'A-001');
    assert.equal(a1.completeness, 'complete');
    assert.equal(a1.attributed.calls, 3, 'two merged turns plus the proxy-only suggestion, each once');
    assert.equal(a1.attributed.cost, 1.25);
    assert.deepEqual(a1.executors.map(x => [x.kind, x.evidence, x.status]), [['host', 'prompt-match', 'unique']]);
    assert.deepEqual(a1.executors[0].main.effort, { high: 2, unknown: 1 });
    assert.equal(out.asks.find(a => a.id === 'A-002').labels.includes('empty'), true);
  });

  it('prints a text report without prompt text, session ids or paths', () => {
    const r = report();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^## A-001 · complete · /m);
    assert.match(r.stdout, /^- host · prompt-match · unique · complete · claude-test · /m);
    assert.match(r.stdout, /this machine's data only/);
    for (const secret of [PROMPT, SID, REPO, BASE]) assert.equal(r.stdout.includes(secret), false, `leaked ${secret}`);
    assert.equal(report('--json').stdout.includes(PROMPT), false);
  });

  it('matches a Codex host whose prompt follows an attached image, and counts its turns not yet imported', () => {
    const r = reportIn(REPO2, '--json');
    assert.equal(r.status, 0, r.stderr);
    const a1 = JSON.parse(r.stdout).asks.find(a => a.id === 'A-001');
    assert.deepEqual(a1.executors.filter(x => x.kind === 'host').map(x => [x.kind, x.evidence, x.status, x.completeness]), [['host', 'prompt-match', 'unique', 'transcripts only']]);
    // Three of the host's usage turns and one of its subagent thread's; one imported.
    assert.ok(a1.labels.includes('not yet imported: 3 turns'), a1.labels.join(' | '));
  });

  it('files a worker launched by the Codex host\'s subagent thread under the host\'s Ask', () => {
    const a1 = JSON.parse(reportIn(REPO2, '--json').stdout).asks.find(a => a.id === 'A-001');
    assert.deepEqual(a1.executors.filter(x => x.kind === 'external').map(x => [x.evidence, x.status, x.total.calls]), [['launch-chain', 'unique', 1]]);
  });

  it('does not call a host complete when a transcript turn reached neither the proxy nor the import', () => {
    const r = reportIn(REPO3, '--json');
    assert.equal(r.status, 0, r.stderr);
    const a1 = JSON.parse(r.stdout).asks.find(a => a.id === 'A-001');
    assert.ok(a1.labels.includes('not yet imported: 1 turns'), a1.labels.join(' | '));
    assert.deepEqual([a1.completeness, a1.executors.map(x => x.completeness)], ['partial proxy coverage', ['partial proxy coverage']]);
  });

  it('counts the whole notebook\'s not-yet-imported Asks in the footer under --ask, like its other counts', () => {
    const r = reportIn(REPO3, '--ask', 'A-002', '--json');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).footer.notYetImported, 1);
  });

  it('folds a proxied and an imported Codex host of one Ask into partial proxy coverage', () => {
    const r = reportIn(REPO4, '--json');
    assert.equal(r.status, 0, r.stderr);
    const a1 = JSON.parse(r.stdout).asks.find(a => a.id === 'A-001');
    assert.deepEqual(a1.executors.map(x => [x.evidence, x.completeness, x.total.calls]),
      [['prompt-match', 'complete', 3], ['window', 'transcripts only', 1]]);
    assert.equal(a1.completeness, 'partial proxy coverage');
    assert.equal(a1.labels.some(l => l.startsWith('not yet imported')), false, 'a proxied Codex session is read from the proxy');
  });

  it('discloses local host turns inside the bounds of an Ask that ran on another machine (F24)', () => {
    const r = reportIn(REPO5, '--json');
    assert.equal(r.status, 0, r.stderr);
    const a2 = JSON.parse(r.stdout).asks.find(a => a.id === 'A-002');
    assert.equal(a2.completeness, 'unknown');
    assert.ok(a2.labels.includes('no local evidence') && a2.labels.includes('local host turns inside bounds: 1'), a2.labels.join(' | '));
    assert.match(reportIn(REPO5).stdout, /local host turns inside bounds: 1/);
  });

  it('shows a run ambiguous between two notebooks in both reports, even when dispatch decided its Ask', () => {
    for (const nb of ['.agentflow/devlog.md', '.agentflow/notes.devlog.md']) {
      const r = reportIn(REPO6, '--notebook', nb, '--json');
      assert.equal(r.status, 0, r.stderr);
      // The host turn s6b and the worker turn w6 are both ambiguous between the notebooks.
      const a2 = JSON.parse(r.stdout).asks.find(a => a.id === 'A-002');
      assert.equal(a2.ambiguous.calls, 2, nb);
      // Its only host row is ambiguous, but it is a host row: not `unknown` (Completeness).
      assert.equal(a2.completeness, 'transcripts only', nb);
    }
  });

  it('reads the index back to the earliest matched start, not only a day before the earliest stamp', () => {
    const r = reportIn(REPO7, '--json');
    assert.equal(r.status, 0, r.stderr);
    const a1 = JSON.parse(r.stdout).asks.find(a => a.id === 'A-001');
    assert.equal(a1.attributed.calls, 2);
    assert.deepEqual(a1.labels, ['open']);
  });

  it('joins a clone named through a symlink to its worker\'s resolved cwd, even after the clone is gone', () => {
    const r = reportIn(REPO8, '--json');
    assert.equal(r.status, 0, r.stderr);
    const asks = JSON.parse(r.stdout).asks;
    const ext = id => asks.find(a => a.id === id).executors.filter(x => x.kind === 'external').map(x => [x.evidence, x.status, x.total.calls]);
    assert.deepEqual(ext('A-001'), [['dispatch', 'unique', 1]]);
    assert.deepEqual(ext('A-002'), [['launch-chain', 'unique', 1]]);
  });

  it('folds a host with no index line into the Ask\'s completeness, not only its not-yet-imported count', () => {
    const r = reportIn(REPO9, '--json');
    assert.equal(r.status, 0, r.stderr);
    const a1 = JSON.parse(r.stdout).asks.find(a => a.id === 'A-001');
    assert.ok(a1.labels.includes('not yet imported: 1 turns'), a1.labels.join('; '));
    assert.equal(a1.completeness, 'partial proxy coverage');
  });

  it('evaluates the checkout\'s default notebook as a candidate even when its name is not *.devlog.md', () => {
    const r = reportIn(REPO10, '--notebook', '.agentflow/devlog.md', '--json');
    assert.equal(r.status, 0, r.stderr);
    const a1 = JSON.parse(r.stdout).asks.find(a => a.id === 'A-001');
    assert.equal(a1.attributed.calls, 0);
    assert.equal(a1.ambiguous && a1.ambiguous.calls, 1);
  });

  it('rejects an Ask id that is not in the notebook', () => {
    const r = report('--ask', 'A-009');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /A-009 is not in/);
  });
});
