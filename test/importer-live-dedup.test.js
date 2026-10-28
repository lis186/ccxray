'use strict';

const { it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Synthetic index + transcripts only; pin every importer input before module load.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-import-live-dedup-'));
process.env.CCXRAY_HOME = path.join(root, 'data');
process.env.CCXRAY_IMPORT_HOMES = path.join(root, 'projects');
process.env.CCXRAY_IMPORT_CODEX_HOMES = path.join(root, 'sessions');
process.env.CCXRAY_IMPORT_DISABLE = '0';
process.env.CCXRAY_SESSION_INDEX_NO_FLUSH = '1';
process.env.LOGS_DIR = path.join(root, 'data', 'logs');
process.env.CCXRAY_PRICING_CACHE = path.join(root, 'pricing-cache.json');
for (const dir of [process.env.LOGS_DIR, process.env.CCXRAY_IMPORT_HOMES, process.env.CCXRAY_IMPORT_CODEX_HOMES]) {
  fs.mkdirSync(dir, { recursive: true });
}
fs.writeFileSync(process.env.CCXRAY_PRICING_CACHE,
  JSON.stringify({ fetchedAt: Date.now(), pricing: {}, context: {} }));

const store = require('../server/store');
const config = require('../server/config');
const sessionIdx = require('../server/session-index');
const { scanAndImport, scanAndImportTranscript } = require('../server/importer');
const indexPath = path.join(process.env.LOGS_DIR, 'index.ndjson');
const project = path.join(process.env.CCXRAY_IMPORT_HOMES, 'synthetic-project');
fs.mkdirSync(project);
const file = path.join(project, 'synthetic-session.jsonl');
const cwd = path.join(root, 'work');
const live = {
  id: '2026-07-15T10-30-00-000', sessionId: 'synthetic-session', cwd,
  receivedAt: Date.parse('2026-07-15T10:30:00.000Z'), responseId: 'msg_live',
  model: 'claude-sonnet-4-5-20250514', provider: 'anthropic',
  usage: { input_tokens: 100, output_tokens: 10 },
};
const liveContent = JSON.stringify(live) + '\n';
function transcript(responseId, timestamp = '2026-07-15T10:30:01.123Z') {
  return JSON.stringify({
    type: 'assistant', sessionId: live.sessionId, cwd, timestamp,
    message: {
      id: responseId, role: 'assistant', model: live.model,
      content: [{ type: 'text', text: 'Synthetic response' }],
      usage: { input_tokens: 100, output_tokens: 10 }, stop_reason: 'end_turn',
    },
  }) + '\n';
}
function readIndex() {
  return fs.readFileSync(indexPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

beforeEach(() => {
  store.entries.length = 0;
  store.entryIndex.clear();
  store.responseIndex.clear();
  fs.writeFileSync(indexPath, liveContent);
  sessionIdx.rebuildFromIndexContent(liveContent);
  // The transcript timestamp differs from the live request's timestamp.
  fs.writeFileSync(file, transcript(live.responseId));
});
after(async () => {
  await config.storage.drain();
  fs.rmSync(root, { recursive: true, force: true });
});

it('bulk import skips a durable live response without rewriting the index', async () => {
  assert.deepEqual(await scanAndImport(), { imported: 0, skipped: 1 });
  assert.equal(fs.readFileSync(indexPath, 'utf8'), liveContent);
});

it('bulk import appends only new responses and a rescan appends nothing', async () => {
  // A distinct response at the SAME timestamp must still survive.
  fs.appendFileSync(file, transcript('msg_new'));
  assert.deepEqual(await scanAndImport(), { imported: 1, skipped: 1 });
  await config.storage.drain();
  const rows = readIndex();
  assert.deepEqual(rows.map(row => row.responseId), ['msg_live', 'msg_new']);
  assert.deepEqual(rows[0], live);
  assert.equal(rows[1].imported, true);
  assert.deepEqual(await scanAndImport(), { imported: 0, skipped: 2 });
  assert.deepEqual(readIndex(), rows);
});

it('targeted transcript import also skips live responses and appends new ones', async () => {
  fs.appendFileSync(file, transcript('msg_targeted_new', '2026-07-15T10:31:00.000Z'));
  const result = await scanAndImportTranscript({ provider: 'claude', file, sessionId: live.sessionId, cwd });
  assert.equal(result.imported, 1);
  assert.equal(result.skipped, 1);
  await config.storage.drain();
  assert.deepEqual(readIndex().map(row => row.responseId), ['msg_live', 'msg_targeted_new']);
});

it('live responses in memory suppress import even under a different session identity', async () => {
  fs.writeFileSync(indexPath, '');
  sessionIdx.rebuildFromIndexContent('');
  store.registerEntry({ ...live, sessionId: 'direct-api' });
  assert.deepEqual(await scanAndImport(), { imported: 0, skipped: 1 });
  assert.equal(fs.readFileSync(indexPath, 'utf8'), '');
});
