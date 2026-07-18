'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Set isolated CCXRAY_HOME before requiring store
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-import-test-'));
process.env.CCXRAY_HOME = tmpHome;
fs.mkdirSync(path.join(tmpHome, 'logs'), { recursive: true });
fs.writeFileSync(path.join(tmpHome, 'logs', 'index.ndjson'), '');

const store = require('../server/store');
const { scanAndImport, parseSessionFile, slugToProject, tsToId } = require('../server/importer');

function makeLine(type, extra = {}) {
  const base = {
    type,
    uuid: `uuid-${Math.random().toString(36).slice(2)}`,
    parentUuid: 'parent-1',
    timestamp: '2026-07-15T10:30:00.000Z',
    sessionId: 'test-session-1',
    cwd: '/tmp/test-project',
  };
  return JSON.stringify({ ...base, ...extra });
}

function makeAssistant(opts = {}) {
  return makeLine('assistant', {
    timestamp: opts.timestamp || '2026-07-15T10:30:00.000Z',
    message: {
      model: opts.model || 'claude-sonnet-4-5-20250514',
      role: 'assistant',
      content: [{ type: 'text', text: opts.text || 'Hello' }],
      stop_reason: opts.stop_reason || 'end_turn',
      usage: {
        input_tokens: opts.input ?? 5000,
        output_tokens: opts.output ?? 500,
        cache_read_input_tokens: opts.cacheRead ?? 1000,
        cache_creation_input_tokens: opts.cacheCreate ?? 2000,
        cache_creation: { ephemeral_1h_input_tokens: opts.cacheCreate ?? 2000, ephemeral_5m_input_tokens: 0 },
      },
    },
    ...opts.extra,
  });
}

function makeUser(text = 'Hello world') {
  return makeLine('user', {
    timestamp: '2026-07-15T10:29:50.000Z',
    message: { role: 'user', content: [{ type: 'text', text }] },
  });
}

describe('importer', () => {
  let importDir;

  beforeEach(() => {
    store.entries.length = 0;
    store.entryIndex.clear();
    importDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-import-'));
    process.env.CCXRAY_IMPORT_HOMES = importDir;
  });

  afterEach(() => {
    delete process.env.CCXRAY_IMPORT_HOMES;
    fs.rmSync(importDir, { recursive: true, force: true });
  });

  describe('tsToId', () => {
    it('converts ISO timestamp to ID format', () => {
      assert.strictEqual(tsToId('2026-07-15T10:30:00.123Z'), '2026-07-15T10-30-00-12');
    });

    it('returns null for invalid timestamps', () => {
      assert.strictEqual(tsToId('invalid'), null);
    });
  });

  describe('slugToProject', () => {
    it('converts directory slug to cwd path', () => {
      assert.strictEqual(slugToProject('-Users-justinlee-dev-ccxray'), '/Users/justinlee/dev/ccxray');
    });
  });

  describe('parseSessionFile', () => {
    it('extracts entries from JSONL with usage', async () => {
      const sessionDir = path.join(importDir, 'test-project');
      fs.mkdirSync(sessionDir, { recursive: true });
      const file = path.join(sessionDir, 'sess-1.jsonl');
      const lines = [
        makeUser('What is 2+2?'),
        makeAssistant({ timestamp: '2026-07-15T10:30:05.000Z', input: 3000, output: 200 }),
      ];
      fs.writeFileSync(file, lines.join('\n'));

      const entries = await parseSessionFile(file, 'test-project');
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0].imported, true);
      assert.strictEqual(entries[0].importSource, 'claude-code');
      assert.strictEqual(entries[0].title, 'What is 2+2?');
      assert.strictEqual(entries[0].tokens.input, 3000);
      assert.strictEqual(entries[0].tokens.output, 200);
      assert.strictEqual(entries[0].model, 'claude-sonnet-4-5-20250514');
      assert.strictEqual(entries[0].stopReason, 'end_turn');
    });

    it('skips entries with zero usage', async () => {
      const sessionDir = path.join(importDir, 'test-project');
      fs.mkdirSync(sessionDir, { recursive: true });
      const file = path.join(sessionDir, 'sess-2.jsonl');
      const lines = [
        makeAssistant({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }),
      ];
      fs.writeFileSync(file, lines.join('\n'));

      const entries = await parseSessionFile(file, 'test-project');
      assert.strictEqual(entries.length, 0);
    });

    it('skips non-assistant lines', async () => {
      const sessionDir = path.join(importDir, 'test-project');
      fs.mkdirSync(sessionDir, { recursive: true });
      const file = path.join(sessionDir, 'sess-3.jsonl');
      const lines = [
        makeLine('mode', { mode: 'normal' }),
        makeLine('system', { content: 'system msg' }),
        makeUser('hi'),
      ];
      fs.writeFileSync(file, lines.join('\n'));

      const entries = await parseSessionFile(file, 'test-project');
      assert.strictEqual(entries.length, 0);
    });
  });

  describe('scanAndImport', () => {
    it('imports entries from project directories', async () => {
      const projectDir = path.join(importDir, '-tmp-myproject');
      fs.mkdirSync(projectDir, { recursive: true });
      const file = path.join(projectDir, 'session-abc.jsonl');
      fs.writeFileSync(file, [
        makeUser('Test prompt'),
        makeAssistant({ timestamp: '2026-07-15T10:31:00.000Z' }),
      ].join('\n'));

      const result = await scanAndImport();
      assert.strictEqual(result.imported, 1);
      assert.strictEqual(store.entries.length, 1);
      assert.strictEqual(store.entryIndex.size, 1);
      assert.strictEqual(store.entries[0].imported, true);
      assert.strictEqual(store.entries[0].sessionId, 'session-abc');
    });

    it('deduplicates on second scan', async () => {
      const projectDir = path.join(importDir, '-tmp-myproject');
      fs.mkdirSync(projectDir, { recursive: true });
      const file = path.join(projectDir, 'session-abc.jsonl');
      fs.writeFileSync(file, [
        makeUser('Test'),
        makeAssistant({ timestamp: '2026-07-15T10:32:00.000Z' }),
      ].join('\n'));

      await scanAndImport();
      assert.strictEqual(store.entries.length, 1);

      const result2 = await scanAndImport();
      assert.strictEqual(result2.imported, 0);
      assert.strictEqual(result2.skipped, 1);
      assert.strictEqual(store.entries.length, 1);
    });

    it('respects CCXRAY_IMPORT_DISABLE', async () => {
      process.env.CCXRAY_IMPORT_DISABLE = '1';
      const projectDir = path.join(importDir, '-tmp-myproject');
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'sess.jsonl'), makeAssistant());

      const result = await scanAndImport();
      assert.strictEqual(result.imported, 0);
      assert.strictEqual(store.entries.length, 0);
      delete process.env.CCXRAY_IMPORT_DISABLE;
    });
  });
});
