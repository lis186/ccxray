'use strict';

// Edge-case contract tests for server/wire-parsers/openai.js, written from the
// mutation-testing pilot (docs/mutation-testing.md). Each block names the
// behaviour a surviving mutant showed was unasserted. Synthetic fixtures only.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const openai = require('../server/wire-parsers/openai');
const store = require('../server/store');
const defaultRates = require('../server/default-rates');

const PROXY_RES = { statusCode: 200, headers: {} };
const GROK_HEADERS = { 'x-grok-client-version': '1.0.0' };

describe('openai header helpers', () => {
  it('firstHeader is null-safe and takes the first array value', () => {
    assert.equal(openai.firstHeader(undefined, 'x'), undefined);
    assert.equal(openai.firstHeader({ 'x-a': ['one', 'two'] }, 'X-A'), 'one');
  });

  it('parseCodexTurnMetadata accepts only JSON objects', () => {
    const parse = raw => openai.parseCodexTurnMetadata({ 'x-codex-turn-metadata': raw });
    assert.deepEqual(parse('{"session_id":"s"}'), { session_id: 's' });
    assert.equal(parse('5'), null);
    assert.equal(parse('"str"'), null);
    assert.equal(parse('null'), null);
    assert.equal(parse('{not json'), null);
    assert.equal(openai.parseCodexTurnMetadata(undefined), null);
    assert.equal(openai.parseCodexTurnMetadata('not-an-object'), null);
  });

  it('parseCodexTurnMetadata caches the parse per headers object', () => {
    const headers = { 'x-codex-turn-metadata': '{"session_id":"first"}' };
    assert.equal(openai.parseCodexTurnMetadata(headers).session_id, 'first');
    headers['x-codex-turn-metadata'] = '{"session_id":"second"}';
    assert.equal(openai.parseCodexTurnMetadata(headers).session_id, 'first');
    const empty = {};
    assert.equal(openai.parseCodexTurnMetadata(empty), null);
    empty['x-codex-turn-metadata'] = '{"session_id":"late"}';
    assert.equal(openai.parseCodexTurnMetadata(empty), null, 'a cached miss stays a miss');
  });
});

describe('openai.getCodexSessionId sources', () => {
  it('reads x-openai-session-id and trims header values', () => {
    assert.equal(openai.getCodexSessionId({ 'x-openai-session-id': ' oai-1 ' }, null), 'oai-1');
    assert.equal(openai.getCodexSessionId({ session_id: '  sid-1  ' }, null), 'sid-1');
  });

  it('a blank direct header falls through to later sources', () => {
    assert.equal(openai.getCodexSessionId({ session_id: '   ' }, { metadata: { session_id: 'body-1' } }), 'body-1');
  });

  it('trims client-specific session headers', () => {
    assert.equal(openai.getCodexSessionId({ 'x-grok-session-id': ' g-1 ' }, null), 'g-1');
    assert.equal(openai.getCodexSessionId({ 'x-grok-session-id': '   ' }, { metadata: { session_id: 'body-2' } }), 'body-2');
  });

  it('uses turn-metadata thread_id before body thread_id', () => {
    const headers = { 'x-codex-turn-metadata': JSON.stringify({ thread_id: 'thread-meta' }) };
    assert.equal(openai.getCodexSessionId(headers, { metadata: { thread_id: 'thread-body' } }), 'thread-meta');
    assert.equal(openai.getCodexSessionId({}, { metadata: { thread_id: 'thread-body' } }), 'thread-body');
    assert.equal(openai.getCodexSessionId({}, { metadata: { thread_id: 7 } }), null);
  });
});

describe('openai.getCodexWorkspaceCwd', () => {
  it('rejects non-objects', () => {
    assert.equal(openai.getCodexWorkspaceCwd(null), null);
    assert.equal(openai.getCodexWorkspaceCwd('abc'), null);
  });

  it('prefers cwd, then current, over other string values', () => {
    assert.equal(openai.getCodexWorkspaceCwd({ other: '/o', current: '/c', cwd: '/w' }), '/w');
    assert.equal(openai.getCodexWorkspaceCwd({ other: '/o', current: '/c' }), '/c');
    assert.equal(openai.getCodexWorkspaceCwd({ a: {}, b: '/s' }), '/s');
  });

  it('reads a nested { cwd } object, skipping null and non-string cwd', () => {
    assert.equal(openai.getCodexWorkspaceCwd({ a: null, b: { cwd: 5 }, c: { cwd: '/n' } }), '/n');
  });

  it('falls back to the first absolute-path key', () => {
    assert.equal(openai.getCodexWorkspaceCwd({ rel: { x: 1 }, '/p/q': { y: 1 } }), '/p/q');
    assert.equal(openai.getCodexWorkspaceCwd({ rel: { x: 1 } }), null);
  });
});

