'use strict';

// A-010/A-011: one rate lookup (lookupRates, default-rates.js) shared by every
// pricing site. Covers design.md's Acceptance criteria R-1..R-7, H5, H6.
// See .agentflow/artifacts/A-010-pricing-single-source/design.md.
//
// Synthetic fixture only (never real logs/paths/ids): model `gpt-6-astra`,
// usage 17,695 in / 42 out / 7,040 cache read, fixture rates input $10 /
// output $50 / cache_read $1 / cache_create $12.5 per MTok -> $0.18609.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { spawnSync, fork } = require('child_process');

// F3 (acceptance-report.md): server/paths.js resolves LOGS_DIR from HOME/
// CCXRAY_HOME at REQUIRE time (server/config.js), and every require below
// (importer, routes/api) pulls in session-index.js -> config.js. Isolate this
// file's own process BEFORE that happens, so the H6 tests' updateFromEntry
// calls — and any flush timer they schedule — can never target the
// developer's real ~/.ccxray, even when this file is run standalone without
// CCXRAY_HOME/HOME set (each `node --test` file is its own subprocess, so this
// cannot affect other test files).
const _isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-a010-isolated-home-'));
process.env.HOME = _isolatedHome;
process.env.CCXRAY_HOME = path.join(_isolatedHome, '.ccxray');
process.on('exit', () => { try { fs.rmSync(_isolatedHome, { recursive: true, force: true }); } catch {} });

const pricing = require('../server/pricing');
const defaultRates = require('../server/default-rates');
const anthropicParser = require('../server/wire-parsers/anthropic');
const openaiParser = require('../server/wire-parsers/openai');
const importer = require('../server/importer');
const costWorker = require('../server/cost-worker');
const { normalizeIndexEntry } = require('../server/routes/api');

const REPO_ROOT = path.join(__dirname, '..');
const USAGE = { input_tokens: 17695, output_tokens: 42, cache_read_input_tokens: 7040, cache_creation_input_tokens: 0 };
const MODEL = 'gpt-6-astra';
const FIXTURE_PRICING = { [MODEL]: { input: 10, output: 50, cache_create: 12.5, cache_read: 1 } };
const EXPECTED_COST = 0.18609;
const closeTo = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

function writeFixtureCache(dir, pricingObj) {
  const cachePath = path.join(dir, 'pricing-cache.json');
  fs.writeFileSync(cachePath, JSON.stringify({ fetchedAt: Date.now(), pricing: pricingObj, context: {} }));
  return cachePath;
}

