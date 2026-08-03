'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

describe('#428 importer: aggregate by message.id', () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccxray-imp-'));
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeAndParse(lines) {
    const filePath = path.join(tmpDir, 'test-session.jsonl');
    await fsp.writeFile(filePath, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
    const { parseSessionFile } = require('../server/importer');
    return parseSessionFile(filePath, 'test-project');
  }

  it('same message.id across multiple assistant lines produces one entry', async () => {
    const entries = await writeAndParse([
      { type: 'user', message: { content: 'hello' } },
      {
        type: 'assistant', timestamp: '2026-08-02T14:31:57.024Z',
        message: { id: 'msg_01ABC', model: 'claude-sonnet-4-20250514', usage: { input_tokens: 100, output_tokens: 10 }, stop_reason: null },
      },
      {
        type: 'assistant', timestamp: '2026-08-02T14:31:57.500Z',
        message: { id: 'msg_01ABC', model: 'claude-sonnet-4-20250514', usage: { input_tokens: 100, output_tokens: 30 }, stop_reason: null },
      },
      {
        type: 'assistant', timestamp: '2026-08-02T14:31:58.100Z',
        message: { id: 'msg_01ABC', model: 'claude-sonnet-4-20250514', usage: { input_tokens: 100, output_tokens: 50 }, stop_reason: 'end_turn' },
      },
    ]);

    assert.equal(entries.length, 1, 'should produce exactly 1 entry for 3 lines with same message.id');
    assert.equal(entries[0].responseId, 'msg_01ABC');
    assert.equal(entries[0].usage.output_tokens, 50, 'last line wins for usage');
    assert.equal(entries[0].stopReason, 'end_turn', 'last line wins for stop_reason');
  });

  it('different message.ids produce separate entries', async () => {
    const entries = await writeAndParse([
      {
        type: 'assistant', timestamp: '2026-08-02T14:31:57.024Z',
        message: { id: 'msg_01AAA', model: 'claude-sonnet-4-20250514', usage: { input_tokens: 100, output_tokens: 10 }, stop_reason: 'end_turn' },
      },
      {
        type: 'assistant', timestamp: '2026-08-02T14:32:00.000Z',
        message: { id: 'msg_01BBB', model: 'claude-sonnet-4-20250514', usage: { input_tokens: 200, output_tokens: 20 }, stop_reason: 'end_turn' },
      },
    ]);
    assert.equal(entries.length, 2);
  });

  it('lines without message.id pass through individually', async () => {
    const entries = await writeAndParse([
      {
        type: 'assistant', timestamp: '2026-08-02T14:31:57.024Z',
        message: { model: 'claude-sonnet-4-20250514', usage: { input_tokens: 100, output_tokens: 10 }, stop_reason: 'end_turn' },
      },
      {
        type: 'assistant', timestamp: '2026-08-02T14:32:00.000Z',
        message: { model: 'claude-sonnet-4-20250514', usage: { input_tokens: 200, output_tokens: 20 }, stop_reason: 'end_turn' },
      },
    ]);
    assert.equal(entries.length, 2, 'no message.id = no aggregation');
  });

  it('first timestamp wins for entry id (rescan idempotency)', async () => {
    const entries = await writeAndParse([
      {
        type: 'assistant', timestamp: '2026-08-02T14:31:57.024Z',
        message: { id: 'msg_01ABC', model: 'claude-sonnet-4-20250514', usage: { input_tokens: 100, output_tokens: 10 } },
      },
      {
        type: 'assistant', timestamp: '2026-08-02T14:31:58.100Z',
        message: { id: 'msg_01ABC', model: 'claude-sonnet-4-20250514', usage: { input_tokens: 100, output_tokens: 50 }, stop_reason: 'end_turn' },
      },
    ]);
    assert.equal(entries.length, 1);
    assert.ok(entries[0].id.includes('14-31-57'), 'entry id should use first timestamp');
    assert.equal(entries[0].receivedAt, new Date('2026-08-02T14:31:57.024Z').getTime());
  });

  it('title comes from user text before the first assistant line', async () => {
    const entries = await writeAndParse([
      { type: 'user', message: { content: 'explain recursion' } },
      {
        type: 'assistant', timestamp: '2026-08-02T14:31:57.024Z',
        message: { id: 'msg_01ABC', model: 'claude-sonnet-4-20250514', usage: { input_tokens: 100, output_tokens: 10 } },
      },
      {
        type: 'assistant', timestamp: '2026-08-02T14:31:58.100Z',
        message: { id: 'msg_01ABC', model: 'claude-sonnet-4-20250514', usage: { input_tokens: 100, output_tokens: 50 }, stop_reason: 'end_turn' },
      },
    ]);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].title, 'explain recursion');
  });
});