describe('openai.getCodexCwd sources', () => {
  const cwdOf = (body, headers = {}) => openai.getCodexCwd(headers, body);

  it('is null-safe without a body', () => {
    assert.equal(openai.getCodexCwd({}, undefined), null);
    assert.equal(openai.getCodexCwd({}, undefined, '/fallback'), '/fallback');
  });

  it('reads an instructions CWD line (start of text, trimmed, no-space form)', () => {
    assert.equal(cwdOf({ instructions: 'CWD:  /repo/a  \nmore' }), '/repo/a');
    assert.equal(cwdOf({ instructions: 'CWD:/abc' }), '/abc');
    assert.equal(cwdOf({ instructions: 'intro\nCWD: /repo/b' }), '/repo/b');
    assert.equal(cwdOf({ instructions: { cwd: '/obj' } }), null);
  });

  it('reads a Primary working directory line', () => {
    assert.equal(cwdOf({ instructions: 'Primary working directory:  /pwd/x  \nnext' }), '/pwd/x');
    assert.equal(cwdOf({ instructions: 'Primary working directory:/pq' }), '/pq');
  });

  it('input environment_context: skips null items and blocks, non-string text', () => {
    const env = '<environment_context><cwd> /env/a </cwd></environment_context>';
    assert.equal(cwdOf({ input: [null, 'str', { role: 'user', content: [null, { text: 5 }, { type: 'input_text', text: env }] }] }), '/env/a');
  });

  it('input environment_context: tolerates leading whitespace', () => {
    assert.equal(cwdOf({ input: [{ role: 'user', content: '  \n<environment_context><cwd>/env/b</cwd></environment_context>' }] }), '/env/b');
  });

  it('input environment_context: workspace_roots across whitespace and other tags, trimmed', () => {
    const env = '<environment_context><workspace_roots>\n  <other>x</other> <root> /root/r </root></workspace_roots></environment_context>';
    assert.equal(cwdOf({ input: [{ role: 'user', content: env }] }), '/root/r');
  });

  it('input environment_context without cwd or roots yields nothing', () => {
    assert.equal(cwdOf({ input: [{ role: 'user', content: '<environment_context><shell>zsh</shell></environment_context>' }] }), null);
  });
});

describe('openai.fillCodexMetadata', () => {
  it('ignores a non-object metadata value', () => {
    assert.deepEqual(openai.fillCodexMetadata('str', {}), {});
  });

  it('fills agent_type and cwd only when supplied and absent', () => {
    assert.deepEqual(openai.fillCodexMetadata({}, { agentType: 'worker', cwd: '/c' }), { agent_type: 'worker', cwd: '/c' });
    assert.deepEqual(openai.fillCodexMetadata({ agent_type: 'explorer', cwd: '/old' }, { agentType: 'worker', cwd: '/c' }),
      { agent_type: 'explorer', cwd: '/old' });
    assert.deepEqual(openai.fillCodexMetadata({ agent_type: 'explorer' }, {}), { agent_type: 'explorer' });
  });

  it('removes an unasserted client key entirely', () => {
    const out = openai.fillCodexMetadata({ client: 'grok', x: 1 }, {});
    assert.deepEqual(out, { x: 1 });
    assert.equal(Object.hasOwn(out, 'client'), false);
  });
});

