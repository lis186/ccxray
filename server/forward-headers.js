'use strict';

const { isInternalHeader } = require('./internal-headers');

const COMMON = new Set([
  'accept', 'content-type', 'content-length', 'content-encoding', 'user-agent',
  'x-request-id', 'x-client-request-id',
]);
const OPENAI = {
  names: new Set([
    'authorization', 'chatgpt-account-id', 'originator', 'version',
    'session-id', 'session_id', 'thread-id', 'thread_id', 'conversation_id',
    'openai-organization', 'openai-project',
  ]),
  prefixes: ['openai-', 'x-openai-', 'x-codex-', 'x-stainless-'],
};
const ALLOWLISTS = {
  anthropic: {
    names: new Set([
      'authorization', 'x-api-key', 'anthropic-version', 'anthropic-beta',
      'anthropic-dangerous-direct-browser-access', 'x-app', 'x-claude-code-session-id',
    ]),
    prefixes: ['anthropic-', 'x-stainless-', 'x-claude-'],
  },
  openai: OPENAI,
  chatgpt: OPENAI,
  xai: {
    names: new Set(['authorization', 'x-api-key']),
    prefixes: ['x-grok-', 'x-stainless-', 'openai-', 'x-openai-'],
  },
};
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

function upstreamFamily(upstream) {
  const { UPSTREAMS } = require('./config');
  if (upstream === UPSTREAMS.xai) return 'xai';
  if ([UPSTREAMS.openaiChatGPT, UPSTREAMS.openaiChatGPTPlatform, UPSTREAMS.openaiChatGPTAppsMcp]
    .includes(upstream)) return 'chatgpt';
  return upstream?.provider;
}

function isAllowedHeader(name, family) {
  const lower = name.toLowerCase();
  if (isInternalHeader(lower)) return false;
  const list = ALLOWLISTS[family];
  return COMMON.has(lower) || !!list && (list.names.has(lower)
    || list.prefixes.some(prefix => lower.startsWith(prefix)));
}

function isForeignHeader(name, family) {
  if (family === 'anthropic') {
    return ['chatgpt-account-id', 'originator'].includes(name)
      || ['openai-', 'x-openai-', 'x-codex-'].some(prefix => name.startsWith(prefix));
  }
  return ['openai', 'chatgpt', 'xai'].includes(family)
    && (name === 'x-api-key' || ['anthropic-', 'x-claude-'].some(prefix => name.startsWith(prefix)));
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
    if (isInternalHeader(lower) || lower.startsWith('sec-websocket-')) continue;
    if (!isAllowedHeader(lower, family)
      && !(ALLOWLISTS[family] && declared.has(lower) && !isForeignHeader(lower, family)
        && /^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(lower))) continue;
    headers[lower] = value;
  }
  headers.host = upstream.host;
  return headers;
}

module.exports = { buildForwardHeaders, isAllowedHeader, upstreamFamily };
