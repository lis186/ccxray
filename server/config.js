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

// Secondary OpenAI-wire host for OPENAI_WIRE_CLIENTS modules (currently Grok CLI).
// provider stays 'openai' so wire-parsers/openai.js handles the body.
// Override: XAI_BASE_URL or GROK_BASE_URL (e.g. https://api.x.ai/v1 for BYOK).
function resolveXaiUpstream(env, proxyPort) {
  const raw = env.XAI_BASE_URL || env.GROK_BASE_URL || '';
  if (raw) {
    const parsed = parseBaseUrl(raw);
    if (parsed) {
      const { hostname: host, port, protocol, basePath } = parsed;
      if (isLoopbackHost(host) && port === proxyPort) {
        warnSelfLoop('xai', protocol, host, port);
      }
      return {
        provider: 'openai',
        host,
        port,
        protocol,
        basePath,
        source: env.XAI_BASE_URL ? 'XAI_BASE_URL' : 'GROK_BASE_URL',
      };
    }
    warnInvalidBaseUrl(env.XAI_BASE_URL ? 'XAI_BASE_URL' : 'GROK_BASE_URL', raw, 'cli-chat-proxy.grok.com');
  }
  return {
    provider: 'openai',
    host: 'cli-chat-proxy.grok.com',
    port: 443,
    protocol: 'https',
    basePath: '/v1',
    source: 'xai-default',
  };
}

