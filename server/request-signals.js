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

function headerValues(headers, name, req) {
  // Comma splitting is only safe for the Bearer / x-api-key shape checks served here.
  if (Array.isArray(req?.rawHeaders)) {
    const values = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (req.rawHeaders[i].toLowerCase() === name) values.push(req.rawHeaders[i + 1]);
    }
    if (values.length) return values.flatMap(value => String(value).split(',')).map(value => value.trim());
  }
  const values = req?.headersDistinct?.[name] ?? headers[name];
  return [values].flat().filter(value => typeof value === 'string')
    .flatMap(value => value.split(',')).map(value => value.trim());
}

function isJwtShaped(authHeader) {
  return headerValues({ authorization: authHeader }, 'authorization').some(value => {
    const match = /^Bearer\s+(.+)$/i.exec(value);
    if (!match) return false;
    const parts = match[1].split('.');
    return parts.length === 3 && parts[0].length > 10;
  });
}

function hasConflictingAuthValues(headers = {}, req) {
  const xKeys = headerValues(headers, 'x-api-key', req).filter(Boolean);
  if (new Set(xKeys).size > 1) return true;
  const values = [
    ...headerValues(headers, 'authorization', req).map(value => value.replace(/^Bearer\s+/i, '')),
    ...xKeys.map(value => value.replace(/^Bearer\s+/i, '')),
  ].filter(Boolean);
  const anthropic = values.some(value => /^sk-ant-/i.test(value));
  const openai = values.some(value => (/^sk-/i.test(value) && !/^sk-ant-/i.test(value))
    || (/^\S+$/.test(value) && isJwtShaped(`Bearer ${value}`)));
  return anthropic && openai;
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
  const xKeys = headerValues(headers, 'x-api-key', req);
  const anthropicKey = xKeys.some(value => typeof value === 'string' && /^sk-ant-/i.test(value.trim()));
  return ['anthropic-version', 'anthropic-beta'].some(key => hasHeaderValue(headers[key]))
    || (xKeys.some(hasHeaderValue) && (!grokClient || anthropicKey))
    || headerValues(headers, 'authorization', req).some(value => /^Bearer\s+sk-ant-/i.test(value));
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
    || (includeBareBearer && headerValues(headers, 'authorization', req).some(value => /^Bearer\s+sk-/i.test(value))
      && !hasAnthropicHeaders(headers, req));
}

module.exports = { isChatGPTSide, clientAgentType, isJwtShaped, isOpenAISide, isAnthropicSide, matchOpenAIWireClient,
  hasConflictingAuthValues };
