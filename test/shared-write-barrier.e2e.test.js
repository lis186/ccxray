'use strict';

// #776 (codex r1): shared sys/tools writes are part of the entry write barrier.
// With a slow compressor on the shared payload only, a lazy load right after the
// response must still see the system prompt instead of caching null forever.

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { startProxy, slowGzipEnv } = require('./helpers/proxy-fixture');

const MARK = 'SLOW-SHARED-MARKER';
let fx;
afterEach(async () => { if (fx) await fx.stop(); fx = null; });

describe('shared write barrier (#776)', () => {
  it('lazy load right after the response sees the shared system prompt', async () => {
    fx = await startProxy({ env: slowGzipEnv(700, MARK) });
    const status = await fx.post({
      model: 'claude-sonnet-4-6', max_tokens: 50,
      system: [{ type: 'text', text: `You are Claude Code. ${MARK} ` + 'x'.repeat(500) }],
      tools: [{ name: 'Bash', description: 'run', input_schema: { type: 'object' } }],
      messages: [{ role: 'user', content: 'hello' }],
    });
    assert.equal(status, 200);
    let id;
    for (let i = 0; i < 50 && !id; i++) {
      const { entries } = await fx.getJson('/_api/entries');
      id = entries[0] && entries[0].id;
      if (!id) await new Promise(r => setTimeout(r, 20));
    }
    assert.ok(id, 'entry registered');
    const e = await fx.getJson('/_api/entry/' + encodeURIComponent(id));
    assert.ok(e.req && e.req.system, 'system prompt present (shared write inside the barrier)');
    assert.match(JSON.stringify(e.req.system), new RegExp(MARK));
  });
});
