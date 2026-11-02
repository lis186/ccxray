'use strict';

// Shared policy for session ids read from external or persisted data: a
// reserved name is treated as "no session id". Dependency-free so store,
// session-index, restore and the wire parsers can all require it.
const RESERVED_SESSION_IDS = new Set(['__proto__', 'constructor', 'prototype']);

function isReservedSessionId(id) {
  return typeof id === 'string' && RESERVED_SESSION_IDS.has(id.trim());
}

function sanitizeSessionId(id) {
  return isReservedSessionId(id) ? null : id;
}

module.exports = { RESERVED_SESSION_IDS, isReservedSessionId, sanitizeSessionId };
