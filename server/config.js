'use strict';

const { createStorage } = require('./storage');
const { resolveLogsDir } = require('./paths');

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
    return null;
  }
}

function isLoopbackHost(host) {
  return new Set(['localhost', '127.0.0.1', '::1']).has(host);
}

function warnInvalidBaseUrl(envName, rawUrl, fallbackHost) {
  console.warn(`[ccxray] Warning: ${envName} is not a valid URL ("${rawUrl}"); falling back to ${fallbackHost}`);
}

function warnSelfLoop(provider, protocol, host, port) {
  console.warn(`[ccxray] Warning: ${provider} upstream ${protocol}://${host}:${port} points back at the proxy itself — requests will loop`);
}

function resolveChatGPTUpstream(env, proxyPort) {
  const raw = env.CHATGPT_BASE_URL || env.CODEX_CHATGPT_BASE_URL;
  const parsed = parseBaseUrl(raw);
  if (parsed) {
    const { hostname: host, port, protocol, basePath } = parsed;
    if (isLoopbackHost(host) && port === proxyPort) {
      warnSelfLoop('chatgpt', protocol, host, port);
    }
    return {
      provider: 'openai',
      host,
      port,
      protocol,
      basePath,
      stripPathPrefix: '/v1',
      source: env.CHATGPT_BASE_URL ? 'CHATGPT_BASE_URL' : 'CODEX_CHATGPT_BASE_URL',
    };
  }
  if (raw) warnInvalidBaseUrl(env.CHATGPT_BASE_URL ? 'CHATGPT_BASE_URL' : 'CODEX_CHATGPT_BASE_URL', raw, 'chatgpt.com');

  return {
    provider: 'openai',
    host: 'chatgpt.com',
    port: 443,
    protocol: 'https',
    basePath: '/backend-api/codex',
    stripPathPrefix: '/v1',
    source: 'chatgpt-default',
  };
}

// Priority: PROVIDER_TEST_* (test/CI overrides) > PROVIDER_BASE_URL > built-in defaults
function resolveProviderUpstream(provider, env, proxyPort, opts) {
  const upper = provider.toUpperCase();
  const testHostKey = `${upper}_TEST_HOST`;
  const testPortKey = `${upper}_TEST_PORT`;
  const testProtocolKey = `${upper}_TEST_PROTOCOL`;
  const baseUrlKey = `${upper}_BASE_URL`;

  if (env[testHostKey] || env[testPortKey] || env[testProtocolKey]) {
    const host = env[testHostKey] || opts.defaultHost;
    const port = parseInt(env[testPortKey] || String(opts.defaultPort), 10);
    const protocol = env[testProtocolKey] || opts.defaultProtocol;
    const missing = [testHostKey, testPortKey, testProtocolKey]
      .filter(k => !env[k]);
    if (missing.length > 0 && missing.length < 3) {
      console.warn(`[ccxray] Warning: partial ${upper}_TEST_* override — ${missing.join(', ')} not set; resolved upstream: ${protocol}://${host}:${port}`);
    }
    return { provider, host, port, protocol, basePath: '', source: 'test-override' };
  }

  const parsed = parseBaseUrl(env[baseUrlKey]);
  if (parsed) {
    const { hostname: host, port, protocol, basePath } = parsed;
    if (isLoopbackHost(host) && port === proxyPort) {
      warnSelfLoop(provider, protocol, host, port);
    }
    return { provider, host, port, protocol, basePath, source: baseUrlKey };
  }

  if (env[baseUrlKey]) warnInvalidBaseUrl(baseUrlKey, env[baseUrlKey], opts.defaultHost);

  return {
    provider,
    host: opts.defaultHost,
    port: opts.defaultPort,
    protocol: opts.defaultProtocol,
    basePath: opts.defaultBasePath || '',
    source: 'default',
  };
}

const UPSTREAMS = {
  anthropic: resolveProviderUpstream('anthropic', process.env, PORT, {
    defaultHost: 'api.anthropic.com',
    defaultPort: 443,
    defaultProtocol: 'https',
    defaultBasePath: '',
  }),
  openai: resolveProviderUpstream('openai', process.env, PORT, {
    defaultHost: 'api.openai.com',
    defaultPort: 443,
    defaultProtocol: 'https',
    defaultBasePath: '/v1',
  }),
  openaiChatGPT: resolveChatGPTUpstream(process.env, PORT),
};

const { host: ANTHROPIC_HOST, port: ANTHROPIC_PORT, protocol: ANTHROPIC_PROTOCOL, basePath: ANTHROPIC_BASE_PATH, source: ANTHROPIC_BASE_URL_SOURCE } =
  UPSTREAMS.anthropic;
const { host: OPENAI_HOST, port: OPENAI_PORT, protocol: OPENAI_PROTOCOL, basePath: OPENAI_BASE_PATH, source: OPENAI_BASE_URL_SOURCE } =
  UPSTREAMS.openai;

function getUpstream(provider) {
  return UPSTREAMS[provider] || UPSTREAMS.anthropic;
}

