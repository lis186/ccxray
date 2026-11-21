'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const script = path.resolve(__dirname, '../scripts/weather-replay.js');

// File-backed stdio keeps this usable in sandboxes that reject child pipes.
function replay(args, options) {
  const dir = options.env.HOME;
  const out = path.join(dir, 'stdout'), err = path.join(dir, 'stderr');
  const stdout = fs.openSync(out, 'w'), stderr = fs.openSync(err, 'w');
  let result;
  try {
    result = spawnSync(process.execPath, args, { env: options.env,
      timeout: options.timeout || 10000, stdio: ['ignore', stdout, stderr] });
  } finally { fs.closeSync(stdout); fs.closeSync(stderr); }
  assert.ifError(result.error);
  assert.equal(result.status, 0, fs.readFileSync(err, 'utf8'));
  return fs.readFileSync(out, 'utf8');
}

// Build the pre-two-pass execution path from the unchanged reference helpers.
// Run it on separate parses: mergeByResponseId mutates canonical objects.
function legacySource() {
  return fs.readFileSync(script, 'utf8').replace(
    /  const fd = fs.openSync\(indexPath, 'r'\);[\s\S]*?finally \{ fs.closeSync\(fd\); \}/,
    `  const rl = require('readline').createInterface({ input: fs.createReadStream(indexPath), crlfDelay: Infinity });
  const ing = await ingest(rl, provider);
  ing.kept = ing.all.length;
  const first = measure(groupFirstSeen(ing.all));
  const merged = measure(groupMerged(ing.all));`);
}

function fixture() {
  const rows = [];
  for (let turn = 0; turn < 12; turn++) {
    for (let sid = 0; sid < 25; sid++) {
      const calls = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`call-${i}`, 'Bash']));
      rows.push(JSON.stringify({ id: `${sid}-${turn}`, sessionId: `session-${sid}-雪`,
        responseId: `rid-${sid}-${Math.floor(turn / 2)}`, receivedAt: 12 - turn,
        provider: sid % 2 ? 'anthropic' : 'openai', isSubagent: turn === 0,
        ...(turn % 2 ? { turnToolResults: Object.keys(calls).map(callId => ({ callId,
          toolFail: sid % 3 === 0, eligible: true })) } : { turnToolCallIds: calls }),
        toolCalls: { Bash: 6 }, turnToolCalls: { Bash: 6 } }));
    }
  }
  // Cross-session duplicate groups, authority moves, imported canonical choices,
  // absent responseIds, no-sid/provider exclusions and malformed/blank rows.
  rows.push(JSON.stringify({ id: 'cross-proxy', responseId: 'cross', sessionId: 'weak', receivedAt: 1, isSubagent: true }));
  rows.push(JSON.stringify({ id: 'cross-import', responseId: 'cross', sessionId: 'strong', imported: true,
    receivedAt: 2, sessionInferred: false, agentKey: 'main', isSubagent: false, turnToolCallIds: { a: 'Bash' } }));
  rows.push(JSON.stringify({ id: 'plain', sessionId: 'weak', receivedAt: 3 }));
  rows.push('{}', '{bad', '', JSON.stringify({ sessionId: 'only-subagent', isSubagent: true }));
  return rows.join('\r\n'); // also exercise a valid EOF row without a newline
}

test('two-pass stdout equals whole-corpus replay, including snapshot appends', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weather-equivalence-'));
  try {
    const index = path.join(dir, 'index.ndjson');
    const preload = path.join(dir, 'runner.cjs');
    const legacy = path.join(dir, 'legacy-source.txt');
    fs.writeFileSync(legacy, legacySource());
    // Append deterministically after the descriptor's snapshot has been taken.
    // Neither pass may consume this row, including when appended to an EOF row.
    fs.writeFileSync(preload, `const fs = require('fs');
      if (process.env.REPLAY_APPEND) {
        let done = false;
        const append = () => {
          if (done) return;
          done = true;
          fs.appendFileSync(process.env.REPLAY_INDEX,
            '\\n' + JSON.stringify({sessionId:'post-snapshot', id:'late'}) + '\\n');
        };
        if (process.env.REPLAY_APPEND === 'stat') {
          const stat = fs.fstatSync;
          fs.fstatSync = function(fd, ...args) {
            const result = stat.call(this, fd, ...args);
            append();
            return result;
          };
        } else {
          const stream = fs.createReadStream;
          fs.createReadStream = function(...args) {
            const input = stream.apply(this, args);
            input.once('end', append);
            return input;
          };
        }
      }
      {
        const Module = require('module');
        const m = new Module(process.env.REPLAY_SCRIPT);
        m.filename = process.env.REPLAY_SCRIPT;
        m.paths = Module._nodeModulePaths(require('path').dirname(m.filename));
        m._compile(fs.readFileSync(process.env.REPLAY_LEGACY || process.env.REPLAY_SCRIPT, 'utf8'), m.filename);
      }`);
    const env = { ...process.env, HOME: dir, CCXRAY_HOME: dir, REPLAY_INDEX: index, REPLAY_SCRIPT: script };
    for (const key of ['LOGS_DIR', 'CCXRAY_AGENT_ID', 'ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL']) delete env[key];
    for (const flags of [[], ['--list-bad'], ['--provider', 'anthropic'], ['--provider', 'openai', '--list-bad']]) {
      fs.writeFileSync(index, fixture());
      const expected = replay([preload, '--index', index, ...flags],
        { env: { ...env, REPLAY_LEGACY: legacy }, encoding: 'utf8', timeout: 10000 });
      const oneReport = expected;
      for (const append of [null, 'stat', 'end']) {
        fs.writeFileSync(index, fixture());
        const actual = replay([preload, '--index', index, ...flags],
          { env: { ...env, ...(append ? { REPLAY_APPEND: append } : {}) }, encoding: 'utf8', timeout: 10000 });
        assert.equal(actual, oneReport, `stdout differs: ${flags.join(' ')} append=${append}`);
      }
    }
    fs.writeFileSync(index, '');
    const empty = replay([script, '--index', index], { env, encoding: 'utf8' });
    assert.match(empty, /lines consumed: 0 \(kept 0/);
    assert.match(empty, /sessions: 0/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
