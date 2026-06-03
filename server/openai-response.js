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

function getOpenAIInputSummary(input) {
  if (typeof input === 'string') return input.replace(/\s+/g, ' ').trim().slice(0, 80) || null;
  if (!Array.isArray(input)) return null;
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i] || {};
    if (item.role && item.role !== 'user') continue;
    const content = item.content;
    if (typeof content === 'string') return content.replace(/\s+/g, ' ').trim().slice(0, 80) || null;
    if (!Array.isArray(content)) continue;
    const text = content.map(part => part?.text || '').filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    if (text) return text.slice(0, 80);
  }
  return null;
}

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
