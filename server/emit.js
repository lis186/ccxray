'use strict';

// Internal event bus for OTel handlers, parser sentinels, and future status hooks.
//
// Phase D (OTel SDK init) registers subscribers; Phase E wires emit() calls in
// forward.js / store.js. With no subscribers, emit() is an O(1) no-op — tier 0
// pays zero cost.
//
// Handlers run synchronously and MUST NOT throw into the proxy code path; this
// module wraps every dispatch in try/catch so a buggy subscriber cannot break
// request forwarding.
//
// Defined events (payload shape stable across Phase 1):
//   entry_completed   { entry }
//   session_started   { sessionId, provider, inferred }
//   parser_unknown    { provider, kind, token }
//   parser_mismatch   { type, expected, got, entryId? }
//   parser_error      { parser, errorType, message }

const subscribers = new Map();

function on(event, handler) {
  if (typeof handler !== 'function') throw new TypeError('handler must be a function');
  if (!subscribers.has(event)) subscribers.set(event, new Set());
  subscribers.get(event).add(handler);
  return () => subscribers.get(event)?.delete(handler);
}

function emit(event, payload) {
  const set = subscribers.get(event);
  if (!set || set.size === 0) return;
  for (const handler of set) {
    try { handler(payload); }
    catch (err) {
      try { console.error(`[emit] handler "${event}":`, err && err.message); } catch {}
    }
  }
}

module.exports = { on, emit };