// Points CCXRAY_PRICING_CACHE at a synthetic fixture and resets default-rates.js's
// lazily-loaded singleton (__resetRateTableForTests) so the next lookupRates()
// call re-reads it — no require.cache surgery needed (the path is read fresh on
// every _ensureRateTable() call, not once at require time).
async function withCache(pricingObj, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-a010-'));
  const cachePath = writeFixtureCache(dir, pricingObj);
  const prevEnv = process.env.CCXRAY_PRICING_CACHE;
  process.env.CCXRAY_PRICING_CACHE = cachePath;
  defaultRates.__resetRateTableForTests();
  try {
    return await fn(dir, cachePath);
  } finally {
    defaultRates.__resetRateTableForTests();
    if (prevEnv === undefined) delete process.env.CCXRAY_PRICING_CACHE;
    else process.env.CCXRAY_PRICING_CACHE = prevEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// R-3/INV-3: CCXRAY_PRICING_CACHE pointing at a path that does not exist.
async function withMissingCache(fn) {
  const missing = path.join(os.tmpdir(), 'ccxray-a010-missing-' + Date.now() + Math.random(), 'pricing-cache.json');
  const prevEnv = process.env.CCXRAY_PRICING_CACHE;
  process.env.CCXRAY_PRICING_CACHE = missing;
  defaultRates.__resetRateTableForTests();
  try {
    return await fn();
  } finally {
    defaultRates.__resetRateTableForTests();
    if (prevEnv === undefined) delete process.env.CCXRAY_PRICING_CACHE;
    else process.env.CCXRAY_PRICING_CACHE = prevEnv;
  }
}

// ── R-1/INV-1: one test per path, fixture cache has gpt-6-astra ─────────

describe('A-010 R-1/INV-1: one lookup, every path gets exact $0.18609', () => {
  it('pricing.calculateCost (shared by proxy HTTP, WS, restore, cold-load, rebuild-index)', async () => {
    await withCache(FIXTURE_PRICING, () => {
      const r = pricing.calculateCost(USAGE, MODEL, 'openai');
      assert.ok(closeTo(r.cost, EXPECTED_COST));
      assert.equal(r.confidence, 'exact');
    });
  });

  it('default-rates.calculateCostSimple (shared by importer, cost-worker)', async () => {
    await withCache(FIXTURE_PRICING, () => {
      const r = defaultRates.calculateCostSimple(USAGE, MODEL, 'openai');
      assert.ok(closeTo(r.cost, EXPECTED_COST));
      assert.equal(r.confidence, 'exact');
    });
  });

  it('anthropic.buildEntryFields (proxy HTTP Anthropic; rebuild-index uses this same function)', async () => {
    await withCache(FIXTURE_PRICING, () => {
      const fields = anthropicParser.buildEntryFields({
        parsedBody: { model: MODEL, messages: [] },
        usage: USAGE, cwd: '/tmp', sessionId: 's1', isSubagent: false, sessionInferred: false,
      });
      assert.ok(closeTo(fields.cost.cost, EXPECTED_COST));
      assert.equal(fields.cost.confidence, 'exact');
    });
  });

  it('openai.buildEntryFields — proxy HTTP OpenAI (non-SSE)', async () => {
    await withCache(FIXTURE_PRICING, () => {
      const fields = openaiParser.buildEntryFields({
        parsedBody: { model: MODEL, input: [] }, transport: 'http', proxyRes: { statusCode: 200 },
        lastUsage: USAGE, cwd: '/tmp', sessionId: 's1', isSubagent: false, sessionInferred: false,
      });
      assert.ok(closeTo(fields.cost.cost, EXPECTED_COST));
      assert.equal(fields.cost.confidence, 'exact');
    });
  });

  it('openai.buildEntryFields — WebSocket (Codex/Grok WS proxy)', async () => {
    await withCache(FIXTURE_PRICING, () => {
      const fields = openaiParser.buildEntryFields({
        parsedBody: { model: MODEL, input: [] }, transport: 'websocket',
        lastUsage: USAGE, cwd: '/tmp', sessionId: 's1', isSubagent: false, sessionInferred: false,
      });
      assert.ok(closeTo(fields.cost.cost, EXPECTED_COST));
      assert.equal(fields.cost.confidence, 'exact');
    });
  });

  it('importer.parseSessionFile — Claude transcript import (also import --once/--target-transcript)', async () => {
    await withCache(FIXTURE_PRICING, async (dir) => {
      const file = path.join(dir, 'claude-sess.jsonl');
      fs.writeFileSync(file, JSON.stringify({
        type: 'assistant', timestamp: '2026-09-01T00:00:00.000Z',
        message: { id: 'msg_1', model: MODEL, usage: USAGE },
      }) + '\n');
      const entries = await importer.parseSessionFile(file, '-proj');
      assert.equal(entries.length, 1);
      assert.ok(closeTo(entries[0].cost.cost, EXPECTED_COST));
      assert.equal(entries[0].cost.confidence, 'exact');
    });
  });

  it('importer.parseCodexSessionFile — Codex transcript import (also import --once/--target-transcript)', async () => {
    await withCache(FIXTURE_PRICING, async (dir) => {
      const file = path.join(dir, 'codex-sess.jsonl');
      const lines = [
        JSON.stringify({ timestamp: '2026-09-01T00:00:00.000Z', type: 'turn_context', payload: { model: MODEL } }),
        JSON.stringify({
          timestamp: '2026-09-01T00:00:01.000Z', type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: { input_tokens: 24735, cached_input_tokens: 7040, output_tokens: 42 },
              model_context_window: 400000,
            },
          },
        }),
      ];
      fs.writeFileSync(file, lines.join('\n') + '\n');
      const entries = await importer.parseCodexSessionFile(file);
      assert.equal(entries.length, 1);
      assert.ok(closeTo(entries[0].cost.cost, EXPECTED_COST));
      assert.equal(entries[0].cost.confidence, 'exact');
      // Item 4: importer writes the marker on new Codex imports.
      assert.equal(entries[0].usage._ccxrayUsageNormalized, true);
      assert.equal(entries[0].usage.input_tokens, 17695);
    });
  });

  it('cost-worker child process (forked, no live pricing of its own)', async () => {
    await withCache(FIXTURE_PRICING, async (dir, cachePath) => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-a010-home-'));
      try {
        const projDir = path.join(home, '.claude', 'projects', 'proj1');
        fs.mkdirSync(projDir, { recursive: true });
        fs.writeFileSync(path.join(projDir, 'sess1.jsonl'), JSON.stringify({
          type: 'assistant', timestamp: '2026-09-01T00:00:00.000Z',
          message: { id: 'msg_1', model: MODEL, usage: USAGE },
        }) + '\n');
        const worker = fork(path.join(REPO_ROOT, 'server', 'cost-worker.js'), [], {
          silent: true,
          env: { ...process.env, HOME: home, CCXRAY_HOME: home, CCXRAY_PRICING_CACHE: cachePath },
        });
        let out = '';
        worker.stdout.on('data', c => { out += c; });
        const exitCode = await new Promise(resolve => worker.on('exit', resolve));
        assert.equal(exitCode, 0);
        const entries = JSON.parse(out);
        const e = entries.find(x => x.model === MODEL);
        assert.ok(e, 'worker must report the gpt-6-astra entry');
        assert.ok(closeTo(e.costUSD, EXPECTED_COST));
        assert.equal(e.costConfidence, 'exact');
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  });

  it('rebuild-index — orphan recovery through anthropic.buildEntryFields', async () => {
    await withCache(FIXTURE_PRICING, async (dir) => {
      const { createLocalStorage } = require('../server/storage/local');
      const { rebuildIndex } = require('../server/rebuild-index');
      const hub = require('../server/hub');
      const prevReadHubLock = hub.readHubLock;
      hub.readHubLock = () => null;
      process.env.CCXRAY_SKIP_RECENCY_CHECK = '1';
      const logsDir = path.join(dir, 'logs');
      const storage = createLocalStorage(logsDir);
      await storage.init();
      const id = '2026-09-01T00-00-00-000';
      fs.writeFileSync(path.join(logsDir, `${id}_req.json`), JSON.stringify({
        model: MODEL, max_tokens: 100, messages: [{ role: 'user', content: 'hi' }],
        metadata: { session_id: 'S1' },
      }));
      fs.writeFileSync(path.join(logsDir, `${id}_res.json`), JSON.stringify([
        { type: 'message_start', message: { id: 'msg_orphan', usage: USAGE } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: USAGE.output_tokens } },
      ]));
      try {
        const res = await rebuildIndex({ apply: true, storage, log: () => {} });
        assert.equal(res.recovered, 1);
        const lines = fs.readFileSync(path.join(logsDir, 'index.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
        assert.ok(closeTo(lines[0].cost.cost, EXPECTED_COST));
        assert.equal(lines[0].cost.confidence, 'exact');
      } finally {
        hub.readHubLock = prevReadHubLock;
        delete process.env.CCXRAY_SKIP_RECENCY_CHECK;
      }
    });
  });

  it('restore reload — healMetaInPlace (via restoreFromLogs, spawned)', async () => {
    await withCache(FIXTURE_PRICING, async (dir, cachePath) => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-a010-restore-'));
      try {
        const logsDir = path.join(home, 'logs');
        fs.mkdirSync(logsDir, { recursive: true });
        fs.writeFileSync(path.join(logsDir, 'index.ndjson'), JSON.stringify({
          id: '2026-09-01T00-00-00-000', ts: '00:00:00', sessionId: 'restore-sess', provider: 'openai',
          model: MODEL, imported: true, importSource: 'codex',
          usage: USAGE, // legacy: no _ccxrayUsageNormalized marker
          cost: { cost: 0.055827, confidence: 'fallback' }, maxContext: 400000,
          isSSE: false, status: 200, receivedAt: 1779000000000,
        }) + '\n');
        const driver = `
          console.time = console.timeEnd = console.log = console.warn = () => {};
          const { restoreFromLogs } = require('./server/restore');
          const store = require('./server/store');
          restoreFromLogs().then(() => {
            const e = store.entries.find(x => x.sessionId === 'restore-sess');
            process.stdout.write(JSON.stringify({ usage: e.usage, cost: e.cost }));
          }).catch(e => { process.stderr.write(e.stack); process.exit(1); });
        `;
        const result = spawnSync(process.execPath, ['-e', driver], {
          cwd: REPO_ROOT,
          env: { ...process.env, CCXRAY_HOME: home, CCXRAY_PRICING_CACHE: cachePath, RESTORE_DAYS: '0', CCXRAY_DISABLE_TITLES: '1' },
          encoding: 'utf8', timeout: 15000,
        });
        assert.equal(result.status, 0, `child failed: ${result.stderr}`);
        const out = JSON.parse(result.stdout);
        assert.equal(out.usage.input_tokens, 17695, 'R-2: no double subtraction on reload');
        assert.ok(closeTo(out.cost.cost, EXPECTED_COST));
        assert.equal(out.cost.confidence, 'exact');
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  });

  it('cold-load — normalizeIndexEntry', async () => {
    await withCache(FIXTURE_PRICING, () => {
      const meta = {
        id: 'cold1', sessionId: 's', provider: 'openai', model: MODEL, imported: true, importSource: 'codex',
        usage: { ...USAGE }, // legacy: no marker
        cost: { cost: 0.055827, confidence: 'fallback' },
      };
      const out = normalizeIndexEntry(meta);
      assert.equal(out.usage.input_tokens, 17695, 'R-2: no double subtraction on cold-load');
      assert.ok(closeTo(out.cost.cost, EXPECTED_COST));
      assert.equal(out.cost.confidence, 'exact');
    });
  });
});

// ── F1 regression (acceptance-report.md, fails on f55b866) ──────────────
// _ensureRateTable() (default-rates.js) merged the price-cache without
// mirroring provider-prefixed keys, while pricing.js's buildPricingTable()
// did — so the SAME cache shape (a `xai/<model>` row plus a suffixed wire id)
// matched by prefix through the built-table path and missed (null/unknown)
// through the lazy path. Fixed by moving mirrorProviderPrefixedKeys and one
// pure buildRateTable() into default-rates.js and having both paths call it.

const XAI_MODEL = 'grok-9-fast-20260910';
const XAI_FIXTURE_PRICING = { 'xai/grok-9-fast': { input: 3, output: 9, cache_create: 3, cache_read: 0.3 } };
const EXPECTED_XAI_COST = 0.055575;

describe('A-010 F1: the lazy singleton and buildPricingTable build the SAME table', () => {
  it('lazy path (default-rates.calculateCostSimple, shared by importer/cost-worker) matches by prefix', async () => {
    await withCache(XAI_FIXTURE_PRICING, () => {
      const r = defaultRates.calculateCostSimple(USAGE, XAI_MODEL, 'xai');
      assert.ok(closeTo(r.cost, EXPECTED_XAI_COST), `lazy cost was ${r.cost}`);
      assert.equal(r.confidence, 'prefix', 'F1: _ensureRateTable() must mirror xai/ keys, same as buildPricingTable');
    });
  });

  it('cost-worker.processGrokIndexEntry (pure import, no fork needed) agrees with the lazy path', async () => {
    await withCache(XAI_FIXTURE_PRICING, () => {
      const result = costWorker.processGrokIndexEntry({ agent: 'grok', usage: USAGE, model: XAI_MODEL, receivedAt: Date.now() });
      assert.ok(closeTo(result.costUSD, EXPECTED_XAI_COST), `cost-worker cost was ${result.costUSD}`);
      assert.equal(result.costConfidence, 'prefix');
    });
  });

  it('built-table path (buildPricingTable + setRateTable, the live proxy after fetchPricing()) gives the identical result, and buildPricingTable(x) deep-equals the lazily built table for the same cache x', async () => {
    await withCache(XAI_FIXTURE_PRICING, () => {
      const lazy = defaultRates.calculateCostSimple(USAGE, XAI_MODEL, 'xai');
      const lazyTable = defaultRates.__getRateTableForTests();

      const built = pricing.buildPricingTable(XAI_FIXTURE_PRICING);
      assert.deepEqual(built, lazyTable, 'F1: buildPricingTable(x) must deep-equal the lazily built table for the same cache object x');

      defaultRates.setRateTable(built);
      const live = pricing.calculateCost(USAGE, XAI_MODEL, 'xai');
      assert.ok(closeTo(live.cost, EXPECTED_XAI_COST), `built-table cost was ${live.cost}`);
      assert.equal(live.confidence, 'prefix');
      assert.ok(closeTo(live.cost, lazy.cost), `F1: lazy (${lazy.cost}) and built (${live.cost}) paths must resolve the same (usage, model, provider) to the same cost`);
      assert.equal(live.confidence, lazy.confidence, 'F1: and the same confidence');
    });
  });
});

// ── R-2/INV-2: idempotent usage normalization ───────────────────────────

describe('A-010 R-2/INV-2: imported Codex usage never double-subtracts', () => {
  it('a new import (marker present) survives reload+cold-load unchanged', async () => {
    await withCache(FIXTURE_PRICING, () => {
      const marked = { ...USAGE, _ccxrayUsageNormalized: true };
      const out1 = normalizeIndexEntry({ id: 'n1', sessionId: 's', provider: 'openai', model: MODEL, imported: true, importSource: 'codex', usage: { ...marked }, cost: { cost: 1, confidence: 'exact' } });
      assert.equal(out1.usage.input_tokens, 17695);
      // Re-normalizing the already-normalized output again must still be a no-op.
      const out2 = normalizeIndexEntry({ ...out1, usage: { ...out1.usage } });
      assert.equal(out2.usage.input_tokens, 17695);
    });
  });

  it('a legacy import (no marker) is treated as normalized by the read-side guard, not re-subtracted', async () => {
    await withCache(FIXTURE_PRICING, () => {
      const out = normalizeIndexEntry({ id: 'l1', sessionId: 's', provider: 'openai', model: MODEL, imported: true, importSource: 'codex', usage: { ...USAGE }, cost: { cost: 0.055827, confidence: 'fallback' } });
      assert.equal(out.usage.input_tokens, 17695, 'must NOT become 17695-7040=10655');
      assert.equal(out.usage._ccxrayUsageNormalized, true);
    });
  });

  it('a non-imported openai (proxy) line is unaffected by the read-side guard', async () => {
    await withCache(FIXTURE_PRICING, () => {
      // proxy-written usage already carries the marker (openai.js normalizeUsageForProvider at capture time)
      const out = normalizeIndexEntry({ id: 'p1', sessionId: 's', provider: 'openai', model: MODEL, imported: false, usage: { ...USAGE, _ccxrayUsageNormalized: true }, cost: { cost: 1, confidence: 'exact' } });
      assert.equal(out.usage.input_tokens, 17695);
    });
  });
});

// ── R-3/INV-3: no-match -> unknown everywhere (H2 owner decision) ───────

describe('A-010 R-3/INV-3/H2: no match -> cost:null, confidence:unknown on every path (no substitute rates)', () => {
  it('pricing.calculateCost', async () => {
    await withMissingCache(() => {
      const r = pricing.calculateCost(USAGE, MODEL, 'openai');
      assert.equal(r.cost, null);
      assert.equal(r.confidence, 'unknown');
    });
  });

  it('default-rates.calculateCostSimple (was fallback + substitute rate before A-010)', async () => {
    await withMissingCache(() => {
      const r = defaultRates.calculateCostSimple(USAGE, MODEL, 'openai');
      assert.equal(r.cost, null);
      assert.equal(r.confidence, 'unknown');
    });
  });

  it('importer.parseSessionFile (Claude)', async () => {
    await withMissingCache(async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-a010-r3-'));
      try {
        const file = path.join(dir, 'claude-sess.jsonl');
        fs.writeFileSync(file, JSON.stringify({
          type: 'assistant', timestamp: '2026-09-01T00:00:00.000Z',
          message: { id: 'msg_1', model: MODEL, usage: USAGE },
        }) + '\n');
        const entries = await importer.parseSessionFile(file, '-proj');
        assert.equal(entries[0].cost.cost, null);
        assert.equal(entries[0].cost.confidence, 'unknown');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it('importer.parseCodexSessionFile (Codex)', async () => {
    await withMissingCache(async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-a010-r3c-'));
      try {
        const file = path.join(dir, 'codex-sess.jsonl');
        const lines = [
          JSON.stringify({ timestamp: '2026-09-01T00:00:00.000Z', type: 'turn_context', payload: { model: MODEL } }),
          JSON.stringify({
            timestamp: '2026-09-01T00:00:01.000Z', type: 'event_msg',
            payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 24735, cached_input_tokens: 7040, output_tokens: 42 }, model_context_window: 400000 } },
          }),
        ];
        fs.writeFileSync(file, lines.join('\n') + '\n');
        const entries = await importer.parseCodexSessionFile(file);
        assert.equal(entries[0].cost.cost, null);
        assert.equal(entries[0].cost.confidence, 'unknown');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it('cost-worker child process', async () => {
    await withMissingCache(async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-a010-r3w-'));
      try {
        const projDir = path.join(home, '.claude', 'projects', 'proj1');
        fs.mkdirSync(projDir, { recursive: true });
        fs.writeFileSync(path.join(projDir, 'sess1.jsonl'), JSON.stringify({
          type: 'assistant', timestamp: '2026-09-01T00:00:00.000Z',
          message: { id: 'msg_1', model: MODEL, usage: USAGE },
        }) + '\n');
        const worker = fork(path.join(REPO_ROOT, 'server', 'cost-worker.js'), [], {
          silent: true,
          env: { ...process.env, HOME: home, CCXRAY_HOME: home, CCXRAY_PRICING_CACHE: process.env.CCXRAY_PRICING_CACHE },
        });
        let out = '';
        worker.stdout.on('data', c => { out += c; });
        await new Promise(resolve => worker.on('exit', resolve));
        const entries = JSON.parse(out);
        const e = entries.find(x => x.model === MODEL);
        assert.ok(e);
        assert.equal(e.costUSD, null);
        assert.equal(e.costConfidence, 'unknown');
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  });
});

// ── H3: one rate unit — both wrappers agree to the last digit ──────────

describe('A-010 H3: calculateCost and calculateCostSimple agree to the last digit', () => {
  it('fixture-cached model (gpt-6-astra)', async () => {
    await withCache(FIXTURE_PRICING, () => {
      const a = pricing.calculateCost(USAGE, MODEL, 'openai');
      const b = defaultRates.calculateCostSimple(USAGE, MODEL, 'openai');
      // Same rates, same match rule (INV-1), but the two wrappers accumulate the
      // four cost components in a different floating-point order (calculateCost
      // divides the usage side first per component; calculateCostSimple divides
      // the rate side once up front) — a pre-existing, accepted degree of
      // agreement in this codebase (see test/default-rates.test.js's "date-strip
      // parity" test, which also compares with an epsilon rather than ===).
      assert.ok(closeTo(a.cost, b.cost, 1e-9), `a=${a.cost} b=${b.cost}`);
      assert.equal(a.confidence, b.confidence);
    });
  });
});

// ── R-4/INV-4: unchanged correct results (claude-sonnet-5) ──────────────

describe('A-010 R-4/INV-4: claude-sonnet-5 costs unchanged (old === new)', () => {
  it('DEFAULT_PRICING rates, no cache file involved', async () => {
    await withMissingCache(() => {
      const usage = { input_tokens: 100000, output_tokens: 5000, cache_read_input_tokens: 20000, cache_creation_input_tokens: 1000 };
      const a = pricing.calculateCost(usage, 'claude-sonnet-5', 'anthropic');
      const b = defaultRates.calculateCostSimple(usage, 'claude-sonnet-5', 'anthropic');
      // Hand-computed from DEFAULT_PRICING's claude-sonnet-5 row (input 2 / output 10 / cache_create 2.5 / cache_read 0.2 per MTok).
      const expected = 100000 * 2 / 1e6 + 5000 * 10 / 1e6 + 20000 * 0.2 / 1e6 + 1000 * 2.5 / 1e6;
      assert.ok(closeTo(a.cost, expected));
      assert.ok(closeTo(b.cost, expected));
      assert.equal(a.confidence, 'exact');
      assert.equal(b.confidence, 'exact');
    });
  });
});

// ── H5: read-time reprice (fallback/unknown heal; exact/legacy untouched) ─

describe('A-010 H5: read-time reprice via normalizeIndexEntry (cold-load)', () => {
  it('a fallback-confidence line is repriced to exact when the model is now cached', async () => {
    await withCache(FIXTURE_PRICING, () => {
      const out = normalizeIndexEntry({
        id: 'h5a', sessionId: 's', provider: 'anthropic', model: MODEL,
        usage: { ...USAGE }, cost: { cost: 0.055827, confidence: 'fallback' },
      });
      assert.ok(closeTo(out.cost.cost, EXPECTED_COST));
      assert.equal(out.cost.confidence, 'exact');
    });
  });

  it('an unknown-confidence line stays unknown when the model is still uncached', async () => {
    await withMissingCache(() => {
      const out = normalizeIndexEntry({
        id: 'h5b', sessionId: 's', provider: 'anthropic', model: MODEL,
        usage: { ...USAGE }, cost: { cost: null, confidence: 'unknown' },
      });
      assert.equal(out.cost.cost, null);
      assert.equal(out.cost.confidence, 'unknown');
    });
  });

  it('an exact-confidence line with a deliberately different stored cost is left unchanged', async () => {
    await withCache(FIXTURE_PRICING, () => {
      const out = normalizeIndexEntry({
        id: 'h5c', sessionId: 's', provider: 'anthropic', model: MODEL,
        usage: { ...USAGE }, cost: { cost: 999, confidence: 'exact' },
      });
      assert.equal(out.cost.cost, 999, 'H5: exact costs are never repriced');
    });
  });

  it('a legacy numeric (no-confidence) cost is left unchanged', async () => {
    await withCache(FIXTURE_PRICING, () => {
      const out = normalizeIndexEntry({
        id: 'h5d', sessionId: 's', provider: 'anthropic', model: MODEL,
        usage: { ...USAGE }, cost: 0.42,
      });
      assert.equal(out.cost, 0.42, 'H5: legacy numeric costs are never repriced');
    });
  });
});

// ── H6: pricing revision stamp forces one rebuild ───────────────────────

describe('A-010 H6: pricing-derivation revision on persisted session aggregates', () => {
  let tmpDir, origCcxrayHome, origLogsDir;

  async function setup() {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccxray-a010-h6-'));
    await fsp.mkdir(path.join(tmpDir, 'logs'), { recursive: true });
    origCcxrayHome = process.env.CCXRAY_HOME;
    process.env.CCXRAY_HOME = tmpDir;
    const config = require('../server/config');
    origLogsDir = config.LOGS_DIR;
    Object.defineProperty(config, 'LOGS_DIR', { value: path.join(tmpDir, 'logs'), writable: true, configurable: true });
  }

  async function teardown() {
    // F3 (acceptance-report.md): drain any pending flush timer (updateFromEntry/
    // rebuildFromMetas above schedule one) WHILE config.LOGS_DIR/CCXRAY_HOME still
    // point at tmpDir — otherwise the 2s timer fires after LOGS_DIR is restored
    // below and writes into whatever real path this process later resolves.
    await require('../server/session-index').flush();
    const config = require('../server/config');
    Object.defineProperty(config, 'LOGS_DIR', { value: origLogsDir, writable: true, configurable: true });
    if (origCcxrayHome === undefined) delete process.env.CCXRAY_HOME;
    else process.env.CCXRAY_HOME = origCcxrayHome;
    await fsp.rm(tmpDir, { recursive: true, force: true });
    delete require.cache[require.resolve('../server/session-index')];
  }

  it('a sessions.json with no pricingRev (old code) is rebuilt', async () => {
    await setup();
    try {
      const si = require('../server/session-index');
      const config = require('../server/config');
      const indexPath = path.join(config.LOGS_DIR, 'index.ndjson');
      const sessionsPath = path.join(config.LOGS_DIR, 'sessions.json');
      await fsp.writeFile(indexPath, JSON.stringify({ id: 't1', sessionId: 's1' }) + '\n');
      await fsp.writeFile(sessionsPath, JSON.stringify({
        sid: 's1', count: 1, totalCost: 0.1, maxContext: 200000, fallbackCount: 0, firstReceivedAt: 1, provider: 'openai',
        weather: { level: 'sunny', score: 0, stats: { toolSignal: null, toolTurns: 0 } }, weatherRev: 4,
        // pricingRev intentionally absent — simulates a sessions.json written before A-010.
      }) + '\n');
      const now = Date.now() / 1000;
      await fsp.utimes(sessionsPath, now + 1, now + 1);
      assert.equal(await si.loadSessionIndex(), false, 'H6: stale/absent pricingRev must force a rebuild');
    } finally { await teardown(); }
  });

  it('a sessions.json with the current pricingRev is NOT rebuilt', async () => {
    await setup();
    try {
      const si = require('../server/session-index');
      const config = require('../server/config');
      const indexPath = path.join(config.LOGS_DIR, 'index.ndjson');
      const sessionsPath = path.join(config.LOGS_DIR, 'sessions.json');
      await fsp.writeFile(indexPath, JSON.stringify({ id: 't1', sessionId: 's1' }) + '\n');
      // F2 (acceptance-report.md): read the writer's current stamp instead of a
      // hardcoded literal, so a future PRICING_REV bump does not also need this
      // assertion edited — same dynamic pattern as the neighbouring weatherRev
      // test (test/session-index.test.js, '#503: sessions.json weather written
      // by an older derivation...').
      si.rebuildFromMetas([{ id: 'rev-probe', sessionId: 'rev-probe', receivedAt: 1, model: 'm', maxContext: 200000 }]);
      const currentPricingRev = si.get('rev-probe').pricingRev;
      assert.equal(typeof currentPricingRev, 'number', 'the rebuild writer stamps a numeric pricing revision');
      await fsp.writeFile(sessionsPath, JSON.stringify({
        sid: 's1', count: 1, totalCost: 0.1, maxContext: 200000, fallbackCount: 0, firstReceivedAt: 1, provider: 'openai',
        weather: { level: 'sunny', score: 0, stats: { toolSignal: null, toolTurns: 0 } }, weatherRev: 4,
        pricingRev: currentPricingRev,
      }) + '\n');
      const now = Date.now() / 1000;
      await fsp.utimes(sessionsPath, now + 1, now + 1);
      assert.equal(await si.loadSessionIndex(), true, 'H6: current pricingRev must NOT force a rebuild');
    } finally { await teardown(); }
  });

  it('_upsert (via updateFromEntry) stamps pricingRev on every touched record', async () => {
    await setup();
    try {
      const si = require('../server/session-index');
      si.updateFromEntry({ sessionId: 'stamped', id: 'e1', model: 'claude-sonnet-5', cost: { cost: 0.1, confidence: 'exact' }, receivedAt: 1 });
      assert.equal(typeof si.get('stamped').pricingRev, 'number');
    } finally { await teardown(); }
  });
});
