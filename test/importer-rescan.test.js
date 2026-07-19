'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Isolated CCXRAY_HOME before requiring config/store (docs/testing.md)
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-rescan-test-'));
process.env.CCXRAY_HOME = tmpHome;
fs.mkdirSync(path.join(tmpHome, 'logs'), { recursive: true });
fs.writeFileSync(path.join(tmpHome, 'logs', 'index.ndjson'), '');

const config = require('../server/config');
const sessionIdx = require('../server/session-index');
const { scanAndImport } = require('../server/importer');

function makeLine(type, extra = {}) {
  return JSON.stringify({
    type,
    uuid: `uuid-${Math.random().toString(36).slice(2)}`,
    parentUuid: 'parent-1',
    sessionId: 'rescan-session-1',
    cwd: '/tmp/rescan-project',
    ...extra,
  });
}

function makeAssistant(timestamp) {
  return makeLine('assistant', {
    timestamp,
    message: {
      model: 'claude-sonnet-4-5-20250514',
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5000, output_tokens: 500, cache_read_input_tokens: 1000, cache_creation_input_tokens: 2000 },
    },
  });
}

function indexLineCount() {
  const raw = fs.readFileSync(path.join(tmpHome, 'logs', 'index.ndjson'), 'utf8');
  return raw.split('\n').filter(Boolean).length;
}

describe('importer rescan idempotency', () => {
  let importDir, codexImportDir;

  before(() => {
    importDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-rescan-import-'));
    codexImportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-rescan-codex-'));
    process.env.CCXRAY_IMPORT_HOMES = importDir;
    process.env.CCXRAY_IMPORT_CODEX_HOMES = codexImportDir;

    const sessionDir = path.join(importDir, 'rescan-project');
    fs.mkdirSync(sessionDir, { recursive: true });
    // importer derives sessionId from the transcript filename (importer.js)
    fs.writeFileSync(path.join(sessionDir, 'rescan-session-1.jsonl'), [
      makeLine('user', { timestamp: '2026-07-18T10:29:50.000Z', message: { role: 'user', content: [{ type: 'text', text: 'q1' }] } }),
      makeAssistant('2026-07-18T10:30:00.000Z'),
      makeAssistant('2026-07-18T10:31:00.000Z'),
      makeAssistant('2026-07-18T10:32:00.000Z'),
    ].join('\n'));
  });

  after(() => {
    delete process.env.CCXRAY_IMPORT_HOMES;
    delete process.env.CCXRAY_IMPORT_CODEX_HOMES;
    fs.rmSync(importDir, { recursive: true, force: true });
    fs.rmSync(codexImportDir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('second scan imports nothing and leaves index.ndjson + session index unchanged', async () => {
    const first = await scanAndImport();
    await config.storage.drain();
    assert.strictEqual(first.imported, 3, 'first scan imports the 3 turns');
    assert.strictEqual(indexLineCount(), 3, 'index.ndjson has one line per imported turn');
    const sessAfterFirst = sessionIdx.getAll().find(s => s.sid === 'rescan-session-1');
    assert.ok(sessAfterFirst, 'session appears in session index');
    assert.strictEqual(sessAfterFirst.count, 3, 'session index counts 3 turns');

    // Rescan in the same process: imported entries are NOT in store.entries
    // (importer no longer pushes there), so dedup must come from a durable
    // source (index.ndjson ids). A non-idempotent rescan re-appends every
    // line and double-counts the session index — unbounded index growth on
    // every startup/rescan cycle.
    const second = await scanAndImport();
    await config.storage.drain();
    assert.strictEqual(second.imported, 0, 'rescan imports nothing');
    assert.strictEqual(second.skipped, 3, 'rescan skips all existing turns');
    assert.strictEqual(indexLineCount(), 3, 'index.ndjson unchanged after rescan');
    const sessAfterSecond = sessionIdx.getAll().find(s => s.sid === 'rescan-session-1');
    assert.strictEqual(sessAfterSecond.count, 3, 'session index count unchanged after rescan');
  });
});
