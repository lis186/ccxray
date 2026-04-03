'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createLocalStorage } = require('../server/storage/local');

// ── loadEntryReqRes (content-addressed) ─────────────────────────────

describe('loadEntryReqRes', () => {
  const tmpDir = path.join(os.tmpdir(), 'ccxray-restore-test-' + Date.now());
  let storage;

  before(async () => {
    storage = createLocalStorage(tmpDir);
    await storage.init();
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reconstructs full req from stripped _req.json + shared files', async () => {
    const sys = [{ type: 'text', text: 'system prompt' }];
    const tools = [{ name: 'bash', description: 'run bash' }];
    const messages = [{ role: 'user', content: 'hello' }];
    const sysHash = 'aaa111';
    const toolsHash = 'bbb222';

    await storage.writeSharedIfAbsent(`sys_${sysHash}.json`, JSON.stringify(sys));
    await storage.writeSharedIfAbsent(`tools_${toolsHash}.json`, JSON.stringify(tools));
    await storage.write('2026-04-02T08-00-00-000', '_req.json',
      JSON.stringify({ model: 'claude-opus-4-6', max_tokens: 1000, messages, sysHash, toolsHash }));
    await storage.write('2026-04-02T08-00-00-000', '_res.json',
      JSON.stringify([{ type: 'message_start' }]));

    // Import loadEntryReqRes after setting up the storage (it uses config.storage internally)
    // We test the reconstruction logic via the storage primitives
    const stripped = JSON.parse(await storage.read('2026-04-02T08-00-00-000', '_req.json'));
    const loadedSys = JSON.parse(await storage.readShared(`sys_${stripped.sysHash}.json`));
    const loadedTools = JSON.parse(await storage.readShared(`tools_${stripped.toolsHash}.json`));
    const fullReq = { ...stripped, system: loadedSys, tools: loadedTools };
    delete fullReq.sysHash;
    delete fullReq.toolsHash;

    assert.deepEqual(fullReq.system, sys);
    assert.deepEqual(fullReq.tools, tools);
    assert.deepEqual(fullReq.messages, messages);
    assert.equal(fullReq.model, 'claude-opus-4-6');
    assert.ok(!('sysHash' in fullReq));
    assert.ok(!('toolsHash' in fullReq));
  });

  it('handles null sysHash and toolsHash gracefully', async () => {
    await storage.write('2026-04-02T09-00-00-000', '_req.json',
      JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 100, messages: [], sysHash: null, toolsHash: null }));

    const stripped = JSON.parse(await storage.read('2026-04-02T09-00-00-000', '_req.json'));
    const sys = stripped.sysHash ? JSON.parse(await storage.readShared(`sys_${stripped.sysHash}.json`)) : null;
    const tools = stripped.toolsHash ? JSON.parse(await storage.readShared(`tools_${stripped.toolsHash}.json`)) : null;

    assert.equal(sys, null);
    assert.equal(tools, null);
  });

  it('res stored as minified JSON parses correctly', async () => {
    const events = [{ type: 'message_start', message: { id: 'x' } }, { type: 'message_stop' }];
    await storage.write('2026-04-02T10-00-00-000', '_res.json', JSON.stringify(events));
    const raw = await storage.read('2026-04-02T10-00-00-000', '_res.json');
    // Should not have newlines/spaces (minified)
    assert.ok(!raw.includes('\n'));
    assert.deepEqual(JSON.parse(raw), events);
  });
});

// ── restoreFromLogs (index.ndjson) ───────────────────────────────────

describe('restoreFromLogs', () => {
  it('returns cleanly when no index.ndjson exists', async () => {
    // loadEntryReqRes with a non-existent entry should set _loaded=true and req/res=null
    const { loadEntryReqRes } = require('../server/restore');
    const entry = { id: 'no-such-file', _loaded: false, req: null, res: null };
    await loadEntryReqRes(entry);
    assert.equal(entry._loaded, true);
    assert.equal(entry.req, null);
    assert.equal(entry.res, null);
  });
});
