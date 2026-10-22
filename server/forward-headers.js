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
    prefixes: ['x-grok-', 'x-stainless-', 'openai-'],
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

function buildForwardHeaders(clientHeaders, upstream, { websocket = false } = {}) {
  const family = websocket ? 'openai' : upstreamFamily(upstream);
  const connectionNames = new Set(String(clientHeaders.connection || '')
    .split(',').map(name => name.trim().toLowerCase()).filter(Boolean));
  const headers = {};
  for (const [name, value] of Object.entries(clientHeaders)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || connectionNames.has(lower)) continue;
    if (!isAllowedHeader(lower, family)) continue;
    headers[lower] = value;
  }
  headers.host = upstream.host;
  return headers;
}

module.exports = { buildForwardHeaders, isAllowedHeader, upstreamFamily };
