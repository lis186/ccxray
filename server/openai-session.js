'use strict';

// Thin re-export: canonical implementations live in wire-parsers/openai.js.
// This file exists for backward compatibility with ws-proxy.js and index.js.
const openai = require('./wire-parsers/openai');

module.exports = {
  getCodexRawSessionId: openai.getCodexRawSessionId,
  firstHeader: openai.firstHeader,
  parseCodexTurnMetadata: openai.parseCodexTurnMetadata,
  getCodexSessionId: openai.getCodexSessionId,
  getOpenAIAgentTypeFromHeaders: openai.getOpenAIAgentTypeFromHeaders,
  isOpenAISubagent: openai.isOpenAISubagent,
  // wire-parsers detectSession takes (_req, headers, parsedBody) but callers
  // of the original detectOpenAISession pass (headers, parsedBody) — 2 params.
  detectOpenAISession: (headers, parsedBody) => openai.detectOpenAISession(null, headers, parsedBody),
  withCodexMetadata: openai.withCodexMetadata,
};
