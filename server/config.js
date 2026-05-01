'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { createStorage } = require('./storage');

// ── Config ──────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PROXY_PORT || '5577', 10);

/**
 * @internal – exported for testability only
 */
function parseBaseUrl(rawUrl) {
  if (!rawUrl) return null;
  try {
    const u = new URL(rawUrl);
    const protocol = u.protocol.replace(/:$/, ''); // 'https:' → 'https'
    const hostname = u.hostname;
    const port = u.port ? parseInt(u.port, 10) : (protocol === 'https' ? 443 : 80);
    const basePath = u.pathname !== '/' ? u.pathname.replace(/\/$/, '') : '';
    return { protocol, hostname, port, basePath };
  } catch {
    console.warn(`[ccxray] Warning: ANTHROPIC_BASE_URL is not a valid URL ("${rawUrl}"); falling back to api.anthropic.com`);
    return null;
  }
}

// Priority: ANTHROPIC_TEST_* (test/CI overrides) > ANTHROPIC_BASE_URL > built-in defaults
function resolveUpstream(env, proxyPort) {
  if (env.ANTHROPIC_TEST_HOST || env.ANTHROPIC_TEST_PORT || env.ANTHROPIC_TEST_PROTOCOL) {
    const host = env.ANTHROPIC_TEST_HOST || 'api.anthropic.com';
    const port = parseInt(env.ANTHROPIC_TEST_PORT || '443', 10);
    const protocol = env.ANTHROPIC_TEST_PROTOCOL || 'https';
    const missing = ['ANTHROPIC_TEST_HOST', 'ANTHROPIC_TEST_PORT', 'ANTHROPIC_TEST_PROTOCOL']
      .filter(k => !env[k]);
    if (missing.length > 0 && missing.length < 3) {
      console.warn(`[ccxray] Warning: partial ANTHROPIC_TEST_* override — ${missing.join(', ')} not set; resolved upstream: ${protocol}://${host}:${port}`);
    }
    return { host, port, protocol, basePath: '', source: 'test-override' };
  }

  const parsed = parseBaseUrl(env.ANTHROPIC_BASE_URL);
  if (parsed) {
    const { hostname: host, port, protocol, basePath } = parsed;
    if (new Set(['localhost', '127.0.0.1', '::1']).has(host) && port === proxyPort) {
      console.warn(`[ccxray] Warning: upstream ${protocol}://${host}:${port} points back at the proxy itself — requests will loop`);
    }
    return { host, port, protocol, basePath, source: 'ANTHROPIC_BASE_URL' };
  }

  return { host: 'api.anthropic.com', port: 443, protocol: 'https', basePath: '', source: 'default' };
}

const { host: ANTHROPIC_HOST, port: ANTHROPIC_PORT, protocol: ANTHROPIC_PROTOCOL, basePath: ANTHROPIC_BASE_PATH, source: ANTHROPIC_BASE_URL_SOURCE } =
  resolveUpstream(process.env, PORT);
const LOGS_DIR = path.join(os.homedir(), '.ccxray', 'logs');
const LEGACY_LOGS_DIR = path.join(__dirname, '..', 'logs');
const RESTORE_DAYS = parseInt(process.env.RESTORE_DAYS || '3', 10);
const LOG_RETENTION_DAYS = parseInt(process.env.LOG_RETENTION_DAYS || '14', 10);
// 0 = only session-start anchor; N>0 = force full snapshot every N delta writes
const DELTA_SNAPSHOT_N = parseInt(process.env.CCXRAY_DELTA_SNAPSHOT_N || '0', 10);
const REWRITE_MODEL_PREFIX = process.env.CCXRAY_MODEL_PREFIX || '';

// Storage adapter (local by default, S3 via STORAGE_BACKEND=s3)
const storage = createStorage();

// Model → context window fallback mapping (used when LiteLLM data unavailable)
// https://docs.anthropic.com/en/docs/about-claude/models
const MODEL_CONTEXT_FALLBACK = {
  'claude-opus-4':     200_000,
  'claude-sonnet-4':   200_000,
  'claude-haiku-4':    200_000,
  'claude-3-5-sonnet': 200_000,
  'claude-3-5-haiku':  200_000,
  'claude-3-opus':     200_000,
  'claude-3-sonnet':   200_000,
  'claude-3-haiku':    200_000,
};
const DEFAULT_CONTEXT = 200_000;

// Extract effective model ID from system prompt (includes [1m] suffix if present).
// API request model field never includes [1m], but system prompt does:
//   "The exact model ID is claude-opus-4-6[1m]."
function extractModelFromSystem(system) {
  if (!Array.isArray(system)) return null;
  for (const block of system) {
    const text = typeof block === 'string' ? block : (block?.text || '');
    const m = text.match(/exact model ID is (claude-[^\s.]+)/);
    if (m) return m[1];
  }
  return null;
}

function getMaxContext(model, system) {
  // Prefer model ID from system prompt (has [1m] suffix when applicable)
  const effective = extractModelFromSystem(system) || model;
  if (!effective) return DEFAULT_CONTEXT;
  // 1) Explicit suffix: "claude-opus-4-6[1m]" → 1M
  if (/\[1m\]/i.test(effective)) return 1_000_000;
  // 2) Known Claude Code defaults (200K standard plan)
  const stripped = effective.replace(/\[.*\]/, '');
  const keys = Object.keys(MODEL_CONTEXT_FALLBACK).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (stripped.startsWith(key)) return MODEL_CONTEXT_FALLBACK[key];
  }
  // 3) LiteLLM dynamic data — only for unknown models not in fallback table
  const { getModelContext } = require('./pricing');
  const dynamic = getModelContext(stripped);
  if (dynamic) return dynamic;
  return DEFAULT_CONTEXT;
}

// Ensure logs dir exists; migrate from legacy location if needed
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  // One-time migration from old package-relative logs/
  const legacyIndex = path.join(LEGACY_LOGS_DIR, 'index.ndjson');
  if (fs.existsSync(legacyIndex)) {
    try {
      const files = fs.readdirSync(LEGACY_LOGS_DIR);
      for (const f of files) {
        fs.renameSync(path.join(LEGACY_LOGS_DIR, f), path.join(LOGS_DIR, f));
      }
      console.log(`Migrated logs from ${LEGACY_LOGS_DIR} → ${LOGS_DIR}`);
    } catch (e) {
      console.error(`Log migration failed: ${e.message}`);
    }
  }
}

module.exports = {
  PORT,
  ANTHROPIC_HOST,
  ANTHROPIC_PORT,
  ANTHROPIC_PROTOCOL,
  ANTHROPIC_BASE_PATH,
  ANTHROPIC_BASE_URL_SOURCE,
  LOGS_DIR,
  RESTORE_DAYS,
  LOG_RETENTION_DAYS,
  DELTA_SNAPSHOT_N,
  REWRITE_MODEL_PREFIX,
  storage,
  MODEL_CONTEXT_FALLBACK,
  DEFAULT_CONTEXT,
  getMaxContext,
  parseBaseUrl,
};
