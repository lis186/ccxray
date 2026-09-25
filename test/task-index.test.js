'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const config = require('../server/config');
const taskIndex = require('../server/task-index');
const { collectTaskEntries, handleApiRoutes } = require('../server/routes/api');
const { createLocalStorage } = require('../server/storage/local');

const originalReadIndexLines = config.storage.readIndexLines;
const originalReadIndexLinesFrom = config.storage.readIndexLinesFrom;

let tempDir;
let indexPath;

function fakeRes() {
  let status = 0;
  let body = null;
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  return {
    headersSent: false,
    status: () => status,
    body: () => body,
    done,
    writeHead: value => { status = value; },
    end: value => { body = value; resolveDone(); },
  };
}

async function get(url) {
  const res = fakeRes();
  assert.equal(handleApiRoutes({ url, method: 'GET' }, res), true);
  await res.done;
  return res;
}

async function appendLine(meta) {
  await fs.appendFile(indexPath, JSON.stringify(meta) + '\n', 'utf8');
}

describe('incremental task index', () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccxray-task-index-'));
    indexPath = path.join(tempDir, 'index.ndjson');
    const storage = createLocalStorage(tempDir);
    await storage.init();
    config.storage.readIndexLines = storage.readIndexLines;
    config.storage.readIndexLinesFrom = storage.readIndexLinesFrom;
    taskIndex.reset();
  });

  afterEach(async () => {
    config.storage.readIndexLines = originalReadIndexLines;
    config.storage.readIndexLinesFrom = originalReadIndexLinesFrom;
    taskIndex.reset();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('includes task rows appended after the first query', async () => {
    await appendLine({ id: 'first', task: 'APPEND' });
    assert.deepEqual((await collectTaskEntries('APPEND')).map(row => row.id), ['first']);

    await appendLine({ id: 'second', task: 'APPEND' });
    assert.deepEqual((await collectTaskEntries('APPEND')).map(row => row.id), ['first', 'second']);
  });

  it('uses the initial snapshot without redundantly scanning from byte zero', async () => {
    await appendLine({ id: 'first', task: 'COLD' });
    const readFrom = config.storage.readIndexLinesFrom;
    let reads = 0;
    config.storage.readIndexLinesFrom = async offset => {
      reads += 1;
      return readFrom(offset);
    };

    await collectTaskEntries('COLD');
    assert.equal(reads, 1);
  });

  it('does not count an unterminated final row until its newline arrives', async () => {
    await fs.writeFile(indexPath, JSON.stringify({ id: 'final', task: 'NEWLINE' }), 'utf8');
    assert.deepEqual(await collectTaskEntries('NEWLINE'), []);

    await fs.appendFile(indexPath, '\n', 'utf8');
    assert.deepEqual((await collectTaskEntries('NEWLINE')).map(row => row.id), ['final']);
  });

  it('rebuilds the cache when the index is replaced by rename', async () => {
    await appendLine({ id: 'old', task: 'REPLACE' });
    assert.deepEqual((await collectTaskEntries('REPLACE')).map(row => row.id), ['old']);

    const replacement = path.join(tempDir, 'replacement.ndjson');
    await fs.writeFile(replacement, JSON.stringify({ id: 'new', task: 'REPLACE' }) + '\n', 'utf8');
    await fs.rename(replacement, indexPath);
    assert.deepEqual((await collectTaskEntries('REPLACE')).map(row => row.id), ['new']);
  });

  it('parses fresh copies so repeated response merges return identical entries', async () => {
    await appendLine({
      id: 'proxy', responseId: 'response-1', task: 'DUPLICATE',
      cost: { cost: 0.02 }, usage: { input_tokens: 12 },
    });
    await appendLine({
      id: 'import', responseId: 'response-1', task: 'DUPLICATE',
      imported: true, skillCalls: { agentflow: 1 },
    });

    const first = await collectTaskEntries('DUPLICATE');
    const second = await collectTaskEntries('DUPLICATE');
    assert.deepEqual(second, first);
    assert.equal(first.length, 1);
    assert.deepEqual(first[0].skillCalls, { agentflow: 1 });
  });

  it('returns endpoint 500 when refresh fails even with cached rows', async () => {
    await appendLine({ id: 'cached', task: 'ERROR' });
    assert.equal((await get('/_api/task-summary?task=ERROR')).status(), 200);

    config.storage.readIndexLinesFrom = async () => { throw new Error('read denied'); };
    const res = await get('/_api/task-summary?task=ERROR');
    assert.equal(res.status(), 500);
    assert.match(JSON.parse(res.body()).error, /read denied/);
  });

  it('rebuilds the cache when the index shrinks', async () => {
    await appendLine({
      id: 'long-old-row', task: 'SHRINK', filler: 'x'.repeat(300),
    });
    assert.deepEqual((await collectTaskEntries('SHRINK')).map(row => row.id), ['long-old-row']);

    await fs.writeFile(indexPath, JSON.stringify({ id: 'short-new-row', task: 'SHRINK' }) + '\n', 'utf8');
    assert.deepEqual((await collectTaskEntries('SHRINK')).map(row => row.id), ['short-new-row']);
  });
});
