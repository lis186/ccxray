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
const config = require('../server/config');
const sessionIdx = require('../server/session-index');
const { scanAndImport, parseSessionFile, parseCodexSessionFile, slugToProject, tsToId } = require('../server/importer');

const INDEX_PATH = path.join(tmpHome, 'logs', 'index.ndjson');

// Imports bypass store.entries (#6): they land in index.ndjson + session
// index only. Tests assert against those, and each test resets both because
// scanAndImport dedups durably against index.ndjson ids.
function readIndexLines() {
  return fs.readFileSync(INDEX_PATH, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function resetDurableState() {
  fs.writeFileSync(INDEX_PATH, '');
  sessionIdx.rebuildFromIndexContent('');
}

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
  let codexImportDir;

  beforeEach(() => {
    store.entries.length = 0;
    store.entryIndex.clear();
    resetDurableState();
    importDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-import-'));
    process.env.CCXRAY_IMPORT_HOMES = importDir;
    // scanAndImport() also scans Codex homes — isolate it here too, or it
    // falls back to the real ~/.codex*/sessions and imports actual data.
    codexImportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-import-codex-'));
    process.env.CCXRAY_IMPORT_CODEX_HOMES = codexImportDir;
  });

  afterEach(() => {
    delete process.env.CCXRAY_IMPORT_HOMES;
    delete process.env.CCXRAY_IMPORT_CODEX_HOMES;
    fs.rmSync(importDir, { recursive: true, force: true });
    fs.rmSync(codexImportDir, { recursive: true, force: true });
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
      await config.storage.drain();
      assert.strictEqual(result.imported, 1);
      // Imports bypass store.entries — they land in index.ndjson + session index
      assert.strictEqual(store.entries.length, 0);
      assert.strictEqual(store.entryIndex.size, 0);
      const lines = readIndexLines();
      assert.strictEqual(lines.length, 1);
      assert.strictEqual(lines[0].imported, true);
      assert.strictEqual(lines[0].sessionId, 'session-abc');
      const sess = sessionIdx.getAll().find(s => s.sid === 'session-abc');
      assert.ok(sess, 'session appears in session index');
      assert.strictEqual(sess.count, 1);
    });

    it('deduplicates on second scan', async () => {
      const projectDir = path.join(importDir, '-tmp-myproject');
      fs.mkdirSync(projectDir, { recursive: true });
      const file = path.join(projectDir, 'session-abc.jsonl');
      fs.writeFileSync(file, [
        makeUser('Test'),
        makeAssistant({ timestamp: '2026-07-15T10:32:00.000Z' }),
      ].join('\n'));

      const result1 = await scanAndImport();
      await config.storage.drain();
      assert.strictEqual(result1.imported, 1);

      const result2 = await scanAndImport();
      await config.storage.drain();
      assert.strictEqual(result2.imported, 0);
      assert.strictEqual(result2.skipped, 1);
      assert.strictEqual(readIndexLines().length, 1);
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

// Codex JSONL lines: {timestamp, type, payload}. session_meta carries
// session_id/cwd directly on payload; token_count is nested inside an
// event_msg line as payload.type === 'token_count'. Verified against real
// ~/.codex*/sessions/**/*.jsonl data — see server/cost-worker.js's
// processCodexFile, the reference implementation this mirrors.
function makeCodexSessionMeta(opts = {}) {
  return JSON.stringify({
    timestamp: opts.timestamp || '2026-07-15T10:30:00.000Z',
    type: 'session_meta',
    payload: {
      session_id: opts.sessionId || 'codex-sess-1',
      cwd: opts.cwd || '/tmp/codex-project',
      originator: 'codex_exec',
    },
  });
}

function makeCodexTurnContext(opts = {}) {
  return JSON.stringify({
    timestamp: opts.timestamp || '2026-07-15T10:30:01.000Z',
    type: 'turn_context',
    payload: {
      turn_id: opts.turnId || 'turn-1',
      cwd: opts.cwd || '/tmp/codex-project',
      model: opts.model || 'gpt-5.5',
    },
  });
}

function makeCodexTokenCount(opts = {}) {
  return JSON.stringify({
    timestamp: opts.timestamp || '2026-07-15T10:30:05.000Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        model_context_window: opts.contextWindow ?? 258400,
        last_token_usage: {
          input_tokens: opts.input ?? 17172,
          cached_input_tokens: opts.cachedInput ?? 4992,
          output_tokens: opts.output ?? 35,
          reasoning_output_tokens: opts.reasoningOutput ?? 28,
          total_tokens: opts.total ?? 17207,
        },
      },
    },
  });
}

describe('codex importer', () => {
  let codexDir;
  let claudeHomeDir;

  beforeEach(() => {
    store.entries.length = 0;
    store.entryIndex.clear();
    resetDurableState();
    codexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-codex-import-'));
    claudeHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-empty-claude-'));
    process.env.CCXRAY_IMPORT_CODEX_HOMES = codexDir;
    process.env.CCXRAY_IMPORT_HOMES = claudeHomeDir;
  });

  afterEach(() => {
    delete process.env.CCXRAY_IMPORT_CODEX_HOMES;
    delete process.env.CCXRAY_IMPORT_HOMES;
    fs.rmSync(codexDir, { recursive: true, force: true });
    fs.rmSync(claudeHomeDir, { recursive: true, force: true });
  });

  describe('parseCodexSessionFile', () => {
    it('extracts entries from token_count events', async () => {
      const sessDir = path.join(codexDir, '2026', '07', '15');
      fs.mkdirSync(sessDir, { recursive: true });
      const file = path.join(sessDir, 'rollout-2026-07-15T10-30-00-abc.jsonl');
      fs.writeFileSync(file, [
        makeCodexSessionMeta({ sessionId: 'codex-sess-1', cwd: '/tmp/codex-project' }),
        makeCodexTurnContext({ model: 'gpt-5.5' }),
        makeCodexTokenCount({ timestamp: '2026-07-15T10:30:05.000Z' }),
      ].join('\n'));

      const entries = await parseCodexSessionFile(file);
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0].imported, true);
      assert.strictEqual(entries[0].importSource, 'codex');
      assert.strictEqual(entries[0].provider, 'openai');
      assert.strictEqual(entries[0].sessionId, 'codex-sess-1');
      assert.strictEqual(entries[0].cwd, '/tmp/codex-project');
      assert.strictEqual(entries[0].model, 'gpt-5.5');
      assert.strictEqual(entries[0].url, '/v1/responses');
      assert.strictEqual(entries[0].tokens.input, 17172 - 4992);
      assert.strictEqual(entries[0].tokens.cacheRead, 4992);
      assert.strictEqual(entries[0].tokens.output, 35 + 28);
      assert.strictEqual(entries[0].tokens.contextWindow, 258400);
    });

    it('skips token_count events with zero usage', async () => {
      const sessDir = path.join(codexDir, '2026', '07', '15');
      fs.mkdirSync(sessDir, { recursive: true });
      const file = path.join(sessDir, 'rollout-zero.jsonl');
      fs.writeFileSync(file, [
        makeCodexSessionMeta(),
        makeCodexTokenCount({ input: 0, cachedInput: 0, output: 0, reasoningOutput: 0, total: 0 }),
      ].join('\n'));

      const entries = await parseCodexSessionFile(file);
      assert.strictEqual(entries.length, 0);
    });
  });

  describe('scanAndImport (codex)', () => {
    it('imports codex entries alongside claude entries', async () => {
      const sessDir = path.join(codexDir, '2026', '07', '15');
      fs.mkdirSync(sessDir, { recursive: true });
      fs.writeFileSync(path.join(sessDir, 'rollout-1.jsonl'), [
        makeCodexSessionMeta({ sessionId: 'codex-sess-2' }),
        makeCodexTurnContext({ model: 'gpt-5.5' }),
        makeCodexTokenCount({ timestamp: '2026-07-15T11:00:00.000Z' }),
      ].join('\n'));

      const claudeProjectDir = path.join(claudeHomeDir, '-tmp-myproject');
      fs.mkdirSync(claudeProjectDir, { recursive: true });
      fs.writeFileSync(path.join(claudeProjectDir, 'session-xyz.jsonl'), [
        makeUser('Test'),
        makeAssistant({ timestamp: '2026-07-15T11:05:00.000Z' }),
      ].join('\n'));

      const result = await scanAndImport();
      await config.storage.drain();
      assert.strictEqual(result.imported, 2);
      assert.strictEqual(store.entries.length, 0);

      const lines = readIndexLines();
      assert.strictEqual(lines.length, 2);
      const codexEntry = lines.find(e => e.importSource === 'codex');
      assert.ok(codexEntry);
      assert.strictEqual(codexEntry.provider, 'openai');
      const claudeEntry = lines.find(e => e.importSource === 'claude-code');
      assert.ok(claudeEntry);
      assert.strictEqual(claudeEntry.provider, 'anthropic');
    });

    it('deduplicates codex entries on second scan', async () => {
      const sessDir = path.join(codexDir, '2026', '07', '15');
      fs.mkdirSync(sessDir, { recursive: true });
      fs.writeFileSync(path.join(sessDir, 'rollout-dedup.jsonl'), [
        makeCodexSessionMeta({ sessionId: 'codex-sess-3' }),
        makeCodexTurnContext({ model: 'gpt-5.5' }),
        makeCodexTokenCount({ timestamp: '2026-07-15T12:00:00.000Z' }),
      ].join('\n'));

      const result1 = await scanAndImport();
      await config.storage.drain();
      assert.strictEqual(result1.imported, 1);

      const result2 = await scanAndImport();
      await config.storage.drain();
      assert.strictEqual(result2.imported, 0);
      assert.strictEqual(result2.skipped, 1);
      assert.strictEqual(readIndexLines().length, 1);
    });
  });
});