describe('openai raw-session buckets and agent typing', () => {
  it('getOpenAIRawSessionId honours a body client when headers do not match', () => {
    assert.equal(openai.getOpenAIRawSessionId({}, { metadata: { client: 'grok' } }), 'grok-raw');
    assert.equal(openai.getOpenAIRawSessionId({}, { metadata: { client: 'nope' } }), 'codex-raw');
    assert.equal(openai.getOpenAIRawSessionId(GROK_HEADERS, { metadata: { client: 'nope' } }), 'grok-raw');
    assert.equal(openai.getOpenAIRawSessionId({}, undefined), 'codex-raw');
  });

  it('getOpenAIAgentTypeFromHeaders normalizes known types from each source', () => {
    const t = h => openai.getOpenAIAgentTypeFromHeaders(h);
    assert.equal(t({ 'x-openai-agent-type': 'Explorer' }), 'explorer');
    assert.equal(t({ 'x-codex-agent-type': 'WORKER' }), 'worker');
    assert.equal(t({ 'x-codex-turn-metadata': JSON.stringify({ agent_type: 'default' }) }), 'default');
    assert.equal(t({ 'x-openai-subagent': 'explorer' }), 'explorer');
    assert.equal(t({ 'x-openai-agent-type': 'planner' }), null);
    assert.equal(t({}), null);
  });

  it('getOpenAIAgentTypeFromHeaders source precedence: direct > metadata > subagent', () => {
    const meta = JSON.stringify({ agent_type: 'default' });
    assert.equal(openai.getOpenAIAgentTypeFromHeaders({ 'x-openai-agent-type': 'worker', 'x-codex-turn-metadata': meta, 'x-openai-subagent': 'explorer' }), 'worker');
    assert.equal(openai.getOpenAIAgentTypeFromHeaders({ 'x-codex-turn-metadata': meta, 'x-openai-subagent': 'explorer' }), 'default');
    assert.equal(openai.getOpenAIAgentTypeFromHeaders({ 'x-openai-agent-type': 'worker', 'x-codex-agent-type': 'explorer' }), 'worker');
  });

  it('isOpenAISubagent: "no" is falsy, body hints are null-safe', () => {
    assert.equal(openai.isOpenAISubagent({ 'x-openai-subagent': 'NO' }, null), false);
    assert.equal(openai.isOpenAISubagent({ 'x-openai-subagent': 'yes' }, null), true);
    assert.equal(openai.isOpenAISubagent({}, undefined), false);
    assert.equal(openai.isOpenAISubagent({}, { metadata: { isSubagent: true } }), true);
  });

  it('isGrokModel', () => {
    assert.equal(openai.isGrokModel('grok-4'), true);
    assert.equal(openai.isGrokModel('gpt-5'), false);
    assert.equal(openai.isGrokModel(undefined), false);
  });
});

describe('openai.getOpenAIInstructionsText', () => {
  it('stringifies non-string instructions', () => {
    assert.equal(openai.getOpenAIInstructionsText({ instructions: { a: 1 } }), '{"a":1}');
  });

  it('takes the first system input item with content, skipping others', () => {
    assert.equal(openai.getOpenAIInstructionsText({ input: [null, { role: 'user', content: 'u' }, { role: 'system' }, { role: 'system', content: 's2' }] }), 's2');
    assert.equal(openai.getOpenAIInstructionsText({ input: [{ role: 'system', content: [{ text: 'x' }] }] }), '[{"text":"x"}]');
    assert.equal(openai.getOpenAIInstructionsText({ input: [{ role: 'user', content: 'u' }] }), null);
  });
});

describe('openai.withCodexMetadata', () => {
  it('returns primitives unchanged', () => {
    assert.equal(openai.withCodexMetadata('abc', { session_id: 's' }), 'abc');
  });

  it('returns a body with null metadata and no signals unchanged', () => {
    const body = { model: 'gpt-5', metadata: null };
    assert.equal(openai.withCodexMetadata(body, {}), body);
  });
});

describe('openai.isNoiseRequest edges', () => {
  it('exact platform roots are noise', () => {
    for (const p of ['/v1/plugins', '/v1/ps/plugins', '/v1/connectors', '/v1/api/codex', '/v1/codex', '/v1/models']) {
      assert.equal(openai.isNoiseRequest(p, {}, {}), true, p);
    }
  });

  it('a control-plane client keeps conversation and messages paths', () => {
    for (const p of ['/v1/responses/resp_1', '/v1/chat/completions/x', '/v1/realtime', '/v1/realtime/s',
      '/v1/messages', '/v1/messages/count_tokens', '/health']) {
      assert.equal(openai.isNoiseRequest(p, GROK_HEADERS, {}), false, p);
    }
    assert.equal(openai.isNoiseRequest('/v1/settings', GROK_HEADERS, {}), true);
  });
});

