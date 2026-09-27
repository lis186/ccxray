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
  scanAndImport, scanAndImportTranscript, parseSessionFile, parseCodexSessionFile,
  collectSubagentFiles, discoverHomes, discoverCodexHomes, slugToProject, tsToId,
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
    // S-2/A-2.3: full 3-digit ms precision, not the old 10ms-rounded 2-digit
    // form — the id format change this stage introduces (fail-on-old: the
    // pre-S2 code returned '2026-07-15T10-30-00-12').
    it('converts ISO timestamp to ID format with full millisecond precision', () => {
      assert.strictEqual(tsToId('2026-07-15T10:30:00.123Z'), '2026-07-15T10-30-00-123');
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

  // S-6/A-6.2: effort, thinkingTokens, turnDurationMs extraction from Claude
  // Code transcripts.
  describe('S-6 effort / thinking tokens / turn duration import', () => {
    it('effort prefers non-empty perTurnEffort over the session-level effort', async () => {
      const sessionDir = path.join(importDir, 'test-project');
      fs.mkdirSync(sessionDir, { recursive: true });
      const file = path.join(sessionDir, 'sess-effort-per-turn.jsonl');
      fs.writeFileSync(file, [
        makeUser('hi'),
        makeAssistant({
          timestamp: '2026-07-15T10:30:05.000Z',
          extra: { effort: 'medium', perTurnEffort: 'low' },
        }),
      ].join('\n'));

      const entries = await parseSessionFile(file, 'test-project');
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0].effort, 'low');
    });

    it('effort falls back to the session-level effort when perTurnEffort is null', async () => {
      const sessionDir = path.join(importDir, 'test-project');
      fs.mkdirSync(sessionDir, { recursive: true });
      const file = path.join(sessionDir, 'sess-effort-fallback.jsonl');
      fs.writeFileSync(file, [
        makeUser('hi'),
        makeAssistant({
          timestamp: '2026-07-15T10:30:05.000Z',
          extra: { effort: 'medium', perTurnEffort: null },
        }),
      ].join('\n'));

      const entries = await parseSessionFile(file, 'test-project');
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0].effort, 'medium');
    });

    it('effort is null when neither perTurnEffort nor effort is a non-empty string', async () => {
      const sessionDir = path.join(importDir, 'test-project');
      fs.mkdirSync(sessionDir, { recursive: true });
      const file = path.join(sessionDir, 'sess-effort-absent.jsonl');
      fs.writeFileSync(file, [
        makeUser('hi'),
        makeAssistant({ timestamp: '2026-07-15T10:30:05.000Z' }),
      ].join('\n'));

      const entries = await parseSessionFile(file, 'test-project');
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0].effort, null);
    });

    it('thinkingTokens is read from message.usage.output_tokens_details.thinking_tokens', async () => {
      const sessionDir = path.join(importDir, 'test-project');
      fs.mkdirSync(sessionDir, { recursive: true });
      const file = path.join(sessionDir, 'sess-thinking-tokens.jsonl');
      const line = JSON.parse(makeAssistant({ timestamp: '2026-07-15T10:30:05.000Z' }));
      line.message.usage.output_tokens_details = { thinking_tokens: 17 };
      fs.writeFileSync(file, [makeUser('hi'), JSON.stringify(line)].join('\n'));

      const entries = await parseSessionFile(file, 'test-project');
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0].thinkingTokens, 17);
    });

    it('thinkingTokens is null when output_tokens_details is absent', async () => {
      const sessionDir = path.join(importDir, 'test-project');
      fs.mkdirSync(sessionDir, { recursive: true });
      const file = path.join(sessionDir, 'sess-thinking-tokens-absent.jsonl');
      fs.writeFileSync(file, [
        makeUser('hi'),
        makeAssistant({ timestamp: '2026-07-15T10:30:05.000Z' }),
      ].join('\n'));

      const entries = await parseSessionFile(file, 'test-project');
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0].thinkingTokens, null);
    });

    it('turnDurationMs attaches to the last assistant entry parsed before the turn_duration line, across two user turns', async () => {
      const sessionDir = path.join(importDir, 'test-project');
      fs.mkdirSync(sessionDir, { recursive: true });
      const file = path.join(sessionDir, 'sess-turn-duration.jsonl');
      fs.writeFileSync(file, [
        makeUser('first?'),
        makeAssistant({ timestamp: '2026-07-15T10:30:05.000Z', msgId: 'msg_01A' }),
        makeLine('system', { subtype: 'turn_duration', durationMs: 9245, timestamp: '2026-07-15T10:30:06.000Z' }),
        makeUser('second?'),
        makeAssistant({ timestamp: '2026-07-15T10:30:10.000Z', msgId: 'msg_01B' }),
        makeLine('system', { subtype: 'turn_duration', durationMs: 6702, timestamp: '2026-07-15T10:30:11.000Z' }),
      ].join('\n'));

      const entries = await parseSessionFile(file, 'test-project');
      assert.strictEqual(entries.length, 2);
      const first = entries.find(e => e.responseId === 'msg_01A');
      const second = entries.find(e => e.responseId === 'msg_01B');
      assert.strictEqual(first.turnDurationMs, 9245);
      assert.strictEqual(second.turnDurationMs, 6702);
    });

    it('turnDurationMs stays null when no turn_duration line follows (a "-p" session shape)', async () => {
      const sessionDir = path.join(importDir, 'test-project');
      fs.mkdirSync(sessionDir, { recursive: true });
      const file = path.join(sessionDir, 'sess-no-turn-duration.jsonl');
      fs.writeFileSync(file, [
        makeUser('hi'),
        makeAssistant({ timestamp: '2026-07-15T10:30:05.000Z' }),
      ].join('\n'));

      const entries = await parseSessionFile(file, 'test-project');
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0].turnDurationMs, null);
    });
  });

  // S-1: Claude Code Task-tool subagent transcripts live under
  // `<slug>/<sid>/subagents/agent-<agentId>.jsonl` + a sidecar `.meta.json`,
  // a directory shape `collectJsonlFiles` never descends into.
  describe('S-1 subagent import', () => {
    it('parseSessionFile with opts.subagent derives sessionId from the line, not the filename', async () => {
      const sessionDir = path.join(importDir, 'test-project');
      const subagentsDir = path.join(sessionDir, 'parent-sess', 'subagents');
      fs.mkdirSync(subagentsDir, { recursive: true });
      const file = path.join(subagentsDir, 'agent-test123.jsonl');
      fs.writeFileSync(file, [
        makeAssistant({
          timestamp: '2026-07-15T10:30:10.000Z',
          extra: { sessionId: 'parent-sess', agentId: 'test123', cwd: '/tmp/test-project' },
        }),
      ].join('\n'));

      // current code has no `opts.subagent` handling — this is fail-on-old
      const entries = await parseSessionFile(file, 'test-project', {
        subagent: true,
        agentKey: 'general-purpose',
        agentLabel: 'General Purpose',
        subagentToolUseId: 'toolu_test',
      });
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0].isSubagent, true);
      assert.strictEqual(entries[0].subagentId, 'test123');
      assert.strictEqual(entries[0].subagentToolUseId, 'toolu_test');
      assert.strictEqual(entries[0].agentKey, 'general-purpose');
      assert.strictEqual(entries[0].agentLabel, 'General Purpose');
      // Derived from the line's own sessionId, not `agent-test123` (the filename).
      assert.strictEqual(entries[0].sessionId, 'parent-sess');
    });

    it('parseSessionFile falls back to opts.parentCwd when the subagent line has no cwd', async () => {
      const sessionDir = path.join(importDir, 'test-project');
      const subagentsDir = path.join(sessionDir, 'parent-sess', 'subagents');
      fs.mkdirSync(subagentsDir, { recursive: true });
      const file = path.join(subagentsDir, 'agent-nocw.jsonl');
      const line = JSON.parse(makeAssistant({
        timestamp: '2026-07-15T10:30:10.000Z',
        extra: { sessionId: 'parent-sess', agentId: 'nocw' },
      }));
      delete line.cwd;
      fs.writeFileSync(file, JSON.stringify(line));

      const entries = await parseSessionFile(file, 'test-project', {
        subagent: true, parentCwd: '/tmp/parent-project',
      });
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0].cwd, '/tmp/parent-project');
    });

    it('collectSubagentFiles finds agent-*.jsonl under every <sid>/subagents/', async () => {
      const projectDir = path.join(importDir, 'collect-project');
      const subagentsDir = path.join(projectDir, 'parent-sess', 'subagents');
      fs.mkdirSync(subagentsDir, { recursive: true });
      fs.writeFileSync(path.join(subagentsDir, 'agent-abc.jsonl'), '');
      fs.writeFileSync(path.join(subagentsDir, 'agent-abc.meta.json'), '{}');
      // A non-agent-prefixed / non-jsonl file must not be picked up.
      fs.writeFileSync(path.join(subagentsDir, 'notes.txt'), '');

      const files = await collectSubagentFiles(projectDir);
      assert.strictEqual(files.length, 1);
      assert.strictEqual(files[0].sid, 'parent-sess');
      assert.ok(files[0].file.endsWith(path.join('subagents', 'agent-abc.jsonl')));
      assert.ok(files[0].metaPath.endsWith(path.join('subagents', 'agent-abc.meta.json')));
    });

    it('scanAndImport skips a subagent turn whose sessionId is not its parent directory', async () => {
      const projectDir = path.join(importDir, 'mismatch-project');
      const subagentsDir = path.join(projectDir, 'owner-sess', 'subagents');
      fs.mkdirSync(subagentsDir, { recursive: true });
      fs.writeFileSync(path.join(subagentsDir, 'agent-stray.jsonl'), [
        makeAssistant({
          timestamp: '2026-07-15T11:00:00.000Z',
          extra: { sessionId: 'someone-else', agentId: 'stray', cwd: '/tmp/mismatch-project' },
        }),
      ].join('\n'));

      const result = await scanAndImport();
      await config.storage.drain();
      assert.strictEqual(result.imported, 0, 'the parent is the directory; a foreign sessionId is not attributed');
      assert.ok(!readIndexLines().some(l => l.sessionId === 'someone-else'));
    });

    it('scanAndImport imports subagent turns alongside the parent session', async () => {
      const projectDir = path.join(importDir, 'full-project');
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'parent-sess.jsonl'), [
        makeUser('parent turn'),
        makeAssistant({
          timestamp: '2026-07-15T10:30:00.000Z',
          extra: { sessionId: 'parent-sess', cwd: '/tmp/full-project' },
        }),
      ].join('\n'));

      const subagentsDir = path.join(projectDir, 'parent-sess', 'subagents');
      fs.mkdirSync(subagentsDir, { recursive: true });
      fs.writeFileSync(path.join(subagentsDir, 'agent-sub1.meta.json'), JSON.stringify({
        agentType: 'general-purpose', toolUseId: 'toolu_01DJM',
      }));
      fs.writeFileSync(path.join(subagentsDir, 'agent-sub1.jsonl'), [
        makeAssistant({
          timestamp: '2026-07-15T10:30:05.000Z',
          extra: { sessionId: 'parent-sess', agentId: 'sub1', cwd: '/tmp/full-project' },
        }),
      ].join('\n'));

      // A second subagent with missing/unreadable .meta.json must still import,
      // with no agentKey and no subagentToolUseId (A-1.1).
      fs.writeFileSync(path.join(subagentsDir, 'agent-sub2.jsonl'), [
        makeAssistant({
          timestamp: '2026-07-15T10:30:06.000Z',
          extra: { sessionId: 'parent-sess', agentId: 'sub2', cwd: '/tmp/full-project' },
        }),
      ].join('\n'));

      const result = await scanAndImport();
      await config.storage.drain();
      assert.strictEqual(result.imported, 3);

      const lines = readIndexLines();
      const sub1 = lines.find(l => l.subagentId === 'sub1');
      const sub2 = lines.find(l => l.subagentId === 'sub2');
      assert.ok(sub1, 'subagent with meta.json is imported');
      assert.strictEqual(sub1.isSubagent, true);
      assert.strictEqual(sub1.sessionId, 'parent-sess');
      assert.strictEqual(sub1.subagentToolUseId, 'toolu_01DJM');
      assert.strictEqual(sub1.agentKey, 'general-purpose');
      assert.strictEqual(sub1.agentLabel, 'General Purpose');

      assert.ok(sub2, 'subagent with missing meta.json is still imported');
      assert.strictEqual(sub2.isSubagent, true);
      assert.strictEqual(sub2.agentKey, null);
      assert.ok(!('subagentToolUseId' in sub2), 'null subagentToolUseId is omitted (OMIT_IF_NULL)');
    });

    it('#A-1.2 scanAndImportTranscript also imports the parent transcript\'s subagent files', async () => {
      const projectDir = path.join(importDir, 'targeted-project');
      fs.mkdirSync(projectDir, { recursive: true });
      const sid = 'targeted-sess';
      const parentFile = path.join(projectDir, `${sid}.jsonl`);
      fs.writeFileSync(parentFile, [
        makeUser('hi'),
        makeAssistant({
          timestamp: '2026-07-15T10:40:00.000Z',
          extra: { sessionId: sid, cwd: '/tmp/targeted-project' },
        }),
      ].join('\n'));

      const subagentsDir = path.join(projectDir, sid, 'subagents');
      fs.mkdirSync(subagentsDir, { recursive: true });
      fs.writeFileSync(path.join(subagentsDir, 'agent-sub1.meta.json'), JSON.stringify({
        agentType: 'general-purpose', toolUseId: 'toolu_sub1',
      }));
      fs.writeFileSync(path.join(subagentsDir, 'agent-sub1.jsonl'), [
        makeAssistant({
          timestamp: '2026-07-15T10:40:05.000Z',
          extra: { sessionId: sid, agentId: 'sub1', cwd: '/tmp/targeted-project' },
        }),
      ].join('\n'));

      const result = await scanAndImportTranscript({
        file: parentFile, provider: 'claude', sessionId: sid, cwd: '/tmp/targeted-project',
      });
      await config.storage.drain();
      assert.strictEqual(result.imported, 2, 'parent turn + subagent turn both imported');

      const lines = readIndexLines().filter(l => l.sessionId === sid);
      const sub = lines.find(l => l.isSubagent);
      assert.ok(sub, 'subagent entry reached the index via the targeted import');
      assert.strictEqual(sub.subagentId, 'sub1');
      assert.strictEqual(sub.subagentToolUseId, 'toolu_sub1');
      assert.strictEqual(sub.agentKey, 'general-purpose');
    });
  });

  describe('S-2 import id precision and collisions', () => {
    it('A-2.4(a): two different sessions with turns at the same millisecond each get a distinct id', async () => {
      const ts = '2026-07-20T09:00:00.000Z';
      const projA = path.join(importDir, '-tmp-collide-a');
      const projB = path.join(importDir, '-tmp-collide-b');
      fs.mkdirSync(projA, { recursive: true });
      fs.mkdirSync(projB, { recursive: true });
      fs.writeFileSync(path.join(projA, 'sess-a.jsonl'), [
        makeAssistant({ timestamp: ts, msgId: 'msg_a', extra: { sessionId: 'sess-a', cwd: '/tmp/collide-a' } }),
      ].join('\n'));
      fs.writeFileSync(path.join(projB, 'sess-b.jsonl'), [
        makeAssistant({ timestamp: ts, msgId: 'msg_b', extra: { sessionId: 'sess-b', cwd: '/tmp/collide-b' } }),
      ].join('\n'));

      const result = await scanAndImport();
      await config.storage.drain();
      assert.strictEqual(result.imported, 2, 'both same-millisecond turns import — no silent drop');

      const lines = readIndexLines();
      const a = lines.find(l => l.sessionId === 'sess-a');
      const b = lines.find(l => l.sessionId === 'sess-b');
      assert.ok(a && b);
      assert.notStrictEqual(a.id, b.id, 'same-millisecond turns in different sessions get distinct ids');
      assert.ok(a.id.startsWith('2026-07-20T09-00-00-000') && b.id.startsWith('2026-07-20T09-00-00-000'));
      assert.ok(a.id === `${b.id}-1` || b.id === `${a.id}-1`,
        'the turn processed second gets a deterministic -N suffix, not a thrown collision error');
    });

    it('A-2.4(b): a main turn and its subagent turn at the same millisecond both import with distinct ids', async () => {
      const ts = '2026-07-20T09:05:00.000Z';
      const projectDir = path.join(importDir, '-tmp-collide-main-sub');
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'parent-collide.jsonl'), [
        makeAssistant({ timestamp: ts, msgId: 'msg_main', extra: { sessionId: 'parent-collide', cwd: '/tmp/collide-main-sub' } }),
      ].join('\n'));

      const subagentsDir = path.join(projectDir, 'parent-collide', 'subagents');
      fs.mkdirSync(subagentsDir, { recursive: true });
      fs.writeFileSync(path.join(subagentsDir, 'agent-sub1.jsonl'), [
        makeAssistant({
          timestamp: ts, msgId: 'msg_sub',
          extra: { sessionId: 'parent-collide', agentId: 'sub1', cwd: '/tmp/collide-main-sub' },
        }),
      ].join('\n'));

      const result = await scanAndImport();
      await config.storage.drain();
      assert.strictEqual(result.imported, 2, 'main + subagent turns both import despite the shared millisecond');

      const lines = readIndexLines().filter(l => l.sessionId === 'parent-collide');
      assert.strictEqual(lines.length, 2);
      const main = lines.find(l => !l.isSubagent);
      const sub = lines.find(l => l.isSubagent);
      assert.ok(main && sub);
      assert.notStrictEqual(main.id, sub.id, "the subagent turn does not overwrite the main turn's id");
      assert.ok(sub.id === `${main.id}-1` || main.id === `${sub.id}-1`);
    });

    it('A-2.4(c): rescanning an index that holds legacy 10ms ids (Claude with responseId, Codex without) imports nothing new', async () => {
      const claudeTs = '2026-07-20T09:10:00.000Z';
      const codexTs = '2026-07-20T09:15:00.000Z';
      const claudeLegacyId = tsToId(claudeTs).slice(0, -1);
      const codexLegacyId = tsToId(codexTs).slice(0, -1);

      // Simulate a pre-S2 import: legacy 10ms ids already on disk, one Claude
      // line (carries responseId), one Codex line (never does).
      fs.appendFileSync(INDEX_PATH, JSON.stringify({
        id: claudeLegacyId, sessionId: 'legacy-claude-sess', responseId: 'msg_legacy_claude',
        imported: true, importSource: 'claude-code',
      }) + '\n');
      fs.appendFileSync(INDEX_PATH, JSON.stringify({
        id: codexLegacyId, sessionId: 'legacy-codex-sess', imported: true, importSource: 'codex',
      }) + '\n');

      const claudeProjectDir = path.join(importDir, '-tmp-legacy-claude');
      fs.mkdirSync(claudeProjectDir, { recursive: true });
      fs.writeFileSync(path.join(claudeProjectDir, 'legacy-claude-sess.jsonl'), [
        makeAssistant({
          timestamp: claudeTs, msgId: 'msg_legacy_claude',
          extra: { sessionId: 'legacy-claude-sess', cwd: '/tmp/legacy-claude' },
        }),
      ].join('\n'));

      const codexSessDir = path.join(codexImportDir, '2026', '07', '20');
      fs.mkdirSync(codexSessDir, { recursive: true });
      fs.writeFileSync(path.join(codexSessDir, 'rollout-legacy.jsonl'), [
        makeCodexSessionMeta({ sessionId: 'legacy-codex-sess', cwd: '/tmp/legacy-codex', timestamp: codexTs }),
        makeCodexTurnContext({ timestamp: codexTs, cwd: '/tmp/legacy-codex', model: 'gpt-5.5' }),
        makeCodexTokenCount({ timestamp: codexTs }),
      ].join('\n'));

      const result = await scanAndImport();
      await config.storage.drain();
      assert.strictEqual(result.imported, 0, 'both turns are recognized as already imported under the legacy id');
      assert.strictEqual(result.skipped, 2);
      assert.strictEqual(readIndexLines().length, 2, 'no new lines are appended for either provider');
    });

    it('A-2.4(d): rescanning after a new-format import (including a suffixed entry) imports nothing new', async () => {
      const ts = '2026-07-20T09:20:00.000Z';
      const projA = path.join(importDir, '-tmp-rescan-collide-a');
      const projB = path.join(importDir, '-tmp-rescan-collide-b');
      fs.mkdirSync(projA, { recursive: true });
      fs.mkdirSync(projB, { recursive: true });
      fs.writeFileSync(path.join(projA, 'sess-a.jsonl'), [
        makeAssistant({ timestamp: ts, msgId: 'msg_ra', extra: { sessionId: 'rescan-a', cwd: '/tmp/rescan-a' } }),
      ].join('\n'));
      fs.writeFileSync(path.join(projB, 'sess-b.jsonl'), [
        makeAssistant({ timestamp: ts, msgId: 'msg_rb', extra: { sessionId: 'rescan-b', cwd: '/tmp/rescan-b' } }),
      ].join('\n'));

      const first = await scanAndImport();
      await config.storage.drain();
      assert.strictEqual(first.imported, 2);
      const firstLines = readIndexLines();
      const suffixed = firstLines.find(l => l.id.endsWith('-1'));
      assert.ok(suffixed, 'the fixture actually produced a suffixed entry (A-2.2)');

      const second = await scanAndImport();
      await config.storage.drain();
      assert.strictEqual(second.imported, 0, 'the suffixed entry is recognized by responseId, not by its (changed) id');
      assert.strictEqual(second.skipped, 2);
      assert.strictEqual(readIndexLines().length, 2, 'index.ndjson is unchanged after the rescan');
    });

    it('A-2.2: an id already held by the SAME turn (same responseId, not imported) is skipped, not suffixed', async () => {
      const ts = '2026-07-20T09:30:00.000Z';
      fs.appendFileSync(INDEX_PATH, JSON.stringify({
        id: tsToId(ts), sessionId: 'same-turn-sess', responseId: 'msg_same_turn', imported: false,
      }) + '\n');
      const proj = path.join(importDir, '-tmp-same-turn');
      fs.mkdirSync(proj, { recursive: true });
      fs.writeFileSync(path.join(proj, 'same-turn-sess.jsonl'), [
        makeAssistant({ timestamp: ts, msgId: 'msg_same_turn', extra: { sessionId: 'same-turn-sess', cwd: '/tmp/same-turn' } }),
      ].join('\n'));

      const result = await scanAndImport();
      await config.storage.drain();
      assert.strictEqual(result.imported, 0, 'the id is occupied by this very turn, so there is nothing to add');
      assert.strictEqual(readIndexLines().length, 1);
    });

    it('A-2.1: a legacy 10ms row written before responseId existed is recognized as the same Claude turn', async () => {
      const ts = '2026-07-20T09:35:00.000Z';
      fs.appendFileSync(INDEX_PATH, JSON.stringify({
        id: tsToId(ts).slice(0, -1), sessionId: 'pre-rid-sess', imported: true, importSource: 'claude-code',
      }) + '\n');
      const proj = path.join(importDir, '-tmp-pre-rid');
      fs.mkdirSync(proj, { recursive: true });
      fs.writeFileSync(path.join(proj, 'pre-rid-sess.jsonl'), [
        makeAssistant({ timestamp: ts, msgId: 'msg_pre_rid', extra: { sessionId: 'pre-rid-sess', cwd: '/tmp/pre-rid' } }),
      ].join('\n'));

      const result = await scanAndImport();
      await config.storage.drain();
      assert.strictEqual(result.imported, 0, 'an old import of the same turn must not be duplicated');
      assert.strictEqual(readIndexLines().length, 1);
    });

    it('A-2.4(e): a suffixed Codex turn (no responseId) is not re-imported on rescan', async () => {
      const ts = '2026-07-20T09:25:00.000Z';
      const codexSessDir = path.join(codexImportDir, '2026', '07', '21');
      fs.mkdirSync(codexSessDir, { recursive: true });
      for (const sid of ['codex-collide-a', 'codex-collide-b']) {
        fs.writeFileSync(path.join(codexSessDir, `rollout-${sid}.jsonl`), [
          makeCodexSessionMeta({ sessionId: sid, cwd: `/tmp/${sid}`, timestamp: ts }),
          makeCodexTurnContext({ timestamp: ts, cwd: `/tmp/${sid}`, model: 'gpt-5.5' }),
          makeCodexTokenCount({ timestamp: ts }),
        ].join('\n'));
      }

      const first = await scanAndImport();
      await config.storage.drain();
      assert.strictEqual(first.imported, 2);
      assert.ok(readIndexLines().some(l => l.id.endsWith('-1')), 'the fixture produced a suffixed Codex entry');

      const second = await scanAndImport();
      await config.storage.drain();
      assert.strictEqual(second.imported, 0, 'the suffixed Codex turn is recognized under its own session');
      assert.strictEqual(readIndexLines().length, 2);
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
      ...(opts.effort ? { effort: opts.effort } : {}),
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

    // S-6/A-6.3: the latest turn_context effort applies to every subsequent entry.
    it('S-6: effort from the latest turn_context applies to subsequent entries', async () => {
      const sessDir = path.join(codexDir, '2026', '07', '15');
      fs.mkdirSync(sessDir, { recursive: true });
      const file = path.join(sessDir, 'rollout-effort.jsonl');
      fs.writeFileSync(file, [
        makeCodexSessionMeta({ sessionId: 'codex-effort-1' }),
        makeCodexTurnContext({ model: 'gpt-6-sol', effort: 'low' }),
        makeCodexTokenCount({ timestamp: '2026-07-15T10:30:05.000Z' }),
        makeCodexTurnContext({ model: 'gpt-6-sol', effort: 'high', turnId: 'turn-2' }),
        makeCodexTokenCount({ timestamp: '2026-07-15T10:30:15.000Z' }),
      ].join('\n'));

      const entries = await parseCodexSessionFile(file);
      assert.strictEqual(entries.length, 2);
      assert.strictEqual(entries[0].effort, 'low');
      assert.strictEqual(entries[1].effort, 'high');
    });

    it('S-6: effort is null when no turn_context declares one', async () => {
      const sessDir = path.join(codexDir, '2026', '07', '15');
      fs.mkdirSync(sessDir, { recursive: true });
      const file = path.join(sessDir, 'rollout-no-effort.jsonl');
      fs.writeFileSync(file, [
        makeCodexSessionMeta({ sessionId: 'codex-no-effort' }),
        makeCodexTurnContext({ model: 'gpt-5.5' }),
        makeCodexTokenCount({ timestamp: '2026-07-15T10:30:05.000Z' }),
      ].join('\n'));

      const entries = await parseCodexSessionFile(file);
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0].effort, null);
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
