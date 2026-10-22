'use strict';

// Lazy module caches keep config/hub/provider initialization independent.
let hub;
let providers;
function clientAgentType(req) {
  if (!req) return undefined;
  hub ||= require('./hub');
  return hub.lookupClientIdentityForRequest(req)?.agentType;
}

function matchOpenAIWireClient(headers = {}) {
  providers ||= require('./providers');
  return providers.matchOpenAIWireClient(Object.fromEntries(
    Object.entries(headers).filter(([, value]) => hasHeaderValue(value))
  ));
}

function isJwtShaped(authHeader) {
  if (typeof authHeader !== 'string' || !/^Bearer /i.test(authHeader)) return false;
  const parts = authHeader.slice(7).split('.');
  return parts.length === 3 && parts[0].length > 10;
}

function hasHeaderValue(value) {
  return Array.isArray(value) ? value.some(hasHeaderValue)
    : typeof value === 'string' && value.trim().length > 0;
}

function isChatGPTSide(headers = {}) {
  return Object.entries(headers).some(([key, value]) => {
    if (!hasHeaderValue(value)) return false;
    if (key === 'chatgpt-account-id' || /^x-codex-/.test(key)
        || (key === 'originator' && /^codex/i.test(String(value)))) return true;
    // Check each header so a Grok marker cannot mask a Codex UA match.
    const client = matchOpenAIWireClient({ [key]: value });
    return !!client && client.id !== 'grok';
  });
}

function hasAnthropicHeaders(headers, req) {
  // Header-aware routing: Grok can supply x-api-key through extra_headers.
  const grokClient = matchOpenAIWireClient(headers)?.id === 'grok' || clientAgentType(req) === 'grok';
  const xKeys = [headers['x-api-key']].flat();
  const anthropicKey = xKeys.some(value => typeof value === 'string' && /^sk-ant-/i.test(value.trim()));
  return ['anthropic-version', 'anthropic-beta'].some(key => hasHeaderValue(headers[key]))
    || (hasHeaderValue(headers['x-api-key']) && (!grokClient || anthropicKey))
    || /^Bearer sk-ant-/i.test(headers.authorization || '');
}

function isAnthropicSide(headers = {}, req) {
  return hasAnthropicHeaders(headers, req) || clientAgentType(req) === 'claude';
}

function isOpenAISide(headers = {}, req, includeBareBearer = true) {
  return Object.keys(headers).some(key => hasHeaderValue(headers[key]) && (key === 'chatgpt-account-id'
      || /^(openai-|x-openai-|x-codex-)/.test(key)
      || (key === 'originator' && /^codex/i.test(String(headers[key])))))
    || !!matchOpenAIWireClient(headers)
    || ['codex', 'grok'].includes(clientAgentType(req))
    || (includeBareBearer && /^Bearer sk-/i.test(headers.authorization || '')
      && !hasAnthropicHeaders(headers, req));
}

module.exports = { isChatGPTSide, clientAgentType, isJwtShaped, isOpenAISide, isAnthropicSide, matchOpenAIWireClient };
