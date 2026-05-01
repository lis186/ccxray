'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

// The script switches between CLI mode and module mode via require.main.
// Required as a module here, exports the testable internals.
const { canDelta, safeParseFirst, probeChainDepth } = require('../scripts/migrate-to-delta');

// ── canDelta (alias of findSharedPrefixFromLast) ────────────────────

describe('migrate-to-delta: canDelta', () => {
  const m = (text) => ({ role: 'user', content: [{ type: 'text', text }] });

  it('returns 0 for empty/missing prev', () => {
    assert.equal(canDelta(null, 0, [m('a')]), 0);
    assert.equal(canDelta(m('a'), 0, [m('a')]), 0);
  });

  it('returns 0 when curr length <= prev count (retry/compaction)', () => {
    assert.equal(canDelta(m('b'), 2, [m('a'), m('b')]), 0); // exact retry
    assert.equal(canDelta(m('c'), 3, [m('a')]), 0);          // compaction
  });

  it('returns prev count when curr extends prev (append-only)', () => {
    const curr = [m('a'), m('b'), m('c'), m('d')];
    assert.equal(canDelta(m('b'), 2, curr), 2);
  });

  it('returns 0 when last shared msg disagrees', () => {
    const curr = [m('a'), m('different'), m('c')];
    assert.equal(canDelta(m('b'), 2, curr), 0);
  });
});

// ── safeParseFirst (legacy double-JSON-concatenated files) ──────────

describe('migrate-to-delta: safeParseFirst', () => {
  it('parses a normal JSON object', () => {
    assert.deepEqual(safeParseFirst('{"a":1}'), { a: 1 });
  });

  it('parses the first object when two are concatenated', () => {
    const concat = '{"a":1}{"b":2}';
    assert.deepEqual(safeParseFirst(concat), { a: 1 });
  });

  it('returns null on completely invalid JSON', () => {
    assert.equal(safeParseFirst('not json'), null);
    assert.equal(safeParseFirst(''), null);
  });

  it('handles strings that contain {} characters inside string values', () => {
    const text = '{"a":"hi { } there","b":2}{"c":3}';
    assert.deepEqual(safeParseFirst(text), { a: 'hi { } there', b: 2 });
  });

  it('handles escaped quotes inside strings', () => {
    const text = '{"q":"he said \\"hi\\""}';
    assert.deepEqual(safeParseFirst(text), { q: 'he said "hi"' });
  });

  it('parses nested objects correctly', () => {
    const text = '{"a":{"nested":{"deep":1}}}';
    assert.deepEqual(safeParseFirst(text), { a: { nested: { deep: 1 } } });
  });
});

// ── probeChainDepth ─────────────────────────────────────────────────