function getProviderForRequest(urlPath) {
  const pathname = (urlPath || '').split('?')[0];
  if (pathname === '/v1/responses' || pathname.startsWith('/v1/responses/')) return 'openai';
  if (pathname === '/v1/realtime' || pathname.startsWith('/v1/realtime/')) return 'openai';
  if (pathname === '/v1/models' || pathname.startsWith('/v1/models/')) return 'openai';
  if (isChatGPTCodexPath(pathname)) return 'openai';
  return 'anthropic';
}

function getUpstreamForRequest(urlPath) {
  return getUpstream(getProviderForRequest(urlPath));
}

function isChatGPTCodexPath(pathname) {
  return pathname === '/v1/api/codex'
    || pathname.startsWith('/v1/api/codex/')
    || pathname === '/v1/codex'
    || pathname.startsWith('/v1/codex/')
    || pathname === '/v1/plugins'
    || pathname.startsWith('/v1/plugins/')
    || pathname === '/v1/ps/plugins'
    || pathname.startsWith('/v1/ps/plugins/')
    || pathname === '/v1/connectors'
    || pathname.startsWith('/v1/connectors/');
}

// Codex 0.133+ hits a flurry of platform endpoints on startup (plugin lists,
// connector directory, app metadata, usage). They're not conversation data —
function getUpstreamForRequestAndHeaders(urlPath, headers = {}) {
  const pathname = (urlPath || '').split('?')[0];
  if (isChatGPTCodexPath(pathname)) {
    return UPSTREAMS.openaiChatGPT;
  }
  const upstream = getUpstreamForRequest(urlPath);
  if (upstream.provider === 'openai' && headers['chatgpt-account-id']) {
    return UPSTREAMS.openaiChatGPT;
  }
  return upstream;
}

function joinUpstreamPath(upstream, requestUrl) {
  const basePath = upstream?.basePath || '';
  let urlPath = requestUrl || '/';
  const stripPrefix = upstream?.stripPathPrefix;
  if (stripPrefix && (urlPath === stripPrefix || urlPath.startsWith(`${stripPrefix}/`) || urlPath.startsWith(`${stripPrefix}?`))) {
    urlPath = urlPath.slice(stripPrefix.length) || '/';
  }
  if (!basePath) return urlPath;
  if (urlPath === basePath || urlPath.startsWith(`${basePath}/`) || urlPath.startsWith(`${basePath}?`)) {
    return urlPath;
  }
  return basePath + (urlPath.startsWith('/') ? urlPath : `/${urlPath}`);
}
const LOGS_DIR = resolveLogsDir();
const LOG_RETENTION_DAYS = parseInt(process.env.LOG_RETENTION_DAYS || '14', 10);
// ponytail: aligned with LOG_RETENTION_DAYS so the index is a cache, not a sole record
const RESTORE_DAYS = parseInt(process.env.RESTORE_DAYS || String(LOG_RETENTION_DAYS), 10);
// 0 = only session-start anchor; N>0 = force full snapshot every N delta writes
const DELTA_SNAPSHOT_N = parseInt(process.env.CCXRAY_DELTA_SNAPSHOT_N || '0', 10);
const REWRITE_MODEL_PREFIX = process.env.CCXRAY_MODEL_PREFIX || '';

// Storage adapter (local filesystem only; remote object storage not yet supported)
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
  'gpt-5.2-codex':       400_000,
  'gpt-5.1-codex-max':   400_000,
  'gpt-5.1-codex-mini':  400_000,
  'gpt-5.1-codex':       400_000,
  'gpt-5-codex':         400_000,
  'gpt-5.2-chat-latest': 400_000,
  'gpt-5.1-chat-latest': 400_000,
  'gpt-5-chat-latest':   400_000,
  'gpt-5.2':             400_000,
  'gpt-5.1':             400_000,
  'gpt-5-mini':          400_000,
  'gpt-5-nano':          400_000,
  'gpt-5':               400_000,
  'gpt-4.1':             1_000_000,
  'gpt-4o':              128_000,
};
const DEFAULT_CONTEXT = 200_000;

// Models that can actually be served with a 1M context window. The 1M signal
// (anthropic-beta context-1m header, or the system "[1m]" marker) is a
// client/account-level capability flag — it rides on EVERY Claude Code request,
// including haiku title-gen turns. Gate the 1M jump on the model itself so a
// haiku request carrying the beta header is not shown as a 1M window. New 1M
// families get one line here, not a logic change.
// #211: fable-5 verified live — `claude --model 'claude-fable-5[1m]'` sends
// context-1m-* in anthropic-beta plus the "[1m]" system marker; the bare model
// sends neither and runs 200K. sonnet-5 / mythos are 1M-capable per Anthropic
// model docs (1M is the API default for fable/mythos; Claude Code still
// serves 200K sessions unless [1m] is selected).
const SUPPORTS_1M = /^claude-(opus-4|sonnet-4|sonnet-5|fable-5|mythos)/;

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

