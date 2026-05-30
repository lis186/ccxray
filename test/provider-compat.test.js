'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const config = require('../server/config');
const store = require('../server/store');
const { createLocalStorage } = require('../server/storage/local');
const { loadEntryReqRes, restoreFromLogs } = require('../server/restore');
const { summarizeEntry } = require('../server/sse-broadcast');

describe('1.9.x provider compat — entries without provider field', () => {
  const tmpDir = path.join(os.tmpdir(), 'ccxray-provider-compat-' + Date.now());
  let realStorage;

  before(async () => {
    realStorage = config.storage;
    const tmpStorage = createLocalStorage(tmpDir);
    await tmpStorage.init();
    config.storage = tmpStorage;
  });

  after(() => {
    config.storage = realStorage;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    store.entries.length = 0;
    for (const sid of Object.keys(store.sessionMeta)) delete store.sessionMeta[sid];
  });

  it('loadEntryReqRes handles Anthropic entry without provider field', async () => {
    const id = 'legacy-001';
    const reqBody = {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8096,
      messages: [{ role: 'user', content: 'hello' }],
    };
    await config.storage.write(id, '_req.json', JSON.stringify(reqBody));
    await config.storage.write(id, '_res.json', JSON.stringify([
      { type: 'message_start', message: { usage: { input_tokens: 10 } } },
    ]));

    // No provider field — simulates 1.9.x entry
    const entry = { id, req: null, res: null, _loaded: false };
    store.entries.push(entry);

    await loadEntryReqRes(entry);

    assert.ok(entry.req, 'req should be loaded');
    assert.deepEqual(entry.req.messages, [{ role: 'user', content: 'hello' }]);
    assert.equal(entry.req.model, 'claude-sonnet-4-20250514');
  });

  it('loadEntryReqRes handles Anthropic entry with sysHash and no provider', async () => {
    const id = 'legacy-sys-001';
    const sysContent = [{ text: 'config' }, { text: 'branding' }, { text: 'instructions' }];
    const sysHash = 'abc123';

    await config.storage.writeSharedIfAbsent(`sys_${sysHash}.json`, JSON.stringify(sysContent));
    await config.storage.write(id, '_req.json', JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8096,
      sysHash,
      messages: [{ role: 'user', content: 'test' }],
    }));
    await config.storage.write(id, '_res.json', JSON.stringify([]));

    const entry = { id, req: null, res: null, _loaded: false };
    store.entries.push(entry);

    await loadEntryReqRes(entry);

    assert.ok(entry.req.system, 'system prompt should be hydrated');
    assert.deepEqual(entry.req.system, sysContent);
    assert.ok(!('sysHash' in entry.req), 'sysHash should be cleaned up');
  });

  it('summarizeEntry defaults provider to anthropic when missing', () => {
    const entry = {
      id: 'legacy-002', ts: '12:00:00', sessionId: 'sess-1',
      method: 'POST', url: '/v1/messages', status: 200, elapsed: 1000,
      isSSE: true, usage: { input_tokens: 100, output_tokens: 50 },
    };
    const summary = summarizeEntry(entry);

    assert.equal(summary.provider, 'anthropic');
    assert.equal(summary.agent, 'claude');
  });

  it('summarizeEntry preserves explicit provider when present', () => {
    const entry = {
      id: 'new-001', ts: '12:00:00', sessionId: 'sess-1',
      provider: 'openai', agent: 'codex',
      method: 'POST', url: '/v1/responses', status: 200, elapsed: 1000,
      isSSE: false, usage: { input_tokens: 100, output_tokens: 50 },
    };
    const summary = summarizeEntry(entry);

    assert.equal(summary.provider, 'openai');
    assert.equal(summary.agent, 'codex');
  });
});