describe('migrate-to-delta: probeChainDepth', () => {
  const tmpDir = path.join(os.tmpdir(), 'ccxray-probe-test-' + Date.now());

  before(async () => {
    await fsp.mkdir(tmpDir, { recursive: true });
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function writeReq(id, body) {
    await fsp.writeFile(path.join(tmpDir, id + '_req.json'), JSON.stringify(body));
  }

  it('returns 1 when delta points directly at an anchor (FULL)', async () => {
    await writeReq('anchor-1', { model: 'm', messages: [{ role: 'user', content: 'a' }] });
    const delta = { prevId: 'anchor-1', msgOffset: 1, messages: [] };
    assert.equal(await probeChainDepth(delta, tmpDir, 20), 1);
  });

  it('counts hops up to the first anchor', async () => {
    await writeReq('a-2', { model: 'm', messages: [{ role: 'user', content: 'a' }] });
    await writeReq('d-2-1', { prevId: 'a-2', msgOffset: 1, messages: [] });
    await writeReq('d-2-2', { prevId: 'd-2-1', msgOffset: 1, messages: [] });
    const delta = { prevId: 'd-2-2', msgOffset: 1, messages: [] };
    // The supplied delta + d-2-2 + d-2-1 = 3 deltas before hitting a-2 anchor
    assert.equal(await probeChainDepth(delta, tmpDir, 20), 3);
  });

  it('caps at the requested limit even if chain is longer', async () => {
    await writeReq('a-3', { model: 'm', messages: [{ role: 'user', content: 'a' }] });
    let prev = 'a-3';
    for (let i = 0; i < 10; i++) {
      const id = `d-3-${i}`;
      await writeReq(id, { prevId: prev, msgOffset: 1, messages: [] });
      prev = id;
    }
    const delta = { prevId: prev, msgOffset: 1, messages: [] };
    // Cap at 5: should stop walking once depth hits 5 even though chain is deeper
    assert.equal(await probeChainDepth(delta, tmpDir, 5), 5);
  });

  it('breaks when a prevId points to a missing file', async () => {
    const delta = { prevId: 'does-not-exist', msgOffset: 1, messages: [] };
    assert.equal(await probeChainDepth(delta, tmpDir, 20), 1);
  });

  it('breaks on parse failure mid-chain', async () => {
    await writeReq('a-4', { model: 'm', messages: [] });
    await fsp.writeFile(path.join(tmpDir, 'corrupt-4_req.json'), 'not-json{');
    await writeReq('d-4', { prevId: 'corrupt-4', msgOffset: 1, messages: [] });
    const delta = { prevId: 'd-4', msgOffset: 1, messages: [] };
    // d-4 is delta (depth=2), then corrupt-4 fails parse → break, depth stays at 2
    assert.equal(await probeChainDepth(delta, tmpDir, 20), 2);
  });

  it('returns 1 when prevId is missing/null on the input delta itself', async () => {
    assert.equal(await probeChainDepth({ prevId: null, msgOffset: 0, messages: [] }, tmpDir, 20), 1);
    assert.equal(await probeChainDepth({}, tmpDir, 20), 1);
  });
});

// ── End-to-end migration on a synthetic logs dir ─────────────────────

describe('migrate-to-delta: end-to-end on synthetic logs', () => {
  const tmpDir = path.join(os.tmpdir(), 'ccxray-migrate-e2e-' + Date.now());
  const scriptPath = path.join(__dirname, '..', 'scripts', 'migrate-to-delta.js');

  before(async () => {
    await fsp.mkdir(tmpDir, { recursive: true });
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Run the script as a subprocess with a custom --logs-dir, capture stdout.
  async function runMigration(extraArgs = []) {
    const { spawn } = require('child_process');
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [scriptPath, '--logs-dir', tmpDir, ...extraArgs], {
        env: { ...process.env, CCXRAY_DELTA_SNAPSHOT_N: '0' },
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', d => { stdout += d; });
      child.stderr.on('data', d => { stderr += d; });
      child.on('close', code => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`exit ${code}: ${stderr}`)));
    });
  }

  it('filters sub-agent rows out of session chains (P1)', async () => {
    // Build a synthetic session with: 2 main turns + 1 sub-agent injection + 2 main turns
    // Sub-agent has msgCount=1 (unrelated content) and isSubagent: true.
    const sid = 'sess-aaa';
    const indexLines = [];
    const m = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
    const a = (text) => ({ role: 'assistant', content: [{ type: 'text', text }] });

    const turns = [
      { id: '2026-01-01T00-00-00-001', isSubagent: false, msgs: [m('hi')] },
      { id: '2026-01-01T00-00-00-002', isSubagent: false, msgs: [m('hi'), a('hello'), m('go')] },
      { id: '2026-01-01T00-00-00-003', isSubagent: true,  msgs: [m('subagent task')] },
      { id: '2026-01-01T00-00-00-004', isSubagent: false, msgs: [m('hi'), a('hello'), m('go'), a('done'), m('next')] },
      { id: '2026-01-01T00-00-00-005', isSubagent: false, msgs: [m('hi'), a('hello'), m('go'), a('done'), m('next'), a('ok'), m('more')] },
    ];

    for (const t of turns) {
      await fsp.writeFile(path.join(tmpDir, t.id + '_req.json'),
        JSON.stringify({ model: 'm', max_tokens: 100, messages: t.msgs }));
      indexLines.push(JSON.stringify({
        id: t.id, sessionId: sid, msgCount: t.msgs.length,
        isSubagent: t.isSubagent, sessionInferred: false,
      }));
    }
    await fsp.writeFile(path.join(tmpDir, 'index.ndjson'), indexLines.join('\n') + '\n');

    const { stdout } = await runMigration(['--write']);
    assert.match(stdout, /Skipped \(subagent\):\s+1/, 'should skip 1 sub-agent row');

    // Verify the sub-agent file was NOT rewritten (still FULL with msgCount=1)
    const subAgentRaw = JSON.parse(await fsp.readFile(path.join(tmpDir, '2026-01-01T00-00-00-003_req.json'), 'utf8'));
    assert.ok(!('prevId' in subAgentRaw), 'sub-agent file must not be converted to delta');
    assert.equal(subAgentRaw.messages.length, 1);

    // Verify main-thread turns 4 and 5 were converted to delta (chain not broken by sub-agent)
    const turn4 = JSON.parse(await fsp.readFile(path.join(tmpDir, '2026-01-01T00-00-00-004_req.json'), 'utf8'));
    assert.equal(turn4.prevId, '2026-01-01T00-00-00-002', 'turn 4 should delta from turn 2 (turn 3 is filtered)');
    const turn5 = JSON.parse(await fsp.readFile(path.join(tmpDir, '2026-01-01T00-00-00-005_req.json'), 'utf8'));
    assert.equal(turn5.prevId, '2026-01-01T00-00-00-004');
  });

  it('continues chain across an existing delta (P2)', async () => {
    // Reset tmpDir for this test
    fs.rmSync(tmpDir, { recursive: true, force: true });
    await fsp.mkdir(tmpDir, { recursive: true });

    const sid = 'sess-bbb';
    const m = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
    const a = (text) => ({ role: 'assistant', content: [{ type: 'text', text }] });

    const fullMsgs2 = [m('a'), a('b'), m('c')];
    const fullMsgs4 = [m('a'), a('b'), m('c'), a('d'), m('e')];

    // Turn 1: FULL anchor
    await fsp.writeFile(path.join(tmpDir, 't-001_req.json'),
      JSON.stringify({ model: 'm', max_tokens: 100, messages: [m('a')] }));
    // Turn 2: FULL (will be converted to delta in this run)
    await fsp.writeFile(path.join(tmpDir, 't-002_req.json'),
      JSON.stringify({ model: 'm', max_tokens: 100, messages: fullMsgs2 }));
    // Turn 3: PRE-EXISTING delta (live server already converted it)
    await fsp.writeFile(path.join(tmpDir, 't-003_req.json'),
      JSON.stringify({
        model: 'm', max_tokens: 100,
        prevId: 't-002', msgOffset: 3,
        messages: [a('d')],
      }));
    // Turn 4: FULL (script should be able to delta this from turn 3 thanks to chain-resume)
    await fsp.writeFile(path.join(tmpDir, 't-004_req.json'),
      JSON.stringify({ model: 'm', max_tokens: 100, messages: fullMsgs4 }));

    const indexLines = ['t-001', 't-002', 't-003', 't-004'].map(id => JSON.stringify({
      id, sessionId: sid, msgCount: 1, isSubagent: false, sessionInferred: false,
    }));
    await fsp.writeFile(path.join(tmpDir, 'index.ndjson'), indexLines.join('\n') + '\n');

    const { stdout } = await runMigration(['--write']);
    assert.match(stdout, /Existing deltas:\s+1/, 'should track 1 existing delta');

    const turn4 = JSON.parse(await fsp.readFile(path.join(tmpDir, 't-004_req.json'), 'utf8'));
    assert.ok('prevId' in turn4, 'turn 4 must be converted to delta (chain resumed across t-003)');
    // turn 4 should chain from t-003 (the existing delta) since that's the most recent
    assert.equal(turn4.prevId, 't-003');
  });

  it('reports anchor-by-reason breakdown matching expected sum (P3)', async () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    await fsp.mkdir(tmpDir, { recursive: true });

    // Two sessions, 3 turns each. Each turn adds a user+assistant pair so the
    // shared-prefix count grows by 2 per turn (canDelta requires sharedCount >= 2).
    // Expected: turn 1 of each session is first-in-session anchor (=2), turns 2 and
    // 3 of each session become deltas (=4).
    const m = (i) => ({ role: 'user', content: [{ type: 'text', text: `u-${i}` }] });
    const a = (i) => ({ role: 'assistant', content: [{ type: 'text', text: `a-${i}` }] });
    const indexLines = [];
    for (const sid of ['s1', 's2']) {
      for (let i = 1; i <= 3; i++) {
        const id = `${sid}-t${i}`;
        const msgs = [];
        for (let k = 0; k < i; k++) { msgs.push(m(k)); msgs.push(a(k)); }
        await fsp.writeFile(path.join(tmpDir, id + '_req.json'),
          JSON.stringify({ model: 'm', max_tokens: 100, messages: msgs }));
        indexLines.push(JSON.stringify({ id, sessionId: sid, msgCount: msgs.length, isSubagent: false, sessionInferred: false }));
      }
    }
    await fsp.writeFile(path.join(tmpDir, 'index.ndjson'), indexLines.join('\n') + '\n');

    const { stdout } = await runMigration([]);

    assert.match(stdout, /first-in-session:\s+2/);
    assert.match(stdout, /Anchors:\s+2 \(= 2 expected\)/);
    assert.match(stdout, /Files converted:\s+4 \/ 6 eligible/);
  });
});
