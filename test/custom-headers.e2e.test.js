'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { deriveUpstreamToken } = require('./helpers/upstream-token');

const ROOT = path.resolve(__dirname, '..');
const SERVER_SCRIPT = path.join(ROOT, 'server', 'index.js');
const PROVIDERS_SCRIPT = path.join(ROOT, 'server', 'providers.js');
const tmpDirs = [];

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-custom-headers-'));
  tmpDirs.push(home);
  return home;
}

function isolatedEnv(home, overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(CCXRAY_|ANTHROPIC_|OPENAI_|CHATGPT_|XAI_|GROK_)/.test(key)
      || key === 'AUTH_TOKEN') delete env[key];
  }
  delete env.LOGS_DIR;
  delete env.STORAGE_BACKEND;
  return {
    ...env,
    HOME: home,
    CCXRAY_HOME: home,
    CCXRAY_EXPORT_DISABLE: '1',
    CCXRAY_IMPORT_DISABLE: '1',
    CCXRAY_PRICING_CACHE: '/nonexistent/ccxray-pricing-cache.json',
    RESTORE_DAYS: '0',
    BROWSER: 'none',
    ...overrides,
  };
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function waitForPort(port, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const check = () => {
      const req = http.get(`http://127.0.0.1:${port}/_api/health`, { timeout: 1000 }, res => {
        res.resume();
        res.on('end', resolve);
      });
      req.on('error', () => {
        if (Date.now() - startedAt > timeoutMs) return reject(new Error('proxy did not start'));
        setTimeout(check, 100);
      });
      req.on('timeout', () => {
        req.destroy();
        if (Date.now() - startedAt > timeoutMs) return reject(new Error('proxy did not start'));
        setTimeout(check, 100);
      });
    };
    check();
  });
}

function killAndWait(child) {
  return new Promise(resolve => {
    if (!child || child.exitCode !== null) return resolve();
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      resolve();
    }, 3000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}

function writeClaudeConfig(home) {
  const configDir = path.join(home, 'claude-config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, '.claude.json'), JSON.stringify({
    oauthAccount: {
      accountUuid: '00000000-0000-4000-8000-000000000001',
      emailAddress: 'Dev@Example.com',
      organizationUuid: '00000000-0000-4000-8000-000000000002',
      hasExtraUsageEnabled: false,
      billingType: 'subscription',
      accountCreatedAt: '2026-01-02T03:04:05.000Z',
      subscriptionCreatedAt: '2026-01-03T04:05:06.000Z',
      displayName: 'Dev Example',
      fullName: 'Dev Example',
      profileFetchedAt: 1770000000000,
      organizationRole: 'member',
      organizationName: 'Example Org',
      organizationType: 'team',
      organizationRateLimitTier: 'standard',
      ccOnboardingFlags: null,
      claudeCodeTrialEndsAt: null,
      claudeCodeTrialDurationDays: null,
      seatTier: null,
      workspaceRole: null,
      userRateLimitTier: null,
    },
  }));
  return configDir;
}

// Matches Claude Code's ANTHROPIC_CUSTOM_HEADERS parser: split on newlines,
// then use the first colon on each line to separate name and value.
function parseClaudeCustomHeaders(value) {
  const headers = {};
  for (const line of String(value || '').split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return headers;
}

function launchHeaders(home, configDir) {
  const result = spawnSync(process.execPath, [
    '-e',
    "const p = require(process.argv[1]); const l = p.getAgentLaunch('claude', Number(process.argv[2]), [], process.env); process.stdout.write(l.env.ANTHROPIC_CUSTOM_HEADERS || '');",
    PROVIDERS_SCRIPT,
    '0',
  ], {
    env: isolatedEnv(home, {
      CLAUDE_CONFIG_DIR: configDir,
      ANTHROPIC_CUSTOM_HEADERS: 'X-User-Header: retained',
    }),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `provider launcher failed: ${result.stderr}`);
  return parseClaudeCustomHeaders(result.stdout);
}

function postMessages(port, headers) {
  const body = JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: 32,
    metadata: { session_id: '55555555-5555-4555-8555-555555555555' },
    messages: [{ role: 'user', content: [{ type: 'text', text: 'synthetic header test' }] }],
  });
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'x-api-key': 'sk-test',
        'anthropic-version': '2023-06-01',
        ...headers,
      },
    }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function waitForIndexLine(home, timeoutMs = 5000) {
  const file = path.join(home, 'logs', 'index.ndjson');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) {
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
      if (lines.length) return JSON.parse(lines[lines.length - 1]);
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('index line was not written');
}

describe('Claude ANTHROPIC_CUSTOM_HEADERS launch e2e', () => {
  after(() => {
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('parses separate launch headers, authenticates with the clean token, and indexes account identity', async () => {
    const home = makeHome();
    const configDir = writeClaudeConfig(home);
    const headers = launchHeaders(home, configDir);
    const expectedToken = deriveUpstreamToken({ home });
    assert.equal(headers['x-user-header'], 'retained', 'user-provided custom header must be preserved');
    assert.equal(headers['x-ccxray-auth'], expectedToken, 'auth value must be its own clean header');
    assert.equal(headers['x-ccxray-account'], 'Dev@Example.com', 'account must be its own header');

    const upstreamPort = await findFreePort();
    const proxyPort = await findFreePort();
    const upstreamRequests = [];
    const upstream = http.createServer((req, res) => {
      upstreamRequests.push({ ...req.headers });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_custom_headers',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        stop_reason: 'end_turn',
        stop_sequence: null,
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 2, output_tokens: 1 },
      }));
    });
    await new Promise((resolve, reject) => {
      upstream.once('error', reject);
      upstream.listen(upstreamPort, '127.0.0.1', resolve);
    });

    const env = isolatedEnv(home, {
      ANTHROPIC_TEST_HOST: '127.0.0.1',
      ANTHROPIC_TEST_PORT: String(upstreamPort),
      ANTHROPIC_TEST_PROTOCOL: 'http',
      CCXRAY_LOOPBACK_REQUIRE_AUTH: '1',
    });
    const child = spawn(process.execPath, [SERVER_SCRIPT, '--port', String(proxyPort), '--no-browser'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', () => {});
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });

    try {
      await waitForPort(proxyPort);
      assert.equal(await postMessages(proxyPort, headers), 200, stderr);
      assert.equal(upstreamRequests.length, 1, 'fake Anthropic upstream should receive one request');
      assert.equal(upstreamRequests[0]['x-ccxray-auth'], undefined, 'ccxray auth must not reach upstream');
      assert.equal(upstreamRequests[0]['x-ccxray-account'], undefined, 'account metadata must not reach upstream');

      const line = await waitForIndexLine(home);
      assert.equal(line.accountEmail, 'dev@example.com');
      assert.equal(line.accountDomain, 'example.com');
    } finally {
      await killAndWait(child);
      await new Promise(resolve => upstream.close(resolve));
    }
  });
});
