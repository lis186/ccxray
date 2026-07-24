'use strict';

function isOpenAIResponseObject(data) {
  return !!data && typeof data === 'object' && !Array.isArray(data)
    && (data.object === 'response' || data.id || data.model || data.status || data.usage || data.output);
}

function extractOpenAIResponse(data) {
  if (!data || typeof data !== 'object') return null;
  if (isOpenAIResponseObject(data.response)) return data.response;
  return isOpenAIResponseObject(data) ? data : null;
}

function getOpenAIResponseFromEvents(events) {
  if (!Array.isArray(events)) return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const response = extractOpenAIResponse(events[i]?.data);
    if (response) return response;
  }
  return null;
}

function getOpenAIOutputSummary(response) {
  const output = Array.isArray(response?.output) ? response.output : [];
  for (let i = output.length - 1; i >= 0; i--) {
    const content = output[i]?.content;
    if (!Array.isArray(content)) continue;
    const text = content.map(part => part?.text || '').filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    if (text) return text.slice(0, 80);
  }
  return null;
}

// Grok injects many role:user rows (user_info, system-reminder, user_query).
// Prefer <user_query>…</user_query>; skip reminder/info scaffolding so session
// titles are not "MCP servers connected…" (live QA 2026-07-09).
const OPENAI_USER_QUERY_RE = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/i;
const OPENAI_SKIP_USER_PREFIX_RE = /^\s*<(system-reminder|user_info|user-prompt-submit-hook|context|antml:function_calls)\b/i;

function flattenOpenAIContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => {
    if (typeof part === 'string') return part;
    return part?.text || part?.input_text || part?.output_text || '';
  }).filter(Boolean).join(' ');
}

function summarizeOpenAIUserText(raw) {
  if (!raw) return null;
  const query = raw.match(OPENAI_USER_QUERY_RE);
  if (query) {
    const body = query[1].replace(/\s+/g, ' ').trim();
    return body ? body.slice(0, 80) : null;
  }
  if (OPENAI_SKIP_USER_PREFIX_RE.test(raw)) return null;
  const text = raw.replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 80) : null;
}

function getOpenAIInputSummary(input) {
  if (typeof input === 'string') return summarizeOpenAIUserText(input);
  if (!Array.isArray(input)) return null;

  // Pass 1: prefer explicit <user_query> anywhere (Grok CLI)
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i] || {};
    if (item.role && item.role !== 'user') continue;
    const flat = flattenOpenAIContent(item.content);
    const query = flat.match(OPENAI_USER_QUERY_RE);
    if (query) {
      const body = query[1].replace(/\s+/g, ' ').trim();
      if (body) return body.slice(0, 80);
    }
  }

  // Pass 2: last non-scaffolding user message (Codex / plain chat)
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i] || {};
    if (item.role && item.role !== 'user') continue;
    const summary = summarizeOpenAIUserText(flattenOpenAIContent(item.content));
    if (summary) return summary;
  }
  return null;
}

// EXCEPTION(#158): shared utility — dispatches on explicit provider arg for response metadata shape
function buildResponseMetadata(provider, resData, proxyRes) {
  if (provider === 'openai') {
    const response = extractOpenAIResponse(resData);
    return {
      provider: 'openai',
      id: response ? response.id || null : null,
      object: response ? response.object || null : null,
      model: response ? response.model || null : null,
      status: proxyRes.statusCode,
      responseStatus: response ? response.status || null : null,
    };
  }
  return { provider: 'anthropic', status: proxyRes.statusCode };
}

module.exports = {
  isOpenAIResponseObject,
  extractOpenAIResponse,
  getOpenAIResponseFromEvents,
  getOpenAIOutputSummary,
  getOpenAIInputSummary,
  buildResponseMetadata,
};
