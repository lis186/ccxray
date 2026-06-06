'use strict';

// Tests for ANTHROPIC_BASE_URL parsing logic in server/config.js.
// Because config.js is a singleton (module cache), we test parseBaseUrl()
// directly (exported for testability) and re-require config in isolated
// child processes via spawnAndCollect for integration scenarios.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const CONFIG_SCRIPT = path.resolve(__dirname, '..', 'server', 'config.js');
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-config-test-'));

after(() => {
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

// ── Helper: run a node snippet in a child process with given env ────

function runSnippet(snippet, env = {}) {
  return new Promise((resolve) => {
    // Start from process.env, sanitise ambient provider vars that would
    // leak from a developer's shell and corrupt test results, then apply
    // the caller's explicit overrides on top.
    const sanitised = { ...process.env };
    delete sanitised.ANTHROPIC_BASE_URL;
    delete sanitised.ANTHROPIC_TEST_HOST;
    delete sanitised.ANTHROPIC_TEST_PORT;
    delete sanitised.ANTHROPIC_TEST_PROTOCOL;
    delete sanitised.OPENAI_BASE_URL;
    delete sanitised.OPENAI_TEST_HOST;
    delete sanitised.OPENAI_TEST_PORT;
    delete sanitised.OPENAI_TEST_PROTOCOL;
    // Path/storage vars leak from a developer's shell (or the ccxray hub) and
    // would corrupt logs-dir resolution tests. Clear them; callers re-add via env.
    delete sanitised.CCXRAY_HOME;
    delete sanitised.LOGS_DIR;
    delete sanitised.STORAGE_BACKEND;
    Object.assign(sanitised, env);

    const child = spawn(process.execPath, ['-e', snippet], {
      env: sanitised,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('exit', code => resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code }));
  });
}

// ── 4.1: parseBaseUrl unit tests ───────────────────────────────────

describe('parseBaseUrl()', () => {
  // Load the exported helper into this process for lightweight unit tests.
  // We delete env overrides first so the module doesn't log warnings.
  let parseBaseUrl;
  before(() => {
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_TEST_HOST;
    delete process.env.ANTHROPIC_TEST_PORT;
    delete process.env.ANTHROPIC_TEST_PROTOCOL;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_TEST_HOST;
    delete process.env.OPENAI_TEST_PORT;
    delete process.env.OPENAI_TEST_PROTOCOL;
    // Re-require after clearing env (module may already be cached; that's fine
    // since parseBaseUrl is a pure function not affected by env at call time).
    ({ parseBaseUrl } = require('../server/config'));
  });

  it('parses valid HTTPS URL with explicit port', () => {
    const result = parseBaseUrl('https://proxy.corp.example.com:8443');
    assert.deepEqual(result, { protocol: 'https', hostname: 'proxy.corp.example.com', port: 8443, basePath: '' });
  });

  it('infers port 443 for HTTPS URL without explicit port', () => {
    const result = parseBaseUrl('https://proxy.corp.example.com');
    assert.deepEqual(result, { protocol: 'https', hostname: 'proxy.corp.example.com', port: 443, basePath: '' });
  });

  it('parses valid HTTP URL and infers port 80', () => {
    const result = parseBaseUrl('http://internal-gateway.corp:9090');
    assert.deepEqual(result, { protocol: 'http', hostname: 'internal-gateway.corp', port: 9090, basePath: '' });
  });

  it('infers port 80 for HTTP URL without explicit port', () => {
    const result = parseBaseUrl('http://internal-gateway.corp');
    assert.deepEqual(result, { protocol: 'http', hostname: 'internal-gateway.corp', port: 80, basePath: '' });
  });

  it('handles trailing slash correctly (common user mistake)', () => {
    const result = parseBaseUrl('https://proxy.example.com/');
    assert.deepEqual(result, { protocol: 'https', hostname: 'proxy.example.com', port: 443, basePath: '' });
  });

  it('captures path from URL with base path', () => {
    const result = parseBaseUrl('https://adb-1033261988689278.18.azuredatabricks.net/serving-endpoints/anthropic');
    assert.deepEqual(result, { protocol: 'https', hostname: 'adb-1033261988689278.18.azuredatabricks.net', port: 443, basePath: '/serving-endpoints/anthropic' });
  });

  it('strips trailing slash from base path', () => {
    const result = parseBaseUrl('https://gateway.example.com/api/v1/');
    assert.deepEqual(result, { protocol: 'https', hostname: 'gateway.example.com', port: 443, basePath: '/api/v1' });
  });

  it('returns null for malformed URL', () => {
    const result = parseBaseUrl('not-a-valid-url');
    assert.equal(result, null);
  });

  it('returns null for empty string', () => {
    const result = parseBaseUrl('');
    assert.equal(result, null);
  });

  it('returns null for null/undefined', () => {
    assert.equal(parseBaseUrl(null), null);
    assert.equal(parseBaseUrl(undefined), null);
  });
});

// ── 4.2: Priority chain integration tests ─────────────────────────

describe('upstream priority chain', () => {
  const snippet = `
    const c = require(${JSON.stringify(CONFIG_SCRIPT)});
    process.stdout.write(JSON.stringify({
      host: c.ANTHROPIC_HOST,
      port: c.ANTHROPIC_PORT,
      protocol: c.ANTHROPIC_PROTOCOL,
      source: c.ANTHROPIC_BASE_URL_SOURCE,
      basePath: c.ANTHROPIC_BASE_PATH,
    }));
  `;

  it('ANTHROPIC_TEST_HOST overrides ANTHROPIC_BASE_URL', async () => {
    const { stdout } = await runSnippet(snippet, {
      ANTHROPIC_TEST_HOST: 'test.example.com',
      ANTHROPIC_TEST_PORT: '9000',
      ANTHROPIC_TEST_PROTOCOL: 'http',
      ANTHROPIC_BASE_URL: 'https://other.example.com:8443',
      CCXRAY_HOME: TEST_HOME,
    });
    const result = JSON.parse(stdout);
    assert.equal(result.host, 'test.example.com');
    assert.equal(result.port, 9000);
    assert.equal(result.protocol, 'http');
    assert.equal(result.source, 'test-override');
  });

  it('ANTHROPIC_BASE_URL is used when no ANTHROPIC_TEST_* vars are set', async () => {
    const { stdout } = await runSnippet(snippet, {
      ANTHROPIC_BASE_URL: 'https://proxy.example.com:7777',
      CCXRAY_HOME: TEST_HOME,
    });
    const result = JSON.parse(stdout);
    assert.equal(result.host, 'proxy.example.com');
    assert.equal(result.port, 7777);
    assert.equal(result.protocol, 'https');
    assert.equal(result.source, 'ANTHROPIC_BASE_URL');
  });

  it('falls back to api.anthropic.com defaults when neither is set', async () => {
    const { stdout } = await runSnippet(snippet, { CCXRAY_HOME: TEST_HOME });
    const result = JSON.parse(stdout);
    assert.equal(result.host, 'api.anthropic.com');
    assert.equal(result.port, 443);
    assert.equal(result.protocol, 'https');
    assert.equal(result.source, 'default');
  });

  it('falls back to defaults when ANTHROPIC_BASE_URL is malformed', async () => {
    const { stdout } = await runSnippet(snippet, {
      ANTHROPIC_BASE_URL: 'not-a-url',
      CCXRAY_HOME: TEST_HOME,
    });
    const result = JSON.parse(stdout);
    assert.equal(result.host, 'api.anthropic.com');
    assert.equal(result.source, 'default');
  });

  it('exposes base path from ANTHROPIC_BASE_URL with path component', async () => {
    const { stdout } = await runSnippet(snippet, {
      ANTHROPIC_BASE_URL: 'https://adb-xxx.azuredatabricks.net/serving-endpoints/anthropic',
      CCXRAY_HOME: TEST_HOME,
    });
    const result = JSON.parse(stdout);
    assert.equal(result.host, 'adb-xxx.azuredatabricks.net');
    assert.equal(result.basePath, '/serving-endpoints/anthropic');
  });

  it('exposes empty base path when ANTHROPIC_BASE_URL has no path', async () => {
    const { stdout } = await runSnippet(snippet, {
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      CCXRAY_HOME: TEST_HOME,
    });
    const result = JSON.parse(stdout);
    assert.equal(result.basePath, '');
  });
});

// ── Logs directory resolution (issue #31: config.LOGS_DIR must honor
// CCXRAY_HOME, and must not drift from where the storage adapter writes) ──

describe('logs directory resolution (CCXRAY_HOME)', () => {
  // Prints the config-exported logs dir plus the storage adapter's self-reported
  // destination, so we can assert they resolve to the same place.
  const logsSnippet = `
    const c = require(${JSON.stringify(CONFIG_SCRIPT)});
    process.stdout.write(JSON.stringify({ logsDir: c.LOGS_DIR, location: c.storage.location }));
  `;

  it('honors CCXRAY_HOME for the logs directory', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-home-'));
    try {
      const { stdout, code } = await runSnippet(logsSnippet, { CCXRAY_HOME: home });
      assert.equal(code, 0);
      const r = JSON.parse(stdout);
      assert.equal(r.logsDir, path.join(home, 'logs'));
      assert.equal(r.location, path.join(home, 'logs'));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('LOGS_DIR env takes precedence over CCXRAY_HOME', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-home-'));
    const explicit = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-logs-'));
    try {
      const { stdout, code } = await runSnippet(logsSnippet, { CCXRAY_HOME: home, LOGS_DIR: explicit });
      assert.equal(code, 0);
      const r = JSON.parse(stdout);
      assert.equal(r.logsDir, explicit);
      assert.equal(r.location, explicit);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(explicit, { recursive: true, force: true });
    }
  });

  it('falls back to <home>/.ccxray/logs when neither is set', async () => {
    // Pin HOME (POSIX) and USERPROFILE (Windows) to a temp dir so
    // os.homedir() is deterministic cross-platform and we never touch the
    // developer's real ~/.ccxray. No CCXRAY_HOME / LOGS_DIR set.
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-fakehome-'));
    try {
      const { stdout, code } = await runSnippet(logsSnippet, { HOME: fakeHome, USERPROFILE: fakeHome });
      assert.equal(code, 0);
      const r = JSON.parse(stdout);
      assert.equal(r.logsDir, path.join(fakeHome, '.ccxray', 'logs'));
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('config.LOGS_DIR matches where the storage adapter actually writes (no drift)', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-home-'));
    try {
      // Write through config.storage and confirm the file lands under
      // config.LOGS_DIR — proving createStorage() uses the same resolver.
      const snippet = `
        const c = require(${JSON.stringify(CONFIG_SCRIPT)});
        (async () => {
          await c.storage.init();
          await c.storage.write('drift-check', '_req.json', 'x');
          const fsm = require('fs'); const pm = require('path');
          process.stdout.write(JSON.stringify({
            logsDir: c.LOGS_DIR,
            location: c.storage.location,
            landed: fsm.existsSync(pm.join(c.LOGS_DIR, 'drift-check_req.json')),
          }));
        })();
      `;
      const { stdout, code } = await runSnippet(snippet, { CCXRAY_HOME: home });
      assert.equal(code, 0);
      const r = JSON.parse(stdout);
      assert.equal(r.location, r.logsDir);
      assert.equal(r.landed, true, 'storage.write should land under config.LOGS_DIR');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('provider-aware OpenAI upstream configuration', () => {
  const snippet = `
    const c = require(${JSON.stringify(CONFIG_SCRIPT)});
    process.stdout.write(JSON.stringify({
      anthropic: {
        host: c.ANTHROPIC_HOST,
        port: c.ANTHROPIC_PORT,
        protocol: c.ANTHROPIC_PROTOCOL,
        source: c.ANTHROPIC_BASE_URL_SOURCE,
        basePath: c.ANTHROPIC_BASE_PATH,
      },
      openai: {
        host: c.OPENAI_HOST,
        port: c.OPENAI_PORT,
        protocol: c.OPENAI_PROTOCOL,
        source: c.OPENAI_BASE_URL_SOURCE,
        basePath: c.OPENAI_BASE_PATH,
      },
      providers: {
        messages: c.getProviderForRequest('/v1/messages'),
        responses: c.getProviderForRequest('/v1/responses'),
        realtime: c.getProviderForRequest('/v1/realtime?model=gpt-realtime'),
        models: c.getProviderForRequest('/v1/models?client_version=0.125.0'),
        chatgptCodexApps: c.getProviderForRequest('/v1/api/codex/apps'),
        chatgptAnalytics: c.getProviderForRequest('/v1/codex/analytics-events/events'),
        chatgptPlugins: c.getProviderForRequest('/v1/plugins/featured?platform=codex'),
        chatgptConnectors: c.getProviderForRequest('/v1/connectors/directory/list?external_logos=true'),
      },
      chatgpt: {
        source: c.UPSTREAMS.openaiChatGPT.source,
        host: c.UPSTREAMS.openaiChatGPT.host,
        port: c.UPSTREAMS.openaiChatGPT.port,
        protocol: c.UPSTREAMS.openaiChatGPT.protocol,
        basePath: c.UPSTREAMS.openaiChatGPT.basePath,
        stripPathPrefix: c.UPSTREAMS.openaiChatGPT.stripPathPrefix,
      },
      paths: {
        responses: c.joinUpstreamPath(c.getUpstream('openai'), '/v1/responses'),
        completions: c.joinUpstreamPath(c.getUpstream('openai'), '/chat/completions'),
        chatgptResponses: c.joinUpstreamPath(c.getUpstreamForRequestAndHeaders('/v1/responses', {'chatgpt-account-id': 'acct'}), '/v1/responses'),
        chatgptApps: c.joinUpstreamPath(c.getUpstreamForRequestAndHeaders('/v1/api/codex/apps'), '/v1/api/codex/apps'),
      },
    }));
  `;

  it('defaults OpenAI to api.openai.com with /v1 base path without changing Anthropic defaults', async () => {
    const { stdout } = await runSnippet(snippet, { CCXRAY_HOME: TEST_HOME });
    const result = JSON.parse(stdout);
    assert.deepEqual(result.anthropic, {
      host: 'api.anthropic.com',
      port: 443,
      protocol: 'https',
      source: 'default',
      basePath: '',
    });
    assert.deepEqual(result.openai, {
      host: 'api.openai.com',
      port: 443,
      protocol: 'https',
      source: 'default',
      basePath: '/v1',
    });
    assert.equal(result.providers.messages, 'anthropic');
    assert.equal(result.providers.responses, 'openai');
    assert.equal(result.providers.realtime, 'openai');
    assert.equal(result.providers.models, 'openai');
    assert.equal(result.providers.chatgptCodexApps, 'openai');
    assert.equal(result.providers.chatgptAnalytics, 'openai');
    assert.equal(result.providers.chatgptPlugins, 'openai');
    assert.equal(result.providers.chatgptConnectors, 'openai');
    assert.deepEqual(result.chatgpt, {
      host: 'chatgpt.com',
      port: 443,
      protocol: 'https',
      source: 'chatgpt-default',
      basePath: '/backend-api/codex',
      stripPathPrefix: '/v1',
    });
    assert.equal(result.paths.chatgptResponses, '/backend-api/codex/responses');
    assert.equal(result.paths.chatgptApps, '/backend-api/codex/api/codex/apps');
  });

  it('OPENAI_BASE_URL overrides only the OpenAI upstream and preserves /v1 request paths', async () => {
    const { stdout } = await runSnippet(snippet, {
      OPENAI_BASE_URL: 'http://localhost:9000/v1',
      CCXRAY_HOME: TEST_HOME,
    });
    const result = JSON.parse(stdout);
    assert.equal(result.anthropic.host, 'api.anthropic.com');
    assert.equal(result.openai.host, 'localhost');
    assert.equal(result.openai.port, 9000);
    assert.equal(result.openai.protocol, 'http');
    assert.equal(result.openai.source, 'OPENAI_BASE_URL');
    assert.equal(result.openai.basePath, '/v1');
    assert.equal(result.paths.responses, '/v1/responses');
    assert.equal(result.paths.completions, '/v1/chat/completions');
  });

  it('CHATGPT_BASE_URL routes ChatGPT-auth Codex traffic without the /v1 prefix', async () => {
    const { stdout } = await runSnippet(snippet, {
      CHATGPT_BASE_URL: 'http://localhost:8123/backend-api/codex',
      CCXRAY_HOME: TEST_HOME,
    });
    const result = JSON.parse(stdout);
    assert.equal(result.chatgpt.host, 'localhost');
    assert.equal(result.chatgpt.port, 8123);
    assert.equal(result.chatgpt.protocol, 'http');
    assert.equal(result.chatgpt.source, 'CHATGPT_BASE_URL');
    assert.equal(result.chatgpt.basePath, '/backend-api/codex');
    assert.equal(result.paths.chatgptResponses, '/backend-api/codex/responses');
    assert.equal(result.paths.chatgptApps, '/backend-api/codex/api/codex/apps');
  });

  it('OPENAI_TEST_* overrides OPENAI_BASE_URL', async () => {
    const { stdout } = await runSnippet(snippet, {
      OPENAI_TEST_HOST: 'openai-test.example.com',
      OPENAI_TEST_PORT: '9100',
      OPENAI_TEST_PROTOCOL: 'http',
      OPENAI_BASE_URL: 'https://api.example.com/v1',
      CCXRAY_HOME: TEST_HOME,
    });
    const result = JSON.parse(stdout);
    assert.equal(result.openai.host, 'openai-test.example.com');
    assert.equal(result.openai.port, 9100);
    assert.equal(result.openai.protocol, 'http');
    assert.equal(result.openai.basePath, '');
    assert.equal(result.openai.source, 'test-override');
  });

  it('emits warning when partial OPENAI_TEST_* override is set', async () => {
    const snippet = `require(${JSON.stringify(CONFIG_SCRIPT)});`;
    const { stderr } = await runSnippet(snippet, {
      OPENAI_TEST_PORT: '9000',
      CCXRAY_HOME: TEST_HOME,
    });
    assert.ok(
      stderr.includes('partial OPENAI_TEST_* override') || stderr.includes('OPENAI_TEST_HOST') || stderr.includes('OPENAI_TEST_PROTOCOL'),
      `Expected partial OpenAI override warning in stderr, got: ${stderr}`
    );
  });

  it('falls back to OpenAI defaults when OPENAI_BASE_URL is malformed', async () => {
    const { stdout, stderr } = await runSnippet(snippet, {
      OPENAI_BASE_URL: 'not-a-url',
      CCXRAY_HOME: TEST_HOME,
    });
    const result = JSON.parse(stdout);
    assert.equal(result.openai.host, 'api.openai.com');
    assert.equal(result.openai.source, 'default');
    assert.ok(
      stderr.includes('OPENAI_BASE_URL') && stderr.includes('not a valid URL'),
      `Expected malformed OPENAI_BASE_URL warning in stderr, got: ${stderr}`
    );
  });
});

// ── 4.3: Partial ANTHROPIC_TEST_* override warning ─────────────────

describe('partial ANTHROPIC_TEST_* override', () => {
  it('emits warning when only ANTHROPIC_TEST_PORT is set', async () => {
    const snippet = `require(${JSON.stringify(CONFIG_SCRIPT)});`;
    const { stderr } = await runSnippet(snippet, {
      ANTHROPIC_TEST_PORT: '9000',
      CCXRAY_HOME: TEST_HOME,
    });
    assert.ok(
      stderr.includes('partial') || stderr.includes('ANTHROPIC_TEST_HOST') || stderr.includes('ANTHROPIC_TEST_PROTOCOL'),
      `Expected partial-override warning in stderr, got: ${stderr}`
    );
  });

  it('does not warn when full ANTHROPIC_TEST_* triple is set', async () => {
    const snippet = `require(${JSON.stringify(CONFIG_SCRIPT)});`;
    const { stderr } = await runSnippet(snippet, {
      ANTHROPIC_TEST_HOST: 'test.example.com',
      ANTHROPIC_TEST_PORT: '9000',
      ANTHROPIC_TEST_PROTOCOL: 'http',
      CCXRAY_HOME: TEST_HOME,
    });
    assert.ok(
      !stderr.includes('partial'),
      `Unexpected partial-override warning in stderr: ${stderr}`
    );
  });
});

// ── 4.4: Malformed URL warning reaches stderr (not just console.warn) ──

describe('malformed URL warning via stderr', () => {
  it('writes warning directly to stderr so it survives console muting', async () => {
    const snippet = `require(${JSON.stringify(CONFIG_SCRIPT)});`;
    const { stderr } = await runSnippet(snippet, {
      ANTHROPIC_BASE_URL: 'not-a-url',
      CCXRAY_HOME: TEST_HOME,
    });
    assert.ok(
      stderr.includes('not a valid URL') || stderr.includes('ANTHROPIC_BASE_URL'),
      `Expected malformed URL warning in stderr, got: ${stderr}`
    );
  });
});

// ── 4.5: Self-loop detection ────────────────────────────────────────

describe('self-loop detection', () => {
  it('emits warning when ANTHROPIC_BASE_URL points at the proxy itself', async () => {
    // Use PROXY_PORT=5577 (default) and ANTHROPIC_BASE_URL pointing at same port
    const snippet = `require(${JSON.stringify(CONFIG_SCRIPT)});`;
    const { stderr } = await runSnippet(snippet, {
      PROXY_PORT: '5577',
      ANTHROPIC_BASE_URL: 'http://localhost:5577',
      CCXRAY_HOME: TEST_HOME,
    });
    assert.ok(
      stderr.includes('points back at the proxy itself') || stderr.includes('loop'),
      `Expected loop warning in stderr, got: ${stderr}`
    );
  });

  it('does not warn for a legitimate upstream', async () => {
    const snippet = `require(${JSON.stringify(CONFIG_SCRIPT)});`;
    const { stderr } = await runSnippet(snippet, {
      PROXY_PORT: '5577',
      ANTHROPIC_BASE_URL: 'https://proxy.example.com:8443',
      CCXRAY_HOME: TEST_HOME,
    });
    assert.ok(
      !stderr.includes('points back at the proxy itself'),
      `Unexpected loop warning in stderr: ${stderr}`
    );
  });

  it('emits warning when OPENAI_BASE_URL points at the proxy itself', async () => {
    const snippet = `require(${JSON.stringify(CONFIG_SCRIPT)});`;
    const { stderr } = await runSnippet(snippet, {
      PROXY_PORT: '5577',
      OPENAI_BASE_URL: 'http://localhost:5577/v1',
      CCXRAY_HOME: TEST_HOME,
    });
    assert.ok(
      stderr.includes('openai upstream') && (stderr.includes('points back at the proxy itself') || stderr.includes('loop')),
      `Expected OpenAI loop warning in stderr, got: ${stderr}`
    );
  });
});

// Codex 0.133+ hits /v1/plugins, /v1/ps/plugins, /v1/connectors, /v1/api/codex/apps,
// /v1/api/codex/usage on startup. We still proxy them (so codex doesn't break),
// but they shouldn't be tagged 'anthropic' (classification bug) and shouldn't
// create dashboard entries (noise bug). The telemetry endpoint stays visible.
describe('codex platform noise routing and predicate', () => {
  const { getProviderForRequest } = require('../server/config');
  const openaiParser = require('../server/wire-parsers/openai');

  it('classifies /v1/ps/plugins/* as openai (was falling through to anthropic)', () => {
    assert.equal(getProviderForRequest('/v1/ps/plugins/installed?scope=GLOBAL'), 'openai');
    assert.equal(getProviderForRequest('/v1/ps/plugins/installed?scope=WORKSPACE&includeDownloadUrls=true'), 'openai');
    assert.equal(getProviderForRequest('/v1/ps/plugins'), 'openai');
  });

  it('marks codex startup polls as noise', () => {
    assert.equal(openaiParser.isNoiseRequest('/v1/plugins/featured?platform=codex'), true);
    assert.equal(openaiParser.isNoiseRequest('/v1/plugins/list'), true);
    assert.equal(openaiParser.isNoiseRequest('/v1/ps/plugins/installed?scope=GLOBAL'), true);
    assert.equal(openaiParser.isNoiseRequest('/v1/api/codex/apps'), true);
    assert.equal(openaiParser.isNoiseRequest('/v1/api/codex/usage'), true);
    assert.equal(openaiParser.isNoiseRequest('/v1/connectors/directory/list?external_logos=true'), true);
  });

  it('suppresses analytics/telemetry paths (they 404 for API-key users)', () => {
    assert.equal(openaiParser.isNoiseRequest('/v1/codex/analytics-events/events'), true);
    assert.equal(openaiParser.isNoiseRequest('/v1/codex'), true);
    assert.equal(openaiParser.isNoiseRequest('/v1/api/codex'), true);
  });

  it('suppresses model-list query but not individual model lookups', () => {
    assert.equal(openaiParser.isNoiseRequest('/v1/models'), true);
    assert.equal(openaiParser.isNoiseRequest('/v1/models?client_version=0.136.0'), true);
    assert.equal(openaiParser.isNoiseRequest('/v1/models/gpt-5.5'), false);
  });

  it('keeps the conversation paths visible', () => {
    assert.equal(openaiParser.isNoiseRequest('/v1/responses'), false);
    assert.equal(openaiParser.isNoiseRequest('/v1/messages'), false);
    assert.equal(openaiParser.isNoiseRequest('/v1/realtime'), false);
  });
});

describe('model context fallback', () => {
  it('uses fallback context for Codex OpenAI models when dynamic pricing data is unavailable', () => {
    const { getMaxContext } = require('../server/config');
    assert.equal(getMaxContext('gpt-5.1-codex', null), 400_000);
    assert.equal(getMaxContext('gpt-5.2-codex-20260401', null), 400_000);
  });
});

// ── inferMaxContext: usage-aware Anthropic 1M plan detection ─────────
// The [1m] suffix only appears in Claude Code's system prompt. For requests
// without that prompt (title-gen, some subagent paths) the model field is
// bare "claude-opus-4-7", which falls back to 200K — but a Max-plan user
// may actually be on 1M context. When observed usage exceeds the base
// context, infer the higher tier so the dashboard "X / Y (Z%)" stays
// self-consistent instead of showing "636K / 200K (318%)" or clamping the
// bar to 100% while the textual number overflows.
describe('inferMaxContext', () => {
  const { inferMaxContext } = require('../server/config');

  it('returns base context when usage is null/undefined', () => {
    assert.equal(inferMaxContext('claude-opus-4-7', null, null), 200_000);
    assert.equal(inferMaxContext('claude-opus-4-7', null, undefined), 200_000);
  });

  it('returns base context when usage fits inside it', () => {
    const usage = { input_tokens: 50_000, cache_read_input_tokens: 100_000 };
    assert.equal(inferMaxContext('claude-opus-4-7', null, usage), 200_000);
  });

  it('returns 1M when system prompt carries the [1m] suffix (existing path)', () => {
    const system = [{ type: 'text', text: 'The exact model ID is claude-opus-4-7[1m].' }];
    const usage = { input_tokens: 600_000 };
    assert.equal(inferMaxContext('claude-opus-4-7', system, usage), 1_000_000);
  });

  it('bumps Claude 200K to 1M when usage exceeds base and system is missing', () => {
    // Reproduces the real-world bug: bare model, no system prompt, big usage.
    const usage = { input_tokens: 632_129 };
    assert.equal(inferMaxContext('claude-opus-4-7', null, usage), 1_000_000);
  });

  it('bumps Claude 200K to 1M for any claude-* model when usage exceeds base', () => {
    const usage = {
      input_tokens: 80_000,
      cache_creation_input_tokens: 50_000,
      cache_read_input_tokens: 130_000, // sum 260K > 200K
    };
    assert.equal(inferMaxContext('claude-sonnet-4-6', null, usage), 1_000_000);
    assert.equal(inferMaxContext('claude-haiku-4-5', null, usage), 1_000_000);
  });

  it('does not bump OpenAI models when usage exceeds the OpenAI base', () => {
    // No known intermediate "1M plan" for non-gpt-4.1 OpenAI models.
    const usage = { input_tokens: 500_000 };
    assert.equal(inferMaxContext('gpt-5', null, usage), 400_000);
    assert.equal(inferMaxContext('gpt-5.1-codex', null, usage), 400_000);
  });

  it('returns the known 1M for gpt-4.1 regardless of usage', () => {
    const usage = { input_tokens: 700_000 };
    assert.equal(inferMaxContext('gpt-4.1', null, usage), 1_000_000);
  });

  it('does not bump when usage exactly equals base (boundary case)', () => {
    const usage = { input_tokens: 200_000 };
    assert.equal(inferMaxContext('claude-opus-4-7', null, usage), 200_000);
  });

  it('handles usage with only cache_read tokens', () => {
    const usage = { cache_read_input_tokens: 300_000 };
    assert.equal(inferMaxContext('claude-opus-4-7', null, usage), 1_000_000);
  });
});
