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
  const content = opts.content || [{ type: 'text', text: opts.text || 'Hello' }];
  return makeLine('assistant', {
    timestamp: opts.timestamp || '2026-07-15T10:30:00.000Z',
    message: {
      id: opts.msgId,
      model: opts.model || 'claude-sonnet-4-5-20250514',
      role: 'assistant',
      content,
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

function makeUserWithToolResults(results, opts = {}) {
  const content = results.map(r => ({
    type: 'tool_result',
    tool_use_id: r.tool_use_id,
    content: r.content || 'ok',
    ...('is_error' in r ? { is_error: r.is_error } : {}),
  }));
  return makeLine('user', {
    timestamp: opts.timestamp || '2026-07-15T10:29:55.000Z',
    message: { role: 'user', content },
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

    it('carries the upstream message id as responseId for #329/#333 merge', async () => {
      const sessionDir = path.join(importDir, 'test-project');
      fs.mkdirSync(sessionDir, { recursive: true });
      const file = path.join(sessionDir, 'sess-rid.jsonl');
      fs.writeFileSync(file, [
        makeUser('hi'),
        makeAssistant({ timestamp: '2026-07-15T10:30:05.000Z', msgId: 'msg_01IMPORT' }),
      ].join('\n'));

      const entries = await parseSessionFile(file, 'test-project');
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0].responseId, 'msg_01IMPORT');
    });

    it('sets responseId null when the transcript line has no message id', async () => {
      const sessionDir = path.join(importDir, 'test-project');
      fs.mkdirSync(sessionDir, { recursive: true });
      const file = path.join(sessionDir, 'sess-norid.jsonl');
      fs.writeFileSync(file, [makeUser('hi'), makeAssistant({ timestamp: '2026-07-15T10:31:05.000Z' })].join('\n'));

      const entries = await parseSessionFile(file, 'test-project');
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0].responseId, null);
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

    it('#500: extracts turnToolCallIds from assistant tool_use blocks', async () => {
      const sessionDir = path.join(importDir, 'test-project');
      fs.mkdirSync(sessionDir, { recursive: true });
      const file = path.join(sessionDir, 'sess-tool-calls.jsonl');
      fs.writeFileSync(file, [
        makeUser('run a command'),
        makeAssistant({
          timestamp: '2026-07-15T10:30:05.000Z',
          content: [
            { type: 'text', text: 'Running...' },
            { type: 'tool_use', id: 'toolu_01A', name: 'Bash', input: { command: 'ls' } },
            { type: 'tool_use', id: 'toolu_01B', name: 'Read', input: { path: '/tmp/x' } },
          ],
        }),
      ].join('\n'));

      const entries = await parseSessionFile(file, 'test-project');
      assert.strictEqual(entries.length, 1);
      assert.deepStrictEqual(entries[0].turnToolCallIds, { toolu_01A: 'Bash', toolu_01B: 'Read' });
    });

    it('#500: extracts turnToolResults from user tool_result (is_error: true)', async () => {
      const sessionDir = path.join(importDir, 'test-project');
      fs.mkdirSync(sessionDir, { recursive: true });
      const file = path.join(sessionDir, 'sess-tool-fail.jsonl');
      fs.writeFileSync(file, [
        makeUserWithToolResults([{ tool_use_id: 'toolu_01A', is_error: true, content: 'command failed' }]),
        makeAssistant({ timestamp: '2026-07-15T10:30:05.000Z' }),
      ].join('\n'));

      const entries = await parseSessionFile(file, 'test-project');
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0].turnToolResults.length, 1);
      assert.strictEqual(entries[0].turnToolResults[0].callId, 'toolu_01A');
      assert.strictEqual(entries[0].turnToolResults[0].toolFail, true);
      assert.strictEqual(entries[0].turnToolResults[0].eligible, true);
    });

    it('#500: extracts turnToolResults from user tool_result (no is_error)', async () => {
      const sessionDir = path.join(importDir, 'test-project');
      fs.mkdirSync(sessionDir, { recursive: true });
      const file = path.join(sessionDir, 'sess-tool-ok.jsonl');
      fs.writeFileSync(file, [
        makeUserWithToolResults([{ tool_use_id: 'toolu_01A', content: 'success' }]),
        makeAssistant({ timestamp: '2026-07-15T10:30:05.000Z' }),
      ].join('\n'));

      const entries = await parseSessionFile(file, 'test-project');
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0].turnToolResults.length, 1);
      assert.strictEqual(entries[0].turnToolResults[0].callId, 'toolu_01A');
      assert.strictEqual(entries[0].turnToolResults[0].toolFail, undefined);
    });

    it('#500: extracts turnToolResults from user tool_result (is_error: false)', async () => {
      const sessionDir = path.join(importDir, 'test-project');
      fs.mkdirSync(sessionDir, { recursive: true });
      const file = path.join(sessionDir, 'sess-tool-ok-explicit.jsonl');
      fs.writeFileSync(file, [
        makeUserWithToolResults([{ tool_use_id: 'toolu_01A', is_error: false, content: 'success' }]),
        makeAssistant({ timestamp: '2026-07-15T10:30:05.000Z' }),
      ].join('\n'));

      const entries = await parseSessionFile(file, 'test-project');
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0].turnToolResults.length, 1);
      assert.strictEqual(entries[0].turnToolResults[0].callId, 'toolu_01A');
      assert.strictEqual(entries[0].turnToolResults[0].toolFail, false);
      assert.strictEqual(entries[0].turnToolResults[0].eligible, true);
    });

    it('#500: assistant with no tool_use → turnToolCallIds is {} (not undefined)', async () => {
      const sessionDir = path.join(importDir, 'test-project');
      fs.mkdirSync(sessionDir, { recursive: true });
      const file = path.join(sessionDir, 'sess-no-tools.jsonl');
      fs.writeFileSync(file, [
        makeUser('hello'),
        makeAssistant({ timestamp: '2026-07-15T10:30:05.000Z' }),
      ].join('\n'));

      const entries = await parseSessionFile(file, 'test-project');
      assert.strictEqual(entries.length, 1);
      assert.deepStrictEqual(entries[0].turnToolCallIds, {});
      assert.ok(entries[0].turnToolCallIds !== undefined);
    });

    it('#500: merges tool evidence across duplicate assistant lines (same msg.id)', async () => {
      const sessionDir = path.join(importDir, 'test-project');
      fs.mkdirSync(sessionDir, { recursive: true });
      const file = path.join(sessionDir, 'sess-merge.jsonl');
      // Claude Code writes one assistant line per content block, all sharing msg.id
      const msgId = 'msg_01MERGE';
      fs.writeFileSync(file, [
        makeUserWithToolResults([{ tool_use_id: 'toolu_prev', is_error: true }]),
        // First line: text block
        makeAssistant({ timestamp: '2026-07-15T10:30:05.000Z', msgId, text: 'Let me check...' }),
        // Second line: tool_use block (same msg.id, different content)
        makeAssistant({
          timestamp: '2026-07-15T10:30:05.100Z',
          msgId,
          content: [{ type: 'tool_use', id: 'toolu_01C', name: 'Bash', input: { command: 'ls' } }],
        }),
      ].join('\n'));

      const entries = await parseSessionFile(file, 'test-project');
      assert.strictEqual(entries.length, 1);
      // Tool call from the second line should be merged in
      assert.deepStrictEqual(entries[0].turnToolCallIds, { toolu_01C: 'Bash' });
      // Tool results from the first line should be preserved (not overwritten)
      assert.strictEqual(entries[0].turnToolResults.length, 1);
      assert.strictEqual(entries[0].turnToolResults[0].callId, 'toolu_prev');
      assert.strictEqual(entries[0].turnToolResults[0].toolFail, true);
    });

    it('#500: no preceding user tool_result → turnToolResults is [] (not undefined)', async () => {
      const sessionDir = path.join(importDir, 'test-project');
      fs.mkdirSync(sessionDir, { recursive: true });
      const file = path.join(sessionDir, 'sess-no-results.jsonl');
      fs.writeFileSync(file, [
        makeUser('hello'),
        makeAssistant({ timestamp: '2026-07-15T10:30:05.000Z' }),
      ].join('\n'));

      const entries = await parseSessionFile(file, 'test-project');
      assert.strictEqual(entries.length, 1);
      assert.deepStrictEqual(entries[0].turnToolResults, []);
      assert.ok(entries[0].turnToolResults !== undefined);
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
      // #384: maxContext must be written to the entry (was missing before fix)
      assert.strictEqual(entries[0].maxContext, 258400);
    });

    it('#384: writes maxContext from model_context_window', async () => {
      const sessDir = path.join(codexDir, '2026', '07', '15');
      fs.mkdirSync(sessDir, { recursive: true });
      const file = path.join(sessDir, 'rollout-ctx.jsonl');
      fs.writeFileSync(file, [
        makeCodexSessionMeta({ sessionId: 'codex-ctx-test' }),
        makeCodexTurnContext({ model: 'gpt-5-codex' }),
        makeCodexTokenCount({ timestamp: '2026-07-15T10:30:05.000Z', contextWindow: 400000 }),
      ].join('\n'));

      const entries = await parseCodexSessionFile(file);
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0].maxContext, 400000, 'maxContext should come from model_context_window');
    });

    it('#384: uses CODEX_CONTEXT_WINDOW fallback when model_context_window absent', async () => {
      const sessDir = path.join(codexDir, '2026', '07', '15');
      fs.mkdirSync(sessDir, { recursive: true });
      const file = path.join(sessDir, 'rollout-no-ctx.jsonl');
      // Build a token_count line without model_context_window
      const line = JSON.stringify({
        timestamp: '2026-07-15T10:30:05.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: {
              input_tokens: 5000,
              cached_input_tokens: 1000,
              output_tokens: 100,
              reasoning_output_tokens: 0,
              total_tokens: 5100,
            },
          },
        },
      });
      fs.writeFileSync(file, [
        makeCodexSessionMeta({ sessionId: 'codex-no-ctx' }),
        line,
      ].join('\n'));

      const entries = await parseCodexSessionFile(file);
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0].maxContext, 400000, 'should fall back to CODEX_CONTEXT_WINDOW');
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

    it('#500: custom_tool_call then token_count → turnToolCallIds populated', async () => {
      const sessDir = path.join(codexDir, '2026', '07', '15');
      fs.mkdirSync(sessDir, { recursive: true });
      const file = path.join(sessDir, 'rollout-tool-call.jsonl');
      fs.writeFileSync(file, [
        makeCodexSessionMeta({ sessionId: 'codex-tool-1' }),
        makeCodexTurnContext({ model: 'gpt-5.5' }),
        JSON.stringify({ timestamp: '2026-07-15T10:30:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'call_AAA', name: 'exec_command' } }),
        JSON.stringify({ timestamp: '2026-07-15T10:30:03.000Z', type: 'response_item', payload: { type: 'function_call', call_id: 'call_BBB', name: 'read_mcp_resource' } }),
        makeCodexTokenCount({ timestamp: '2026-07-15T10:30:05.000Z' }),
      ].join('\n'));

      const entries = await parseCodexSessionFile(file);
      assert.strictEqual(entries.length, 1);
      assert.deepStrictEqual(entries[0].turnToolCallIds, { call_AAA: 'Bash', call_BBB: 'Read' });
    });

    it('#500: custom_tool_call_output then token_count → turnToolResults populated', async () => {
      const sessDir = path.join(codexDir, '2026', '07', '15');
      fs.mkdirSync(sessDir, { recursive: true });
      const file = path.join(sessDir, 'rollout-tool-result.jsonl');
      const output = [{ type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\nhello\n' }];
      fs.writeFileSync(file, [
        makeCodexSessionMeta({ sessionId: 'codex-tool-2' }),
        makeCodexTurnContext({ model: 'gpt-5.5' }),
        JSON.stringify({ timestamp: '2026-07-15T10:30:03.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call_AAA', output } }),
        makeCodexTokenCount({ timestamp: '2026-07-15T10:30:05.000Z' }),
      ].join('\n'));

      const entries = await parseCodexSessionFile(file);
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0].turnToolResults.length, 1);
      assert.strictEqual(entries[0].turnToolResults[0].callId, 'call_AAA');
      assert.strictEqual(entries[0].turnToolResults[0].eligible, true);
    });

    it('#500: multiple tool calls/outputs accumulated correctly', async () => {
      const sessDir = path.join(codexDir, '2026', '07', '15');
      fs.mkdirSync(sessDir, { recursive: true });
      const file = path.join(sessDir, 'rollout-tool-multi.jsonl');
      const output = [{ type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\nok\n' }];
      fs.writeFileSync(file, [
        makeCodexSessionMeta({ sessionId: 'codex-tool-3' }),
        makeCodexTurnContext({ model: 'gpt-5.5' }),
        JSON.stringify({ timestamp: '2026-07-15T10:30:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'call_1', name: 'exec' } }),
        JSON.stringify({ timestamp: '2026-07-15T10:30:02.500Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call_1', output } }),
        JSON.stringify({ timestamp: '2026-07-15T10:30:03.000Z', type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'call_2', name: 'apply_patch' } }),
        JSON.stringify({ timestamp: '2026-07-15T10:30:03.500Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call_2', output } }),
        makeCodexTokenCount({ timestamp: '2026-07-15T10:30:05.000Z' }),
      ].join('\n'));

      const entries = await parseCodexSessionFile(file);
      assert.strictEqual(entries.length, 1);
      assert.deepStrictEqual(entries[0].turnToolCallIds, { call_1: 'Bash', call_2: 'Edit' });
      assert.strictEqual(entries[0].turnToolResults.length, 2);
      assert.strictEqual(entries[0].turnToolResults[0].callId, 'call_1');
      assert.strictEqual(entries[0].turnToolResults[1].callId, 'call_2');
    });

    it('#500: no tool lines before token_count → turnToolCallIds {}, turnToolResults []', async () => {
      const sessDir = path.join(codexDir, '2026', '07', '15');
      fs.mkdirSync(sessDir, { recursive: true });
      const file = path.join(sessDir, 'rollout-no-tools.jsonl');
      fs.writeFileSync(file, [
        makeCodexSessionMeta({ sessionId: 'codex-no-tools' }),
        makeCodexTurnContext({ model: 'gpt-5.5' }),
        makeCodexTokenCount({ timestamp: '2026-07-15T10:30:05.000Z' }),
      ].join('\n'));

      const entries = await parseCodexSessionFile(file);
      assert.strictEqual(entries.length, 1);
      assert.deepStrictEqual(entries[0].turnToolCallIds, {});
      assert.deepStrictEqual(entries[0].turnToolResults, []);
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
