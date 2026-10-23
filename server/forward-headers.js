'use strict';

const { isInternalHeader } = require('./internal-headers');

const COMMON = new Set([
  'accept', 'content-type', 'content-length', 'content-encoding', 'user-agent',
  'x-request-id', 'x-client-request-id',
]);
function codexAllowlist(names, prefixes = []) {
  return {
    names: new Set([
      'authorization', 'originator', 'version', 'session-id', 'session_id',
      'thread-id', 'thread_id', 'conversation_id', ...names,
    ]),
    prefixes: ['openai-', 'x-openai-', 'x-codex-', 'x-stainless-', ...prefixes],
  };
}
const ALLOWLISTS = {
  anthropic: {
    names: new Set([
      'authorization', 'x-api-key', 'anthropic-version', 'anthropic-beta',
      'anthropic-dangerous-direct-browser-access', 'x-app', 'x-claude-code-session-id',
    ]),
    prefixes: ['anthropic-', 'x-stainless-', 'x-claude-'],
  },
  openai: codexAllowlist(['openai-organization', 'openai-project']),
  // MCP 2025-11-25 transport spec names; not yet from a capture.
  chatgpt: codexAllowlist(['chatgpt-account-id', 'last-event-id'], ['mcp-']),
  xai: {
    names: new Set(['authorization', 'x-api-key']),
    prefixes: ['x-xai-', 'x-grok-', 'x-stainless-', 'openai-', 'x-openai-'],
  },
};
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

// These names are omitted even when explicitly declared.
const HARD_DENY = new Set(['accept-encoding', 'host']);
const HARD_DENY_PREFIXES = ['x-ccxray-', 'sec-websocket-'];

function upstreamFamily(upstream) {
  const { UPSTREAMS } = require('./config');
  if (upstream === UPSTREAMS.xai) return 'xai';
  if ([UPSTREAMS.openaiChatGPT, UPSTREAMS.openaiChatGPTPlatform, UPSTREAMS.openaiChatGPTAppsMcp]
    .includes(upstream)) return 'chatgpt';
  return upstream?.provider;
}

function isHardDenied(name) {
  return HARD_DENY.has(name) || HARD_DENY_PREFIXES.some(prefix => name.startsWith(prefix));
}

function acceptsBuiltin(name, family) {
  const list = ALLOWLISTS[family];
  // The shared openai- prefix does not grant API-only account settings to ChatGPT.
  if (family === 'chatgpt' && ['openai-organization', 'openai-project'].includes(name)) return false;
  return !!list && (list.names.has(name) || list.prefixes.some(prefix => name.startsWith(prefix)));
}

function isAllowedHeader(name, family) {
  const lower = name.toLowerCase();
  return !isHardDenied(lower) && !isInternalHeader(lower)
    && (COMMON.has(lower) || acceptsBuiltin(lower, family));
}

function familyGroup(family) {
  return family === 'chatgpt' ? 'openai' : family;
}

function isForeignHeader(name, family) {
  // Explicit additions can use either built-in list within the same vendor group.
  if (COMMON.has(name) || Object.keys(ALLOWLISTS).some(other =>
    familyGroup(other) === familyGroup(family) && acceptsBuiltin(name, other))) return false;
  return Object.keys(ALLOWLISTS).some(other => familyGroup(other) !== familyGroup(family)
    && acceptsBuiltin(name, other));
}

// HTTP and WS share family selection; ws constructs its own handshake fields.
function buildForwardHeaders(clientHeaders, upstream) {
  const family = upstreamFamily(upstream);
  const { FORWARD_HEADERS } = require('./config');
  const declared = new Set([
    ...FORWARD_HEADERS.all, ...(FORWARD_HEADERS[family] || []),
    // Claude launchers declare user names for the Anthropic family only.
    ...(family === 'anthropic' ? String(clientHeaders['x-ccxray-forward-headers'] || '')
      .toLowerCase().split(',').map(name => name.trim()) : []),
  ]);
  const connectionNames = new Set(String(clientHeaders.connection || '')
    .split(',').map(name => name.trim().toLowerCase()).filter(Boolean));
  const headers = {};
  for (const [name, value] of Object.entries(clientHeaders)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || connectionNames.has(lower)) continue;
    if (isHardDenied(lower) || isInternalHeader(lower)) continue;
    if (!isAllowedHeader(lower, family)
      && !(ALLOWLISTS[family] && declared.has(lower) && !isForeignHeader(lower, family)
        && /^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(lower))) continue;
    headers[lower] = value;
  }
  headers.host = upstream.host;
  return headers;
}

module.exports = { buildForwardHeaders, isAllowedHeader, upstreamFamily };
