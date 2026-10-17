'use strict';

// Edge-case contract tests for server/wire-parsers/anthropic.js, written from
// the mutation-testing pilot (docs/mutation-testing.md). Each block names the
// behaviour a surviving mutant showed was unasserted. Synthetic fixtures only.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const anthropic = require('../server/wire-parsers/anthropic');
const store = require('../server/store');
const helpers = require('../server/helpers');
const { splitB2IntoBlocks, computeCoreHash } = require('../server/system-prompt');

const md5_8 = s => crypto.createHash('md5').update(s).digest('hex').slice(0, 8);

describe('anthropic.isNoiseRequest guards', () => {
  it('a non-string url is never noise and never throws', () => {
    assert.equal(anthropic.isNoiseRequest(undefined, {}, {}), false);
    assert.equal(anthropic.isNoiseRequest(null, {}, {}), false);
    assert.equal(anthropic.isNoiseRequest(42, {}, {}), false);
  });
});

describe('anthropic.extractUsage event selection', () => {
  it('finds message_start even when another event comes first', () => {
    const usage = anthropic.extractUsage([
      { type: 'ping', usage: { input_tokens: 999 } },
      { type: 'message_start', message: { usage: { input_tokens: 7, output_tokens: 1 } } },
    ]);
    assert.equal(usage.input_tokens, 7);
    assert.equal(usage.output_tokens, 1);
  });

  it('falls back to message_delta usage when message_start carries no message', () => {
    const usage = anthropic.extractUsage([
      { type: 'message_start' },
      { type: 'message_delta', usage: { input_tokens: 3, output_tokens: 9 } },
    ]);
    assert.deepEqual(usage, {
      input_tokens: 3, output_tokens: 9, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
    });
  });

  it('reads delta-only streams (no message_start at all)', () => {
    const usage = anthropic.extractUsage([{ type: 'message_delta', usage: { output_tokens: 4 } }]);
    assert.equal(usage.output_tokens, 4);
    assert.equal(usage.input_tokens, 0);
  });

  it('keeps message_start output_tokens when message_delta has no usage', () => {
    const usage = anthropic.extractUsage([
      { type: 'message_start', message: { usage: { input_tokens: 2, output_tokens: 5 } } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    ]);
    assert.equal(usage.output_tokens, 5);
  });

  it('copies the cache_creation tier split, defaulting non-numeric tiers to 0', () => {
    const usage = anthropic.extractUsage([{ type: 'message_start', message: { usage: {
      input_tokens: 1,
      cache_creation: { ephemeral_5m_input_tokens: 11, ephemeral_1h_input_tokens: 'x' },
    } } }]);
    assert.deepEqual(usage.cache_creation, { ephemeral_5m_input_tokens: 11, ephemeral_1h_input_tokens: 0 });
  });

  it('omits cache_creation when it is absent, null or not an object', () => {
    for (const cache_creation of [undefined, null, 5, 'str']) {
      const usage = anthropic.extractUsage([{ type: 'message_start', message: { usage: { input_tokens: 1, cache_creation } } }]);
      assert.equal('cache_creation' in usage, false, `cache_creation=${String(cache_creation)}`);
    }
  });
});

describe('anthropic.hasContextUsage', () => {
  it('is false for missing data', () => {
    assert.equal(anthropic.hasContextUsage(null), false);
    assert.equal(anthropic.hasContextUsage(undefined), false);
  });

  it('reads a non-SSE response object (usage or bare usage)', () => {
    assert.equal(anthropic.hasContextUsage({ usage: { input_tokens: 0 } }), true);
    assert.equal(anthropic.hasContextUsage({ input_tokens: 4 }), true);
    assert.equal(anthropic.hasContextUsage({ usage: { output_tokens: 4 } }), false);
  });

  it('finds message_start among other events', () => {
    assert.equal(anthropic.hasContextUsage([
      { type: 'ping' },
      { type: 'message_start', message: { usage: { input_tokens: 1 } } },
    ]), true);
  });

  it('falls back to message_delta usage when message_start has none', () => {
    assert.equal(anthropic.hasContextUsage([
      { type: 'message_start' },
      { type: 'message_delta', usage: { input_tokens: 5 } },
    ]), true);
    assert.equal(anthropic.hasContextUsage([{ type: 'message_delta', usage: { cache_read_input_tokens: 2 } }]), true);
  });

  it('does not read usage from unrelated events', () => {
    assert.equal(anthropic.hasContextUsage([
      { type: 'message_stop', usage: { input_tokens: 5 } },
      { type: 'message_delta', usage: { output_tokens: 1 } },
    ]), false);
  });
});

describe('anthropic.extractResponseId', () => {
  it('skips null and non-message_start events', () => {
    assert.equal(anthropic.extractResponseId([null, { type: 'ping' }, { type: 'message_start', message: { id: 'msg_01x' } }]), 'msg_01x');
  });

  it('is null when message_start has no message or no id', () => {
    assert.equal(anthropic.extractResponseId([{ type: 'message_start' }]), null);
    assert.equal(anthropic.extractResponseId([{ type: 'message_start', message: {} }]), null);
    assert.equal(anthropic.extractResponseId([]), null);
  });

  it('reads a non-SSE id and is null for primitives', () => {
    assert.equal(anthropic.extractResponseId({ id: 'msg_02y' }), 'msg_02y');
    assert.equal(anthropic.extractResponseId({}), null);
    assert.equal(anthropic.extractResponseId(''), null);
  });
});

describe('anthropic.detectSession', () => {
  it('delegates to store.detectSession with the request socket', () => {
    const socket = {};
    const out = anthropic.detectSession({ socket }, {}, { metadata: { session_id: 'edge-anth-sid-1' } });
    assert.equal(out.sessionId, 'edge-anth-sid-1');
    assert.equal(out.isNewSession, true);
    assert.equal(anthropic.detectSession({ socket }, {}, { metadata: { session_id: 'edge-anth-sid-1' } }).isNewSession, false);
  });

  it('tolerates a missing request object', () => {
    const out = anthropic.detectSession(undefined, {}, { metadata: { session_id: 'edge-anth-sid-2' } });
    assert.equal(out.sessionId, 'edge-anth-sid-2');
  });
});

describe('anthropic.computeConvId', () => {
  it('is null without a first message', () => {
    assert.equal(anthropic.computeConvId(undefined), null);
    assert.equal(anthropic.computeConvId({}), null);
    assert.equal(anthropic.computeConvId({ messages: [] }), null);
  });

  it('hashes string content directly', () => {
    assert.equal(anthropic.computeConvId({ messages: [{ role: 'user', content: 'hello' }] }), md5_8('hello'));
  });

  it('hashes only text blocks, newline-joined', () => {
    const content = [
      { type: 'image', source: {} },
      { type: 'text', text: 'a' },
      null,
      { type: 'text', text: 5 },
      { type: 'tool_result', text: 'not text' },
      { type: 'text', text: 'b' },
    ];
    assert.equal(anthropic.computeConvId({ messages: [{ role: 'user', content }] }), md5_8('a\nb'));
  });

  it('is null for content that is neither a string nor an array', () => {
    assert.equal(anthropic.computeConvId({ messages: [{ role: 'user', content: { text: 'x' } }] }), null);
  });
});

describe('anthropic.buildEntryFields contract', () => {
  it('tolerates a missing parsedBody', () => {
    const f = anthropic.buildEntryFields({ branch: null });
    assert.equal(f.provider, 'anthropic');
    assert.equal(f.agent, 'claude');
    assert.equal(f.model, null);
    assert.equal(f.msgCount, 0);
    assert.equal(f.toolCount, 0);
    assert.equal(f.convId, null);
    assert.equal(f.effort, null);
    assert.equal(f.stopReason, '');
    assert.equal(f.toolsHash, null);
    assert.equal(f.agentLabel, null);
    assert.equal(f.beta1m, undefined);
  });

  it('tolerates a parsedBody without messages or tools', () => {
    const f = anthropic.buildEntryFields({ branch: null, parsedBody: { model: 'claude-sonnet-4-5' } });
    assert.equal(f.msgCount, 0);
    assert.equal(f.toolCount, 0);
  });

  it('passes through caller-supplied hashes and labels', () => {
    const f = anthropic.buildEntryFields({ branch: null, parsedBody: { messages: [] }, toolsHash: 'tools123', agentLabel: 'Explore' });
    assert.equal(f.toolsHash, 'tools123');
    assert.equal(f.agentLabel, 'Explore');
  });

  it('contextUsageKnown: an explicit boolean wins, else ctx.usage decides', () => {
    const events = [{ type: 'message_start', message: { usage: { input_tokens: 5 } } }];
    assert.equal(anthropic.buildEntryFields({ branch: null, events, contextUsageKnown: false }).contextUsageKnown, false);
    assert.equal(anthropic.buildEntryFields({ branch: null, contextUsageKnown: true }).contextUsageKnown, true);
    assert.equal(anthropic.buildEntryFields({ branch: null, usage: { input_tokens: 3 } }).contextUsageKnown, true);
    assert.equal(anthropic.buildEntryFields({ branch: null, usage: { output_tokens: 3 }, events }).contextUsageKnown, false);
    assert.equal(anthropic.buildEntryFields({ branch: null, events }).contextUsageKnown, true);
  });

  it('an explicit isSubagent overrides the store heuristic', () => {
    // A bare body (no cwd, no session) is a subagent by heuristic.
    assert.equal(anthropic.buildEntryFields({ branch: null, parsedBody: { messages: [] } }).isSubagent, true);
    assert.equal(anthropic.buildEntryFields({ branch: null, parsedBody: { messages: [] }, isSubagent: false }).isSubagent, false);
  });

  it('an explicit toolFail overrides the history scan', () => {
    const parsedBody = { messages: [{ role: 'user', content: [{ type: 'tool_result', is_error: true }] }] };
    assert.equal(anthropic.buildEntryFields({ branch: null, parsedBody }).toolFail, true);
    assert.equal(anthropic.buildEntryFields({ branch: null, parsedBody, toolFail: false }).toolFail, false);
  });

  it('beta1m reaches maxContext for a 1M-capable model', () => {
    const parsedBody = { model: 'claude-sonnet-4-5', messages: [] };
    assert.equal(anthropic.buildEntryFields({ branch: null, parsedBody, beta1m: true }).maxContext, 1_000_000);
    assert.equal(anthropic.buildEntryFields({ branch: null, parsedBody }).maxContext, 200_000);
  });
});

describe('anthropic.registerPromptVersion', () => {
  const b0 = v => `x-anthropic-billing-header: cc_version=${v}; cc_entrypoint=cli`;
  const body = (b0Text, b2) => ({ system: [{ type: 'text', text: b0Text }, { type: 'text', text: 'b1' }, { type: 'text', text: b2 }] });

  it('rejects fewer than three system blocks or a non-array system', () => {
    assert.equal(anthropic.registerPromptVersion({ parsedBody: { system: [{ text: 'a' }, { text: 'b' }] } }), null);
    assert.equal(anthropic.registerPromptVersion({ parsedBody: { system: 'a'.repeat(600) } }), null);
    assert.equal(anthropic.registerPromptVersion({ parsedBody: {} }), null);
    assert.equal(anthropic.registerPromptVersion({}), null);
  });

  it('requires a b2 of at least 500 characters', () => {
    assert.equal(anthropic.registerPromptVersion({ parsedBody: body(b0('9.9.1'), 'p'.repeat(499)) }), null);
    assert.ok(anthropic.registerPromptVersion({ parsedBody: body('', 'p'.repeat(500)) }));
  });

  it('hashes the core instructions, not the whole b2', () => {
    const b2 = 'Edge core instructions alpha. ' + 'y'.repeat(520) + '\n# Environment\nWorking directory: /tmp/x';
    const out = anthropic.registerPromptVersion({ parsedBody: body('', b2) });
    assert.equal(out.coreHash, computeCoreHash(splitB2IntoBlocks(b2).coreInstructions));
  });

  it('hashes empty core instructions when b2 opens with a section marker', () => {
    const b2 = '# Environment\nWorking directory: /tmp/edge\n' + 'e'.repeat(520);
    const out = anthropic.registerPromptVersion({ parsedBody: body('', b2) });
    assert.equal(out.coreHash, computeCoreHash(''));
  });

  it('records a new version under agentKey::coreHash with a date-only firstSeen and broadcasts it', () => {
    const writes = [];
    const client = { write: s => writes.push(s) };
    store.sseClients.push(client);
    try {
      const b2 = 'Edge core instructions beta. ' + 'z'.repeat(520);
      const out = anthropic.registerPromptVersion({ parsedBody: body(b0('3.2.1'), b2), sysHash: 'abc123' });
      const rec = store.versionIndex.get(`${out.agentKey}::${out.coreHash}`);
      assert.ok(rec, 'version recorded under agentKey::coreHash');
      assert.equal(rec.version, '3.2.1');
      assert.equal(rec.sharedFile, 'sys_abc123.json');
      assert.match(rec.firstSeen, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(rec.provider, 'anthropic');
      assert.equal(writes.length, 1);
      assert.match(writes[0], /"_type":"version_detected"/);
      assert.match(writes[0], /"version":"3\.2\.1"/);

      // Same core prompt seen again: update in place, no second broadcast.
      anthropic.registerPromptVersion({ parsedBody: body(b0('3.2.2'), b2), sysHash: 'def456' });
      assert.equal(rec.version, '3.2.2');
      assert.equal(rec.sharedFile, 'sys_def456.json');
      anthropic.registerPromptVersion({ parsedBody: body(b0('3.2.3'), b2) });
      assert.equal(rec.version, '3.2.3');
      assert.equal(rec.sharedFile, 'sys_def456.json', 'no sysHash keeps the previous shared file');
      assert.equal(writes.length, 1);
    } finally {
      store.sseClients.splice(store.sseClients.indexOf(client), 1);
    }
  });

  it('records sharedFile null without a sysHash', () => {
    const b2 = 'Edge core instructions gamma. ' + 'w'.repeat(520);
    const out = anthropic.registerPromptVersion({ parsedBody: body(b0('4.0.0'), b2) });
    assert.equal(store.versionIndex.get(`${out.agentKey}::${out.coreHash}`).sharedFile, null);
  });

  it('does not record a version without a cc_version marker', () => {
    const b2 = 'Edge core instructions delta. ' + 'v'.repeat(520);
    const out = anthropic.registerPromptVersion({ parsedBody: body('no version here', b2) });
    assert.ok(out.coreHash);
    assert.equal(store.versionIndex.has(`${out.agentKey}::${out.coreHash}`), false);
  });
});

describe('anthropic hashes, steps and response tool calls', () => {
  it('systemPromptHash / toolsHash are null-safe and keep their file prefixes', () => {
    assert.deepEqual(anthropic.systemPromptHash(undefined), { hash: null, filePrefix: 'sys_', content: null });
    assert.deepEqual(anthropic.toolsHash(undefined), { hash: null, filePrefix: 'tools_' });
    assert.equal(anthropic.toolsHash({ tools: [{ name: 't' }] }).filePrefix, 'tools_');
  });

  it('turnStepCount counts assistant tool_use blocks only', () => {
    assert.equal(anthropic.turnStepCount(undefined), 0);
    assert.equal(anthropic.turnStepCount({ messages: [
      { role: 'user', content: [{ type: 'tool_use' }] },
      { role: 'assistant', content: 'plain text' },
      { role: 'assistant', content: [{ type: 'tool_use' }, { type: 'text' }, { type: 'tool_use' }] },
    ] }), 2);
  });

  it('attributionTurnStep delegates to helpers.computeTurnStep', () => {
    assert.deepEqual(anthropic.attributionTurnStep(undefined), { turn: 0, step: 0 });
    const messages = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1' }] },
    ];
    assert.deepEqual(anthropic.attributionTurnStep({ messages }), helpers.computeTurnStep(messages));
  });

  it('extractTurnToolCalls counts only named tool_use block starts', () => {
    assert.deepEqual(anthropic.extractTurnToolCalls([
      { type: 'content_block_start' },
      { type: 'content_block_stop', content_block: { type: 'tool_use', name: 'Bash' } },
      { type: 'content_block_start', content_block: { type: 'text', name: 'Bash' } },
      { type: 'content_block_start', content_block: { type: 'tool_use' } },
      { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Read' } },
      { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Read' } },
    ]), { Read: 2 });
    assert.deepEqual(anthropic.extractTurnToolCalls({ content: [
      { type: 'text', name: 'x' }, { type: 'tool_use' }, { type: 'tool_use', name: 'Edit' },
    ] }), { Edit: 1 });
    assert.deepEqual(anthropic.extractTurnToolCalls({ id: 'msg' }), {});
  });

  it('extractAnthropicToolCallIds delegates to helpers', () => {
    const res = { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Grep' }] };
    assert.deepEqual(anthropic.extractAnthropicToolCallIds(res), { toolu_1: 'Grep' });
  });
});
