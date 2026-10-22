'use strict';

// Lazy module caches keep config/hub/provider initialization independent.
let hub;
let providers;
function clientAgentType(req) {
  if (!req) return undefined;
  hub ||= require('./hub');
  return hub.lookupClientIdentityForRequest(req)?.agentType;
}

function matchOpenAIWireClient(headers) {
  providers ||= require('./providers');
  return providers.matchOpenAIWireClient(headers);
}

function isJwtShaped(authHeader) {
  if (typeof authHeader !== 'string' || !/^Bearer /i.test(authHeader)) return false;
  const parts = authHeader.slice(7).split('.');
  return parts.length === 3 && parts[0].length > 10;
}

function hasAnthropicHeaders(headers) {
  return ['anthropic-version', 'anthropic-beta', 'x-api-key'].some(key => key in headers)
    || /^Bearer sk-ant-/i.test(headers.authorization || '');
}

function isAnthropicSide(headers = {}, req) {
  return hasAnthropicHeaders(headers) || clientAgentType(req) === 'claude';
}

function isOpenAISide(headers = {}, req) {
  return Object.keys(headers).some(key => key === 'chatgpt-account-id'
      || /^(openai-|x-openai-|x-codex-)/.test(key)
      || (key === 'originator' && /^codex/i.test(String(headers[key]))))
    || !!matchOpenAIWireClient(headers)
    || ['codex', 'grok'].includes(clientAgentType(req))
    || (/^Bearer sk-/i.test(headers.authorization || '')
      && !/^Bearer sk-ant-/i.test(headers.authorization || '')
      && !hasAnthropicHeaders(headers));
}

module.exports = { isJwtShaped, isOpenAISide, isAnthropicSide, matchOpenAIWireClient };
