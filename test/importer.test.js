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
const {
  scanAndImport, parseSessionFile, parseCodexSessionFile,
  discoverHomes, discoverCodexHomes, slugToProject, tsToId,
} = require('../server/importer');
// The importer now derives maxContext, so these assertions depend on the LiteLLM
// capability table. It is read from a package-relative pricing-cache.json, which
// CCXRAY_HOME does not isolate — pin it (docs/testing.md, ADR 0015 R4 class).
require('../server/pricing').__setContextTableForTests(null);

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
      assert.strictEqual(entries[0].contextUsageKnown, true);
    });

    it('marks an explicit zero context numerator as known', async () => {
      const sessionDir = path.join(importDir, 'test-project');
      fs.mkdirSync(sessionDir, { recursive: true });
      const file = path.join(sessionDir, 'sess-zero-context.jsonl');
      fs.writeFileSync(file, [
        makeAssistant({ input: 0, output: 10, cacheRead: 0, cacheCreate: 0 }),
      ].join('\n'));

      const entries = await parseSessionFile(file, 'test-project');
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0].contextUsageKnown, true);
      assert.strictEqual(entries[0].usage.input_tokens, 0);
    });

    it('keeps output-only transcript usage unknown', async () => {
      const sessionDir = path.join(importDir, 'test-project');
      fs.mkdirSync(sessionDir, { recursive: true });
      const file = path.join(sessionDir, 'sess-output-only.jsonl');
      fs.writeFileSync(file, [
        makeLine('assistant', {
          message: {
            id: 'msg-output-only',
            model: 'claude-sonnet-4-5-20250514',
            role: 'assistant',
            content: [{ type: 'text', text: 'Hello' }],
            stop_reason: 'end_turn',
            usage: { output_tokens: 10 },
          },
        }),
      ].join('\n'));

      const entries = await parseSessionFile(file, 'test-project');
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0].contextUsageKnown, false);
      assert.strictEqual(entries[0].usage.input_tokens, 0);
    });

    it('writes maxContext, and observation alone recovers a window above the default (fail-on-old)', async () => {
      // The Codex importer has written maxContext since #384; the Claude one wrote
      // nothing, so every reader fell back to 200K — a 1M session rendered as
      // phantom context pressure. Claude transcripts declare no window and never
      // record the anthropic-beta header, so the only evidence is the observation.
      const sessionDir = path.join(importDir, 'test-project');
      fs.mkdirSync(sessionDir, { recursive: true });

      const small = path.join(sessionDir, 'sess-window-small.jsonl');
      fs.writeFileSync(small, [
        makeUser('hi'),
        makeAssistant({ timestamp: '2026-07-15T10:31:00.000Z', input: 1000, cacheRead: 1000, cacheCreate: 0 }),
      ].join('\n'));
      const under = await parseSessionFile(small, 'test-project');
      assert.strictEqual(under[0].maxContext, 200_000, 'default window when nothing proves otherwise');
      assert.strictEqual(under[0].tokens.contextWindow, 200_000);

      const big = path.join(sessionDir, 'sess-window-big.jsonl');
      fs.writeFileSync(big, [
        makeUser('hi'),
        makeAssistant({ timestamp: '2026-07-15T10:32:00.000Z', input: 10, cacheRead: 260_000, cacheCreate: 0 }),
      ].join('\n'));
      const over = await parseSessionFile(big, 'test-project');
      assert.strictEqual(over[0].maxContext, 1_000_000, '260K of context cannot fit a 200K window');
      assert.strictEqual(over[0].tokens.contextWindow, 1_000_000);
      assert.ok(over[0].tokens.contextPct < 100, 'context% stops exceeding its own denominator');
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
    it('#603 persists separate positive 1M facts from cost-state and home settings without changing maxContext', async () => {
      const configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-import-1m-home-'));
      const projects = path.join(configHome, 'projects');
      const priorHomes = process.env.CCXRAY_IMPORT_HOMES;
      try {
        process.env.CCXRAY_IMPORT_HOMES = projects;
        fs.mkdirSync(projects, { recursive: true });
        fs.writeFileSync(path.join(configHome, 'settings.json'), JSON.stringify({
          model: 'claude-fable-5[1m]',
        }));

        const costStateDir = path.join(projects, 'cost-state-source');
        fs.mkdirSync(costStateDir, { recursive: true });
        fs.writeFileSync(path.join(costStateDir, 'cost-state-session.jsonl'), [
          makeAssistant({ timestamp: '2026-08-31T10:00:00.000Z', model: 'claude-opus-4-6' }),
          JSON.stringify({ type: 'cost-state', modelUsage: { 'claude-opus-4-6[1m]': { costUSD: 0.01 } } }),
        ].join('\n'));

        const settingsDir = path.join(projects, 'settings-source');
        fs.mkdirSync(settingsDir, { recursive: true });
        fs.writeFileSync(path.join(settingsDir, 'settings-session.jsonl'), [
          makeAssistant({ timestamp: '2026-08-31T10:01:00.000Z', model: 'claude-fable-5' }),
          JSON.stringify({ type: 'cost-state', modelUsage: { 'claude-fable-5': { costUSD: 0.01 } } }),
        ].join('\n'));

        const mismatchDir = path.join(projects, 'mismatch-source');
        fs.mkdirSync(mismatchDir, { recursive: true });
        fs.writeFileSync(path.join(mismatchDir, 'mismatch-session.jsonl'), [
          makeAssistant({ timestamp: '2026-08-31T10:02:00.000Z', model: 'claude-opus-4-6' }),
          JSON.stringify({ type: 'cost-state', modelUsage: { 'claude-fable-5[1m]': { costUSD: 0.01 } } }),
        ].join('\n'));

        const result = await scanAndImport();
        await config.storage.drain();
        assert.equal(result.imported, 3);

        const indexed = new Map(readIndexLines().map(entry => [entry.sessionId, entry]));
        const costState = indexed.get('cost-state-session');
        const settings = indexed.get('settings-session');
        const mismatch = indexed.get('mismatch-session');
        assert.equal(costState.imported1mCostState, true, 'cost-state [1m] key is persisted as its own fact');
        assert.ok(!('imported1mSettings' in costState), 'unmatched home setting does not claim the opus session');
        assert.equal(settings.imported1mSettings, true, 'matching home settings [1m] model is persisted as its own fact');
        assert.ok(!('imported1mCostState' in settings), 'bare cost-state key never acts as a negative or positive signal');
        assert.equal(costState.maxContext, 200000, 'the fact must not launder maxContext into 1M');
        assert.equal(settings.maxContext, 200000, 'the fact must not launder maxContext into 1M');
        assert.ok(!('imported1mCostState' in mismatch) && !('imported1mSettings' in mismatch),
          'base-mismatched cost-state/settings declarations have no effect (#211 guard A)');
        assert.equal(mismatch.maxContext, 200000, 'a mismatched declaration must not change maxContext');

        const costStateAggregate = sessionIdx.get('cost-state-session');
        const settingsAggregate = sessionIdx.get('settings-session');
        assert.equal(costStateAggregate.imported1mCostState, true, 'cold-session aggregate retains cost-state fact');
        assert.equal(settingsAggregate.imported1mSettings, true, 'cold-session aggregate retains settings fact');
      } finally {
        if (priorHomes === undefined) process.env.CCXRAY_IMPORT_HOMES = importDir;
        else process.env.CCXRAY_IMPORT_HOMES = priorHomes;
        fs.rmSync(configHome, { recursive: true, force: true });
      }
    });

    it('#603 capability gate refuses [1m] declarations for a model that cannot serve 1M', async () => {
      const configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-import-1m-capability-'));
      const projects = path.join(configHome, 'projects');
      const priorHomes = process.env.CCXRAY_IMPORT_HOMES;
      try {
        process.env.CCXRAY_IMPORT_HOMES = projects;
        fs.mkdirSync(path.join(projects, 'capability-source'), { recursive: true });
        fs.writeFileSync(path.join(configHome, 'settings.json'), JSON.stringify({ model: 'claude-haiku-4-5[1m]' }));
        fs.writeFileSync(path.join(projects, 'capability-source', 'capability-session.jsonl'), [
          makeAssistant({ timestamp: '2026-08-31T10:03:00.000Z', model: 'claude-haiku-4-5' }),
          JSON.stringify({ type: 'cost-state', modelUsage: { 'claude-haiku-4-5[1m]': { costUSD: 0.01 } } }),
        ].join('\n'));

        await scanAndImport();
        await config.storage.drain();
        const line = readIndexLines().find(entry => entry.sessionId === 'capability-session');
        assert.ok(line, 'fixture session imported');
        assert.ok(!('imported1mCostState' in line) && !('imported1mSettings' in line),
          'the shared modelSupports1M gate rejects both importer sources (#211 guard B)');
        assert.equal(line.maxContext, 200000);
      } finally {
        if (priorHomes === undefined) process.env.CCXRAY_IMPORT_HOMES = importDir;
        else process.env.CCXRAY_IMPORT_HOMES = priorHomes;
        fs.rmSync(configHome, { recursive: true, force: true });
      }
    });

    it('T5: imports from every comma-separated configured Claude projects root', async () => {
      const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-import-second-'));
      const aliasParent = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-import-alias-'));
      const aliasRoot = path.join(aliasParent, 'projects');
      fs.symlinkSync(importDir, aliasRoot);
      try {
        const firstProject = path.join(importDir, '-tmp-first');
        const secondProject = path.join(secondRoot, '-tmp-second');
        fs.mkdirSync(firstProject, { recursive: true });
        fs.mkdirSync(secondProject, { recursive: true });
        fs.writeFileSync(path.join(firstProject, 'session-first.jsonl'), [
          makeUser('first'),
          makeAssistant({ timestamp: '2026-07-15T10:31:00.000Z' }),
        ].join('\n'));
        fs.writeFileSync(path.join(secondProject, 'session-second.jsonl'), [
          makeUser('second'),
          makeAssistant({ timestamp: '2026-07-15T10:32:00.000Z' }),
        ].join('\n'));

        process.env.CCXRAY_IMPORT_HOMES = ` ${importDir}, , ${aliasRoot}, ${secondRoot} `;
        assert.deepStrictEqual(discoverHomes().map(({ dir }) => dir), [
          fs.realpathSync(importDir), fs.realpathSync(secondRoot),
        ]);
        const result = await scanAndImport();
        await config.storage.drain();
        assert.strictEqual(result.imported, 2);
        assert.deepStrictEqual(
          readIndexLines().map(entry => entry.sessionId).sort(),
          ['session-first', 'session-second'],
        );
      } finally {
        fs.rmSync(aliasParent, { recursive: true, force: true });
        fs.rmSync(secondRoot, { recursive: true, force: true });
      }
    });

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

  it('accepts comma-separated configured Codex sessions roots', () => {
    const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-codex-second-'));
    const aliasParent = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-codex-alias-'));
    const aliasRoot = path.join(aliasParent, 'sessions');
    fs.symlinkSync(codexDir, aliasRoot);
    try {
      process.env.CCXRAY_IMPORT_CODEX_HOMES = ` ${codexDir}, , ${aliasRoot}, ${secondRoot} `;
      assert.deepStrictEqual(discoverCodexHomes().map(({ dir }) => dir), [
        fs.realpathSync(codexDir), fs.realpathSync(secondRoot),
      ]);
    } finally {
      fs.rmSync(aliasParent, { recursive: true, force: true });
      fs.rmSync(secondRoot, { recursive: true, force: true });
    }
  });

  describe('parseCodexSessionFile', () => {
    it('attaches an explicit compaction boundary to the next emitted turn', async () => {
      const sessDir = path.join(codexDir, '2026', '07', '15');
      fs.mkdirSync(sessDir, { recursive: true });
      const file = path.join(sessDir, 'rollout-compacted.jsonl');
      fs.writeFileSync(file, [
        makeCodexSessionMeta({ sessionId: 'codex-compacted' }),
        JSON.stringify({ timestamp: '2026-07-15T10:30:01.000Z', type: 'compacted' }),
        makeCodexTokenCount({ timestamp: '2026-07-15T10:30:02.000Z', input: 0, cachedInput: 0, output: 0, reasoningOutput: 0, total: 0 }),
        makeCodexTokenCount({ timestamp: '2026-07-15T10:30:05.000Z' }),
      ].join('\n'));

      const entries = await parseCodexSessionFile(file);
      assert.equal(entries.length, 1, 'zero-token boundaries must remain skipped');
      assert.equal(entries[0].compacted, true, 'the marker belongs to the next emitted turn');
    });

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
      assert.strictEqual(entries[0].contextUsageKnown, true);
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

    it('#500: call+output in same window, results carry to NEXT entry', async () => {
      const sessDir = path.join(codexDir, '2026', '07', '15');
      fs.mkdirSync(sessDir, { recursive: true });
      const file = path.join(sessDir, 'rollout-tool-result.jsonl');
      const output = [{ type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\nhello\n' }];
      fs.writeFileSync(file, [
        makeCodexSessionMeta({ sessionId: 'codex-tool-2' }),
        makeCodexTurnContext({ model: 'gpt-5.5' }),
        // Window 0: call + output in same window (real Codex behavior)
        JSON.stringify({ timestamp: '2026-07-15T10:30:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'call_AAA', name: 'exec' } }),
        JSON.stringify({ timestamp: '2026-07-15T10:30:03.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call_AAA', output } }),
        makeCodexTokenCount({ timestamp: '2026-07-15T10:30:04.000Z' }),
        // Window 1: empty, creates entry that receives the results
        makeCodexTokenCount({ timestamp: '2026-07-15T10:30:08.000Z' }),
      ].join('\n'));

      const entries = await parseCodexSessionFile(file);
      assert.strictEqual(entries.length, 2);
      assert.deepStrictEqual(entries[0].turnToolCallIds, { call_AAA: 'Bash' });
      assert.deepStrictEqual(entries[0].turnToolResults, []);
      assert.strictEqual(entries[1].turnToolResults.length, 1);
      assert.strictEqual(entries[1].turnToolResults[0].callId, 'call_AAA');
      assert.strictEqual(entries[1].turnToolResults[0].eligible, true);
    });

    it('#500: multi-tool calls+outputs in same window, results carry to next', async () => {
      const sessDir = path.join(codexDir, '2026', '07', '15');
      fs.mkdirSync(sessDir, { recursive: true });
      const file = path.join(sessDir, 'rollout-tool-multi.jsonl');
      const output = [{ type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\nok\n' }];
      fs.writeFileSync(file, [
        makeCodexSessionMeta({ sessionId: 'codex-tool-3' }),
        makeCodexTurnContext({ model: 'gpt-5.5' }),
        // Window 0: two call+output pairs
        JSON.stringify({ timestamp: '2026-07-15T10:30:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'call_1', name: 'exec' } }),
        JSON.stringify({ timestamp: '2026-07-15T10:30:02.500Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call_1', output } }),
        JSON.stringify({ timestamp: '2026-07-15T10:30:03.000Z', type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'call_2', name: 'apply_patch' } }),
        JSON.stringify({ timestamp: '2026-07-15T10:30:03.500Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call_2', output } }),
        makeCodexTokenCount({ timestamp: '2026-07-15T10:30:05.000Z' }),
        // Window 1: empty, receives the results
        makeCodexTokenCount({ timestamp: '2026-07-15T10:30:10.000Z' }),
      ].join('\n'));

      const entries = await parseCodexSessionFile(file);
      assert.strictEqual(entries.length, 2);
      assert.deepStrictEqual(entries[0].turnToolCallIds, { call_1: 'Bash', call_2: 'Edit' });
      assert.deepStrictEqual(entries[0].turnToolResults, []);
      assert.strictEqual(entries[1].turnToolResults.length, 2);
      assert.strictEqual(entries[1].turnToolResults[0].callId, 'call_1');
      assert.strictEqual(entries[1].turnToolResults[1].callId, 'call_2');
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

describe('import root contract', () => {
  it('rejects relative roots and reports once per distinct value', () => {
  const importer = require('../server/importer');
  const saved = process.env.CCXRAY_IMPORT_HOMES;
  const errs = [];
  const origErr = console.error;
  console.error = (...a) => errs.push(a.join(' '));
  try {
    importer._resetRootWarnings();
    process.env.CCXRAY_IMPORT_HOMES = 'rel-one,rel-two';
    assert.deepEqual(importer.discoverHomes(), [], 'no absolute entry means no roots');
    assert.equal(errs.length, 1, 'both bad values in one message');
    assert.match(errs[0], /rel-one/);
    assert.match(errs[0], /rel-two/);

    // Same values again, in the other order: already seen, so silent. Keying the
    // joined list instead of each value made a reorder re-warn.
    importer.discoverHomes();
    process.env.CCXRAY_IMPORT_HOMES = 'rel-two,rel-one';
    importer.discoverHomes();
    assert.equal(errs.length, 1, 'a reorder of seen values is not news');

    // A genuinely new bad value IS news, and only that value is named.
    process.env.CCXRAY_IMPORT_HOMES = 'rel-one,rel-three';
    importer.discoverHomes();
    assert.equal(errs.length, 2);
    assert.match(errs[1], /rel-three/);
    assert.ok(!errs[1].includes('rel-one'), 'an already-reported value is not repeated');
  } finally {
    console.error = origErr;
    if (saved === undefined) delete process.env.CCXRAY_IMPORT_HOMES;
    else process.env.CCXRAY_IMPORT_HOMES = saved;
    importer._resetRootWarnings();
  }
});
});
