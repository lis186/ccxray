'use strict';

// OTel export health state machine. Phase 2b: state shell only.
// Bounded export queue (3.2), circuit breaker (3.3), log rotation (3.4),
// and shutdown cap (3.5) land in later sub-phases of the OpenSpec change.
//
// States:
//   disabled      — OTel never initialized (tier 0 or packages missing-and-tolerated)
//   active        — SDK initialized, exports presumed working
//   degraded      — SDK init failed or runtime non-recoverable; proxy continues
//   circuit_open  — runtime export failures tripped the breaker; periodic half-open retry
//
// Only documented APIs may mutate state. Invalid transitions throw so bugs
// surface in tests rather than silently corrupt observability.

const STATES = Object.freeze(['disabled', 'active', 'degraded', 'circuit_open']);

const VALID_TRANSITIONS = Object.freeze({
  disabled: new Set(['active', 'degraded']),
  active: new Set(['degraded', 'circuit_open', 'disabled']),
  degraded: new Set(['active', 'circuit_open', 'disabled']),
  circuit_open: new Set(['active', 'degraded', 'disabled']),
});

let currentState = 'disabled';
let lastTransitionAt = Date.now();
let lastReason = null;

function getState() {
  return currentState;
}

function getStatus() {
  return {
    state: currentState,
    lastTransitionAt,
    reason: lastReason,
  };
}

function transition(to, { reason } = {}) {
  if (!STATES.includes(to)) throw new Error(`otel-health: unknown state "${to}"`);
  if (currentState === to) return false;
  const allowed = VALID_TRANSITIONS[currentState];
  if (!allowed.has(to)) {
    throw new Error(`otel-health: invalid transition ${currentState} → ${to}`);
  }
  currentState = to;
  lastTransitionAt = Date.now();
  lastReason = (to === 'degraded' || to === 'circuit_open') ? (reason || null) : null;
  return true;
}

function _resetForTests() {
  currentState = 'disabled';
  lastTransitionAt = Date.now();
  lastReason = null;
}

module.exports = { STATES, getState, getStatus, transition, _resetForTests };