describe('openai usage helpers', () => {
  it('extractUsage finds usage inside an event array, null when none', () => {
    assert.equal(openai.extractUsage([{ type: 'a' }, { type: 'response.completed', usage: { input_tokens: 5, output_tokens: 1 } }]).output_tokens, 1);
    assert.equal(openai.extractUsage([{ type: 'a' }]), null);
  });

  it('extractUsage preserves provider detail only when present', () => {
    const withDetail = openai.extractUsage({ usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 4 }, output_tokens_details: { reasoning_tokens: 1 } } });
    assert.deepEqual(withDetail.input_tokens_details, { cached_tokens: 4 });
    assert.deepEqual(withDetail.output_tokens_details, { reasoning_tokens: 1 });
    const bare = openai.extractUsage({ usage: { input_tokens: 10, output_tokens: 2 } });
    assert.equal(Object.hasOwn(bare, 'input_tokens_details'), false);
    assert.equal(Object.hasOwn(bare, 'output_tokens_details'), false);
  });

  it('hasContextUsage handles null and event arrays', () => {
    assert.equal(openai.hasContextUsage(null), false);
    assert.equal(openai.hasContextUsage([null, { usage: { input_tokens: 0 } }]), true);
    assert.equal(openai.hasContextUsage([{ type: 'a' }]), false);
  });
});

describe('openai.detectSession flags', () => {
  it('a raw fallback is marked inferred', () => {
    const out = openai.detectSession(null, {}, {});
    assert.equal(out.sessionId, 'codex-raw');
    assert.equal(out.inferred, true);
    assert.equal(out.isNewSession, false);
  });

  it('an explicit session reports isNewSession once', () => {
    const headers = { session_id: 'edge-oai-sid-1' };
    assert.equal(openai.detectSession(null, headers, { metadata: { x: 1 } }).isNewSession, true);
    const again = openai.detectSession(null, headers, null);
    assert.equal(again.isNewSession, false);
    assert.equal(again.inferred, false);
    assert.equal(again.sessionId, 'edge-oai-sid-1');
  });
});

describe('openai.extractOpenAICwd', () => {
  const user = content => ({ input: [{ role: 'user', content }] });

  it('uses a non-empty string metadata.cwd', () => {
    assert.equal(openai.extractOpenAICwd({ metadata: { cwd: '/meta' } }), '/meta');
    assert.equal(openai.extractOpenAICwd({ metadata: { cwd: 5 }, instructions: 'CWD: /i' }), '/i');
  });

  it('reads only user items, string or array content', () => {
    assert.equal(openai.extractOpenAICwd({ input: [null, { role: 'system', content: 'Workspace Path: /sys' }, { role: 'user', content: 'Workspace Path: /u' }] }), '/u');
    assert.equal(openai.extractOpenAICwd(user([{ text: 'Workspace Path: /ws' }, null, { text: 'Shell: zsh' }])), '/ws');
  });

  it('stops a Workspace Path at a tag or labeled field', () => {
    assert.equal(openai.extractOpenAICwd(user('<user_info>Workspace Path: /a/b</user_info>')), '/a/b');
    assert.equal(openai.extractOpenAICwd(user('Workspace Path:  /a/b</user_info>')), '/a/b');
    assert.equal(openai.extractOpenAICwd(user('Workspace Path:/a/b<x>')), '/a/b');
    assert.equal(openai.extractOpenAICwd(user('Workspace Path: /a/b Shell: zsh')), '/a/b');
    assert.equal(openai.extractOpenAICwd(user('Workspace Path: /tmp/myShell')), '/tmp/myShell');
  });

  it('falls back to the first non-space token', () => {
    assert.equal(openai.extractOpenAICwd(user('Workspace Path: /a b')), '/a');
    assert.equal(openai.extractOpenAICwd(user('Workspace Path:  /a b')), '/a');
    assert.equal(openai.extractOpenAICwd(user('Workspace Path:/ab c')), '/ab');
  });

  it('reads an instructions CWD line', () => {
    assert.equal(openai.extractOpenAICwd({ instructions: 'CWD: /i  ' }), '/i');
    assert.equal(openai.extractOpenAICwd({ instructions: 'CWD:/ij' }), '/ij');
    assert.equal(openai.extractOpenAICwd({ instructions: 'x\nCWD: /ij k' }), '/ij k');
    assert.equal(openai.extractOpenAICwd({ instructions: 'no cwd' }), null);
  });
});

