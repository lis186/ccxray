'use strict';

const store = require('./store');

function getCodexRawSessionId() {
  return 'codex-raw';
}

function firstHeader(headers, name) {
  const value = headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function parseCodexTurnMetadata(headers) {
  const raw = firstHeader(headers, 'x-codex-turn-metadata');
  if (!raw) return null;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function getCodexSessionId(headers, parsedBody) {
  const direct = firstHeader(headers, 'session_id') || firstHeader(headers, 'x-openai-session-id');
  if (direct) return String(direct);
  const turnMetadata = parseCodexTurnMetadata(headers);
  if (typeof turnMetadata?.session_id === 'string') return turnMetadata.session_id;
  return parsedBody?.metadata?.session_id || null;
}

function getOpenAIAgentTypeFromHeaders(headers) {
  const subagent = firstHeader(headers, 'x-openai-subagent');
  const direct = firstHeader(headers, 'x-openai-agent-type') || firstHeader(headers, 'x-codex-agent-type');
  const turnMetadata = parseCodexTurnMetadata(headers);
  const value = direct || turnMetadata?.agent_type || subagent;
  if (!value) return null;
  const normalized = String(value).toLowerCase();
  if (normalized === 'explorer' || normalized === 'worker' || normalized === 'default') return normalized;
  return null;
}

function isOpenAISubagent(headers, parsedBody) {
  const raw = firstHeader(headers, 'x-openai-subagent');
  if (raw != null) {
    const text = String(raw).toLowerCase();
    return text !== '0' && text !== 'false' && text !== 'no';
  }
  return Boolean(parsedBody?.metadata?.is_subagent || parsedBody?.metadata?.isSubagent);
}

// Used by both HTTP (parsedBody present) and WebSocket upgrade (no body) paths.
// When parsedBody is null but headers carry session_id, we synthesize a minimal
// body so store.detectSession honors header-derived sessions consistently —
// otherwise WS upgrades and body-less HTTP retries would collapse into the
// `codex-raw` bucket.
function detectOpenAISession(headers, parsedBody) {
  const sessionId = getCodexSessionId(headers, parsedBody);
  if (!sessionId) {
    return { sessionId: getCodexRawSessionId(), isNewSession: false, inferred: true };
  }
  const bodyForDetection = parsedBody || { metadata: { session_id: sessionId } };
  const detected = store.detectSession(bodyForDetection);
  return {
    sessionId: detected.sessionId || sessionId || getCodexRawSessionId(),
    isNewSession: detected.isNewSession || false,
    inferred: detected.inferred || false,
  };
}

function withCodexMetadata(parsedBody, headers) {
  if (!parsedBody || typeof parsedBody !== 'object') return parsedBody;
  const sessionId = getCodexSessionId(headers, parsedBody);
  const agentType = getOpenAIAgentTypeFromHeaders(headers);
  if (!sessionId && !agentType) return parsedBody;
  const metadata = parsedBody.metadata && typeof parsedBody.metadata === 'object'
    ? { ...parsedBody.metadata }
    : {};
  if (sessionId && !metadata.session_id) metadata.session_id = sessionId;
  if (agentType && !metadata.agent_type) metadata.agent_type = agentType;
  return { ...parsedBody, metadata };
}

module.exports = {
  getCodexRawSessionId,
  firstHeader,
  parseCodexTurnMetadata,
  getCodexSessionId,
  getOpenAIAgentTypeFromHeaders,
  isOpenAISubagent,
  detectOpenAISession,
  withCodexMetadata,
};
