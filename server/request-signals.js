'use strict';

function isJwtShaped(authHeader) {
  if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) return false;
  const parts = authHeader.slice(7).split('.');
  return parts.length === 3 && parts[0].length > 10;
}

function hasOpenAIHeaders(headers = {}) {
  return Object.keys(headers).some(name => {
    const key = name.toLowerCase();
    return key === 'chatgpt-account-id'
      || /^(openai-|x-openai-|x-codex-)/.test(key)
      || (key === 'originator' && /^codex/i.test(String(headers[name])))
      || (key === 'authorization' && isJwtShaped(headers[name]));
  });
}

module.exports = { isJwtShaped, hasOpenAIHeaders };