describe('openai.buildEntryFields contract', () => {
  const build = ctx => openai.buildEntryFields({ branch: null, proxyRes: PROXY_RES, ...ctx });

  it('tolerates a missing parsedBody', () => {
    const f = build({});
    assert.equal(f.model, null);
    assert.equal(f.msgCount, 0);
    assert.equal(f.toolCount, 0);
    assert.equal(f.title, null);
    assert.equal(f.effort, null);
    assert.equal(f.stopReason, '');
    assert.equal(f.isSubagent, false);
    assert.equal(f.sessionInferred, false);
    assert.equal(f.toolsHash, null);
    assert.equal(f.coreHash, null);
    assert.equal(f.agentKey, null);
    assert.equal(f.agentLabel, null);
    assert.equal(f.responseMetadata.provider, 'openai');
    assert.equal(Object.hasOwn(f.responseMetadata, 'streaming'), false);
  });

  it('passes through caller flags and hashes', () => {
    const f = build({ isSubagent: true, sessionInferred: true, toolsHash: 't', coreHash: 'c', agentKey: 'k', agentLabel: 'L' });
    assert.equal(f.isSubagent, true);
    assert.equal(f.sessionInferred, true);
    assert.deepEqual([f.toolsHash, f.coreHash, f.agentKey, f.agentLabel], ['t', 'c', 'k', 'L']);
  });

  it('contextUsageKnown: explicit boolean, response usage, or WS lastUsage', () => {
    const response = { usage: { input_tokens: 5, output_tokens: 1 } };
    assert.equal(build({ response, contextUsageKnown: false }).contextUsageKnown, false);
    assert.equal(build({ response: { usage: { output_tokens: 1 } } }).contextUsageKnown, false);
    assert.equal(build({ response }).contextUsageKnown, true);
    assert.equal(build({ transport: 'websocket', lastUsage: { input_tokens: 5 } }).contextUsageKnown, true);
    assert.equal(build({ transport: 'websocket', lastUsage: { output_tokens: 5 } }).contextUsageKnown, false);
    assert.equal(build({ transport: 'websocket' }).contextUsageKnown, false);
  });

  it('model precedence: lastModel > response.model > body.model > prewarm', () => {
    assert.equal(build({ lastModel: 'm-last', response: { model: 'm-res' }, parsedBody: { model: 'm-body' } }).model, 'm-last');
    assert.equal(build({ response: { model: 'm-res' }, parsedBody: { model: 'm-body' } }).model, 'm-res');
    assert.equal(build({ response: {}, parsedBody: { model: 'm-body' } }).model, 'm-body');
    const ws = build({ transport: 'websocket', prewarmTurn: { model: 'm-pre', effort: 'high' } });
    assert.equal(ws.model, 'm-pre');
    assert.equal(ws.effort, 'high');
    assert.equal(build({ prewarmTurn: { model: 'm-pre' } }).model, null, 'prewarm is WS-only');
  });

  it('responseMetadata: WS default/custom, HTTP streaming flag', () => {
    assert.deepEqual(build({ transport: 'websocket' }).responseMetadata, { transport: 'websocket', capture: 'transport-only' });
    assert.deepEqual(build({ transport: 'websocket', responseMetadata: { custom: 1 } }).responseMetadata, { custom: 1 });
    assert.equal(build({ events: [{ type: 'response.created' }] }).responseMetadata.streaming, true);
  });

  it('tool calls come from streamed events, else the response output (shell → Bash)', () => {
    const call = { type: 'function_call', name: 'shell', call_id: 'c1' };
    assert.deepEqual(build({ response: { output: [call] } }).toolCalls, { Bash: 1 });
    assert.deepEqual(build({ response: { output: [] }, events: [{ type: 'response.output_item.done', item: call }] }).toolCalls, { Bash: 1 });
  });

  it('branch: explicit null skips the checkout read; absent reads the cwd checkout', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-oai-branch-'));
    try {
      fs.mkdirSync(path.join(dir, '.git'));
      fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/edge-branch\n');
      assert.equal(openai.buildEntryFields({ proxyRes: PROXY_RES, cwd: dir }).branch, 'edge-branch');
      assert.equal(openai.buildEntryFields({ proxyRes: PROXY_RES, cwd: dir, branch: null }).branch, null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prices a Grok turn by its xai upstream, not the openai wire family (#568)', () => {
    const rates = n => ({ input: n, output: n, cache_create: n, cache_read: n });
    defaultRates.setRateTable({ 'xai/grok-edge-test': rates(1), 'grok-edge-test': rates(10), 'openai/grok-edge-test': rates(100) });
    try {
      const f = build({ parsedBody: { model: 'grok-edge-test' }, response: { model: 'grok-edge-test', usage: { input_tokens: 1_000_000, output_tokens: 0 } } });
      assert.equal(f.agent, 'grok');
      assert.equal(f.cost.cost, 1);
    } finally {
      defaultRates.__resetRateTableForTests();
    }
  });

  it('title prefers the input summary, then the output summary', () => {
    const response = { output: [{ type: 'message', content: [{ type: 'output_text', text: 'answer text' }] }] };
    assert.equal(build({ parsedBody: { input: [{ role: 'user', content: 'hello world' }] }, response }).title, 'hello world');
    assert.equal(build({ parsedBody: { input: [] }, response }).title, 'answer text');
  });
});

describe('openai.registerPromptVersion', () => {
  it('returns null without instructions', () => {
    assert.equal(openai.registerPromptVersion({ parsedBody: { model: 'gpt-5' } }), null);
  });

  it('records, broadcasts, and updates the shared file of a known prompt', () => {
    const writes = [];
    const client = { write: s => writes.push(s) };
    store.sseClients.push(client);
    try {
      const parsedBody = { instructions: 'You are Codex. Edge-case prompt for the mutation pilot.' };
      const out = openai.registerPromptVersion({ parsedBody, sysHash: 'h1' });
      assert.equal(out.agentKey, 'default');
      const rec = store.versionIndex.get(`${out.agentKey}::${out.coreHash}`);
      assert.ok(rec);
      assert.equal(rec.sharedFile, 'openai_instructions_h1.json');
      assert.match(rec.firstSeen, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(writes.length, 1);
      assert.match(writes[0], /^data: \{.*\}\n\n$/);
      const payload = JSON.parse(writes[0].slice(6));
      assert.deepEqual(payload, { _type: 'version_detected', version: out.coreHash, b2Len: parsedBody.instructions.length, agentKey: 'default', agentLabel: out.agentLabel, provider: 'openai' });

      assert.deepEqual(openai.registerPromptVersion({ parsedBody }), out, 'known prompt returns the same identity');
      assert.equal(rec.sharedFile, 'openai_instructions_h1.json', 'no file hint keeps the shared file');
      openai.registerPromptVersion({ parsedBody, sysHash: 'h2' });
      assert.equal(rec.sharedFile, 'openai_instructions_h2.json');
      openai.registerPromptVersion({ parsedBody, sysHash: 'h3', sharedFile: 'explicit.json' });
      assert.equal(rec.sharedFile, 'explicit.json');
      assert.equal(writes.length, 1, 'updates do not re-broadcast');
    } finally {
      store.sseClients.splice(store.sseClients.indexOf(client), 1);
    }
  });

  it('a new prompt prefers an explicit sharedFile and is null without hints', () => {
    const a = openai.registerPromptVersion({ parsedBody: { instructions: 'Edge prompt A for sharedFile precedence.' }, sysHash: 'hx', sharedFile: 'given.json' });
    assert.equal(store.versionIndex.get(`${a.agentKey}::${a.coreHash}`).sharedFile, 'given.json');
    const b = openai.registerPromptVersion({ parsedBody: { instructions: 'Edge prompt B without any file hint.' } });
    assert.equal(store.versionIndex.get(`${b.agentKey}::${b.coreHash}`).sharedFile, null);
  });
});

describe('openai hashes and turn steps', () => {
  it('toolsHash is null-safe and keeps its prefix', () => {
    assert.deepEqual(openai.toolsHash(undefined), { hash: null, filePrefix: 'openai_tools_' });
    assert.equal(openai.toolsHash({ tools: [{ name: 't' }] }).filePrefix, 'openai_tools_');
  });

  it('attributionTurnStep is always 0/0 on the OpenAI wire', () => {
    assert.deepEqual(openai.attributionTurnStep({ input: [{ role: 'user', content: 'x' }] }), { turn: 0, step: 0 });
  });
});
