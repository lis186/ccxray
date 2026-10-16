'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { buildIndexLine } = require('../server/entry');
const fixture = path.join(__dirname, 'fixtures/atomic-writer.js');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

for (const mode of ['adapter', 'prune']) {
  it(`${mode} writers with the same PID publish only their own complete content`, async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-atomic-'));
    const logs = path.join(home, 'logs');
    fs.mkdirSync(logs);
    const lines = Object.fromEntries(['a', 'b', 'ghost'].map(id => [id, buildIndexLine({
      id, sessionId: `synthetic-${id}`, provider: 'anthropic', model: 'synthetic-model',
      receivedAt: 1717236000000, cost: { cost: 0.01, confidence: 'exact' },
    }) + '\n']));
    fs.writeFileSync(path.join(logs, 'index.ndjson'), mode === 'prune' ? Object.values(lines).join('') : '');
    const children = ['a', 'b'].map(writer => {
      const child = spawn(process.execPath, [fixture, mode, home, writer, String(process.pid)], {
        env: { ...process.env, HOME: home, CCXRAY_HOME: home, LOGS_DIR: logs,
          LOG_RETENTION_DAYS: '14', CCXRAY_EXPORT_DISABLE: '1', CCXRAY_IMPORT_DISABLE: '1',
          CCXRAY_SESSION_INDEX_NO_FLUSH: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stdout.resume();
      child.stderr.on('data', d => { stderr += d; });
      const done = new Promise(resolve => {
        child.once('error', error => resolve({ error }));
        child.once('close', (code, signal) => resolve({ code, signal, stderr }));
      });
      return { child, done };
    });
    const wait = async phase => {
      const deadline = Date.now() + 10000;
      const files = ['a', 'b'].map(w => path.join(home, `${phase}-${w}.json`));
      while (!files.every(f => fs.existsSync(f))) {
        if (children.some(({ child }) => child.exitCode !== null || child.signalCode) || Date.now() > deadline) {
          throw new Error(`writers failed before ${phase}: ${JSON.stringify(await Promise.race([Promise.all(children.map(c => c.done)), delay(50)]))}`);
        }
        await delay(10);
      }
      return files.map(f => JSON.parse(fs.readFileSync(f, 'utf8')));
    };
    const release = (phase, writer) => fs.writeFileSync(path.join(home, `release-${phase}-${writer}`), '');
    const uniquePaths = facts => {
      assert.notEqual(facts[0].realPid, facts[1].realPid);
      assert.notEqual(facts[0].temp, facts[1].temp, 'each write needs its own temp, even with the same PID');
      for (const f of facts) assert.match(path.basename(f.temp), mode === 'prune'
        ? new RegExp(`^index\\.ndjson\\.prune-${process.pid}-[a-f0-9]+\\.tmp$`)
        : new RegExp(`^claude-shared\\.json\\.${process.pid}\\.[a-f0-9]+\\.tmp$`));
    };
    try {
      if (mode === 'prune') {
        uniquePaths(await wait('write'));
        for (const w of ['a', 'b']) release('write', w);
      }
      const facts = await wait('commit');
      uniquePaths(facts);
      for (const [i, writer] of ['a', 'b'].entries()) {
        if (mode === 'prune') assert.equal(facts[i].content, lines[writer]);
        else assert.equal(JSON.parse(facts[i].content).fiveHour.usedPct, i === 0 ? 11 : 22);
      }
      release('commit', 'a');
      assert.equal((await children[0].done).code, 0);
      const target = mode === 'prune' ? path.join(logs, 'index.ndjson') : path.join(home, 'usage-status/claude-shared.json');
      assert.equal(fs.readFileSync(target, 'utf8'), facts[0].content);
      release('commit', 'b');
      assert.equal((await children[1].done).code, 0);
      // Prune's second CAS loses; status snapshots are last-writer-wins.
      assert.equal(fs.readFileSync(target, 'utf8'), facts[mode === 'prune' ? 0 : 1].content);
    } finally {
      for (const { child } of children) if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL');
      await Promise.all(children.map(c => c.done));
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
}