// Thin wrapper over providers.OPENAI_WIRE_CLIENTS for tests / call sites.
function isGrokClient(headers = {}) {
  try {
    const { matchOpenAIWireClient } = require('./providers');
    return matchOpenAIWireClient(headers)?.id === 'grok';
  } catch {
    return false;
  }
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
  xai: resolveXaiUpstream(process.env, PORT),
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
  // ponytail: chat/completions classification deferred until wire parser handles the shape
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

// Anthropic Messages must never be re-routed to xAI even if a Grok UA is present.
function isAnthropicMessagesPath(pathname) {
  return pathname === '/v1/messages' || pathname.startsWith('/v1/messages/');
}

// Codex platform paths + OpenAI-wire client modules (OPENAI_WIRE_CLIENTS) that
// need a host other than api.openai.com. Hub can serve multiple agent CLIs
// without swapping OPENAI_BASE_URL.
function getUpstreamForRequestAndHeaders(urlPath, headers = {}) {
  const pathname = (urlPath || '').split('?')[0];
  if (isChatGPTCodexPath(pathname)) {
    return UPSTREAMS.openaiChatGPT;
  }
  if (pathname.startsWith('/v1/') && !isAnthropicMessagesPath(pathname)) {
    try {
      const { matchOpenAIWireClient } = require('./providers');
      const client = matchOpenAIWireClient(headers);
      if (client?.upstreamKey && UPSTREAMS[client.upstreamKey]) {
        return UPSTREAMS[client.upstreamKey];
      }
    } catch { /* providers unavailable in minimal test stubs */ }
  }
  const upstream = getUpstreamForRequest(urlPath);
  // EXCEPTION(#158): infrastructure — upstream routing for ChatGPT OAuth before parser dispatch
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
const MAX_SSE_PER_IP = parseInt(process.env.CCXRAY_SSE_MAX_PER_IP || '20', 10);
// ponytail: aligned with LOG_RETENTION_DAYS so the index is a cache, not a sole record
const RESTORE_DAYS = parseInt(process.env.RESTORE_DAYS || String(LOG_RETENTION_DAYS), 10);
// 0 = only session-start anchor; N>0 = force full snapshot every N delta writes
const DELTA_SNAPSHOT_N = parseInt(process.env.CCXRAY_DELTA_SNAPSHOT_N || '0', 10);
const REWRITE_MODEL_PREFIX = process.env.CCXRAY_MODEL_PREFIX || '';
const MAX_BODY_BYTES = parseInt(process.env.CCXRAY_MAX_BODY_MB || '50', 10) * 1024 * 1024;

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
  // Grok CLI / xAI (from cli-chat-proxy models_cache, obs-stable 0.2.93)
  'grok-4.5':            500_000,
  'grok-4.5-build':      500_000,
  'grok-4':              256_000,
  'grok-3':              131_072,
  'grok-code-fast':      256_000,
  'grok-build':          2_000_000,
  'grok-composer':       200_000,
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
//
// This regex is now the OFFLINE FALLBACK only — `modelSupports1M()` prefers
// LiteLLM's context table, which ccxray already downloads and refreshes daily.
// A hand-maintained list is wrong in both directions the moment a model ships:
// it missed claude-opus-5 (1M shown as 200K → phantom context pressure) while
// the bare `opus-4` prefix claimed 1M for claude-opus-4-5, which serves 200K
// (real pressure hidden). Keep this list narrow and literal; it only decides
// models seen before the pricing cache exists.
// The sonnet-4 family is anchored rather than prefix-matched: `sonnet-4` and
// `sonnet-4-5` serve 1M (LiteLLM reports both at 200K, so this list is the only
// source for them), but a bare `sonnet-4` prefix would also claim 1M for every
// future minor — the exact `opus-4` over-match that this work had to undo. A
// dated build (`-20250514`) is the same model; a new minor is not.
const SUPPORTS_1M = /^claude-(opus-4-6|opus-4-7|opus-4-8|opus-5|sonnet-5|fable-5|mythos)|^claude-sonnet-4(-5)?($|[-@]\d{8})/;

// Is this model CAPABLE of a 1M window? Two sources, UNION — LiteLLM may only
// ADD, never DENY.
//
// LiteLLM's max_input_tokens is not a consistent capability signal: it reports
// claude-fable-5 at 1M (capability) but claude-sonnet-4-5 at 200K (default
// serving window), even though Sonnet 4.5 serves 1M under the beta. Letting it
// deny therefore breaks a model the regex had right. Letting it add picks up
// every newly shipped model it lists at 1M (claude-opus-5 was the miss that
// started this) without waiting for a release here.
//
// Removing a WRONG entry stays a manual edit of the regex above, because no
// upstream source can be trusted to mean "cannot do 1M".
//
// Capability alone never widens a window — getMaxContext still requires the 1M
// signal — so a haiku title-gen turn carrying the account-level beta header
// still resolves to 200K.
// INVARIANT: LiteLLM may ADD, never DENY (its max_input_tokens means capability
// for some models and default serving window for others), and this predicate's
// input is a table refreshed daily — so agreement with restore.js's trustStored
// is agreement in code, not in time. Absence of capability data must never act
// as a deny. See docs/decisions/0013-*.
function modelSupports1M(stripped) {
  if (!stripped) return false;
  if (SUPPORTS_1M.test(stripped)) return true;
  const { getModelContext } = require('./pricing');
  const capability = getModelContext(stripped);
  return typeof capability === 'number' && capability >= 1_000_000;
}

// The `anthropic-beta` request header, reduced to its context-* entries. The
// tier lives in the id (`context-1m-2025-08-07`), so persisting the string keeps
// a future `context-400k-*` legible instead of collapsing it to "not 1M".
// Whitelisted deliberately: the rest of that header, and every other request
// header, stays out of the log.
function extractContextBeta(headerValue) {
  if (!headerValue) return null;
  // Shape-matched, not prefix-matched: `context-` also prefixes betas that have
  // nothing to do with window size (context-management-*, the context-editing
  // beta, ships on real traffic). Storing those would put a window-less string
  // in a window field on nearly every line, and any consumer testing truthiness
  // would misread it. The filter and contextBetaWindow's parser share one shape.
  const parts = String(headerValue)
    .split(',')
    .map(part => part.trim())
    .filter(part => /^context-\d+(?:\.\d+)?[km]-/i.test(part));
  return parts.length ? parts.join(',') : null;
}

// Window a context-* beta id asks for, e.g. `context-1m-2025-08-07` → 1_000_000
// and `context-400k-…` → 400_000. Parsed rather than tabulated so an unreleased
// tier does not need a code change to be readable; an id we cannot parse returns
// null and the caller falls back to the other signals.
function contextBetaWindow(ctxBeta) {
  if (!ctxBeta) return null;
  let best = null;
  for (const part of String(ctxBeta).split(',')) {
    const m = /^context-(\d+(?:\.\d+)?)(k|m)-/i.exec(part.trim());
    if (!m) continue;
    const scale = m[2].toLowerCase() === 'm' ? 1_000_000 : 1_000;
    const size = Math.round(parseFloat(m[1]) * scale);
    if (size > 0 && (best == null || size > best)) best = size;
  }
  return best;
}

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

// #339: does the beta1m header authoritatively make this turn a 1M window? The single
// source of truth for the beta1m→1M gate, so the persisted `beta1m` fact
// (wire-parsers/anthropic.js) can never disagree with getMaxContext's own beta1m branch
// below. Identity resolves model || system-marker, exactly like getMaxContext.
function beta1mIndicates1M(model, system, beta1m) {
  if (beta1m !== true) return false;
  const stripped = (model || extractModelFromSystem(system) || '').replace(/\[.*\]/, '');
  return modelSupports1M(stripped);
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
  // beta1m branch delegates to the shared helper so the persisted `beta1m` fact
  // (wire-parsers/anthropic.js) can never diverge from this gate (#339 / codex round 2).
  const asked = contextBetaWindow(opts.ctxBeta);
  if (beta1mIndicates1M(model, system, opts.beta1m || asked === 1_000_000)) return 1_000_000;
  // A context-* beta naming a tier other than 1M (none shipped yet — this is the
  // reason the raw header is persisted rather than a boolean). Same shape as the
  // 1M gate: the client asked, the model still has to be able to serve it.
  if (asked && asked > DEFAULT_CONTEXT) {
    const { getModelContext } = require('./pricing');
    const capability = getModelContext(stripped);
    if (typeof capability === 'number' && capability >= asked) return asked;
  }
  // [1m] system-marker branch (lagging legacy signal), same SUPPORTS_1M gate.
  const markerMatchesIdentity = !!sysModel && sysModel.replace(/\[.*\]/, '') === stripped;
  const markerSignal = (markerMatchesIdentity && /\[1m\]/i.test(sysModel)) || /\[1m\]/i.test(model || '');
  if (markerSignal && modelSupports1M(stripped)) return 1_000_000;
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
// a Max-plan user may actually be on 1M.
//
// Observed context is the one signal no table can contradict: a request
// carrying N tokens proves the window is at least N. Climb to the smallest
// window that covers the observation — the model's own capability when we know
// it, the observation itself when the data says that is impossible — instead of
// jumping to a hardcoded 1M. Two failures that fixed: a model on the real
// 409,600 tier claimed 1M (2.5x too generous, hiding pressure), and a non-Claude
// model that exceeded its assumed window kept it and rendered above 100%.
function inferMaxContext(model, system, usage, opts = {}) {
  const base = getMaxContext(model, system, opts);
  if (!usage) return base;
  const used = (usage.input_tokens || 0)
    + (usage.cache_creation_input_tokens || 0)
    + (usage.cache_read_input_tokens || 0);
  if (used <= base) return base;
  const effective = extractModelFromSystem(system) || model || '';
  const stripped = effective.replace(/\[.*\]/, '');
  // Non-Claude providers keep their window untouched: some report input_tokens
  // INCLUSIVE of cached tokens (providers.js normalizeUsageForProvider), so an
  // un-normalized usage object can sum above the window without the window being
  // wrong. Inflating it from a possibly double-counted total would hide pressure
  // — the unsafe direction. A genuine overflow stays visible as ctx > 100%.
  if (!stripped.startsWith('claude-')) return base;
  const { getModelContext } = require('./pricing');
  const capability = getModelContext(stripped);
  if (typeof capability === 'number' && capability > base) {
    // The smallest window we can name that still covers what we saw.
    return capability >= used ? capability : used;
  }
  // No usable capability datum: Claude serves 200K or 1M in practice.
  return base < 1_000_000 ? 1_000_000 : base;
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
  MAX_SSE_PER_IP,
  REWRITE_MODEL_PREFIX,
  MAX_BODY_BYTES,
  storage,
  MODEL_CONTEXT_FALLBACK,
  DEFAULT_CONTEXT,
  SUPPORTS_1M,
  modelSupports1M,
  extractContextBeta,
  contextBetaWindow,
  extractModelFromSystem,
  beta1mIndicates1M,
  getMaxContext,
  inferMaxContext,
  parseBaseUrl,
  resolveProviderUpstream,
  getProviderForRequest,
  getUpstream,
  getUpstreamForRequest,
  getUpstreamForRequestAndHeaders,
  joinUpstreamPath,
  isGrokClient,
  resolveXaiUpstream,
};