function getMaxContext(model, system, opts = {}) {
  // Model IDENTITY comes from the request `model` field — it updates immediately
  // on a mid-session model switch. The system marker is only a fallback for
  // identity, because Claude Code's "The exact model ID is ..." line lags several
  // turns behind the switch and would otherwise corrupt the window denominator
  // (issue #58). The system marker is still the place the "[1m]" suffix appears.
  const sysModel = extractModelFromSystem(system);
  const identity = model || sysModel;
  if (!identity) return DEFAULT_CONTEXT;
  const stripped = identity.replace(/\[.*\]/, '');
  // 1) 1M plan active? Two non-mutually-exclusive signals:
  //    - opts.beta1m: anthropic-beta `context-1m-*` request header (non-lagging,
  //      present on every turn — the authoritative plan flag).
  //    - "[1m]" suffix in the system marker (legacy; lags after a model switch).
  //      The marker only counts when it names the same model as the request —
  //      a stale fable-5[1m] marker must not carry its 1M over to a freshly
  //      switched-to sonnet-5 leg (#212 review).
  //    Either signal counts, but only for a 1M-capable model (SUPPORTS_1M) so a
  //    client-level flag riding on a haiku request does not over-claim 1M.
  const markerMatchesIdentity = !!sysModel && sysModel.replace(/\[.*\]/, '') === stripped;
  const has1mSignal = opts.beta1m === true
    || (markerMatchesIdentity && /\[1m\]/i.test(sysModel))
    || /\[1m\]/i.test(model || '');
  if (has1mSignal && SUPPORTS_1M.test(stripped)) return 1_000_000;
  // 2) Known Claude Code / Codex defaults (200K / 400K)
  const keys = Object.keys(MODEL_CONTEXT_FALLBACK).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (stripped.startsWith(key)) return MODEL_CONTEXT_FALLBACK[key];
  }
  // 3) LiteLLM dynamic data — only for unknown models not in fallback table.
  //    #211: LiteLLM's max_input_tokens is the model's max *capability*
  //    (claude-fable-5 → 1M), not the default serving window. Claude Code
  //    sessions default to 200K; a bigger window requires the 1M signal
  //    handled above. Trusting the raw value made every fable-5 turn divide
  //    by 1M and under-report context usage ~5x (17% shown for an 86% -full
  //    session). Clamp Claude models to DEFAULT_CONTEXT — genuine 1M sessions
  //    recover via the signals above or inferMaxContext's usage hatch.
  const { getModelContext } = require('./pricing');
  const dynamic = getModelContext(stripped);
  if (dynamic) {
    return stripped.startsWith('claude-') ? Math.min(dynamic, DEFAULT_CONTEXT) : dynamic;
  }
  return DEFAULT_CONTEXT;
}

// Usage-aware refinement of getMaxContext. The [1m] marker only appears in
// Claude Code's system prompt; requests without that prompt (title-gen,
// some subagent paths) report a bare model name and fall back to 200K — but
// a Max-plan user may actually be on 1M. When observed usage exceeds the
// base, bump Claude models up to 1M so the dashboard "X / Y (Z%)" stays
// self-consistent. Non-Claude models are not bumped because we have no
// reliable next tier to escalate to.
function inferMaxContext(model, system, usage, opts = {}) {
  const base = getMaxContext(model, system, opts);
  if (!usage) return base;
  const used = (usage.input_tokens || 0)
    + (usage.cache_creation_input_tokens || 0)
    + (usage.cache_read_input_tokens || 0);
  if (used <= base) return base;
  const effective = extractModelFromSystem(system) || model || '';
  const stripped = effective.replace(/\[.*\]/, '');
  if (stripped.startsWith('claude-') && base < 1_000_000) return 1_000_000;
  return base;
}

// Logs-dir creation and the one-time legacy-logs migration now live in the
// local storage adapter's init() (server/storage/local.js), invoked once at
// startup via `await config.storage.init()`. config.js performs no filesystem
// side effects at require time, and the migration only runs for the local
// backend (S3/R2 never reads LOGS_DIR).

module.exports = {
  PORT,
  ANTHROPIC_HOST,
  ANTHROPIC_PORT,
  ANTHROPIC_PROTOCOL,
  ANTHROPIC_BASE_PATH,
  ANTHROPIC_BASE_URL_SOURCE,
  OPENAI_HOST,
  OPENAI_PORT,
  OPENAI_PROTOCOL,
  OPENAI_BASE_PATH,
  OPENAI_BASE_URL_SOURCE,
  UPSTREAMS,
  LOGS_DIR,
  RESTORE_DAYS,
  LOG_RETENTION_DAYS,
  DELTA_SNAPSHOT_N,
  REWRITE_MODEL_PREFIX,
  storage,
  MODEL_CONTEXT_FALLBACK,
  DEFAULT_CONTEXT,
  SUPPORTS_1M,
  extractModelFromSystem,
  getMaxContext,
  inferMaxContext,
  parseBaseUrl,
  resolveProviderUpstream,
  getProviderForRequest,
  getUpstream,
  getUpstreamForRequest,
  getUpstreamForRequestAndHeaders,
  joinUpstreamPath,
};
