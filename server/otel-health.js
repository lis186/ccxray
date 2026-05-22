'use strict';

// OTel export health state machine.
//
// States:
//   disabled      — OTel never initialized (tier 0 or packages missing-and-tolerated)
//   active        — SDK initialized, exports working
//   degraded      — SDK init failed or non-recoverable runtime error; proxy continues
//   circuit_open  — 5 consecutive export failures; exports paused, cooldown timer running
//   half_open     — cooldown elapsed; single trial export in flight
//
// Only documented APIs may mutate state. Invalid transitions throw.

const STATES = Object.freeze(['disabled', 'active', 'degraded', 'circuit_open', 'half_open']);

const VALID_TRANSITIONS = Object.freeze({
  disabled:     new Set(['active', 'degraded']),
  active:       new Set(['degraded', 'circuit_open', 'disabled']),
  degraded:     new Set(['active', 'circuit_open', 'disabled']),
  circuit_open: new Set(['half_open', 'degraded', 'disabled']),
  half_open:    new Set(['active', 'circuit_open', 'disabled']),
});

const CIRCUIT_TRIP_THRESHOLD = 5;
const COOLDOWN_INITIAL_MS = 60_000;
const COOLDOWN_MAX_MS = 600_000;
const DEFAULT_QUEUE_SIZE = 2048;

let currentState = 'disabled';
let lastTransitionAt = Date.now();
let lastReason = null;

// Bounded queue: holds raw metric payloads while circuit is open.
let queue = [];
let queueMaxSize = DEFAULT_QUEUE_SIZE;

// Circuit breaker counters.
let consecutiveFailures = 0;
let cooldownMs = COOLDOWN_INITIAL_MS;
let cooldownUntil = null;
let cooldownTimer = null;

// Injected by otel.js after SDK init.
let dropsCounter = null;        // OTel counter: { add(n, attrs) }
let onCircuitCloseCallback = null;

// ─── State machine ────────────────────────────────────────────────────────────

function getState() { return currentState; }

function getStatus() {
  return {
    state: currentState,
    lastTransitionAt,
    reason: lastReason,
    queueDepth: queue.length,
    consecutiveFailures,
    cooldownMs,
    cooldownUntil,
  };
}

function transition(to, { reason } = {}) {
  if (!STATES.includes(to)) throw new Error(`otel-health: unknown state "${to}"`);
  if (currentState === to) return false;
  const allowed = VALID_TRANSITIONS[currentState];
  if (!allowed.has(to)) {
    throw new Error(`otel-health: invalid transition ${currentState} → ${to}`);
  }
  const from = currentState;
  currentState = to;
  lastTransitionAt = Date.now();
  lastReason = (to === 'degraded' || to === 'circuit_open') ? (reason || null) : null;
  if (to === 'active' && (from === 'circuit_open' || from === 'half_open')) {
    _onCircuitClose();
  }
  return true;
}

// ─── Bounded queue ────────────────────────────────────────────────────────────

// Enqueue a metric payload. When full, drop the oldest and count the drop.
function enqueue(signal, payload) {
  if (queue.length >= queueMaxSize) {
    queue.shift();
    if (dropsCounter) {
      try { dropsCounter.add(1, { signal }); } catch {}
    }
  }
  queue.push({ signal, payload });
}

// Return and clear the queue. Called by onCircuitClose to replay buffered data.
function drainQueue() {
  const items = queue;
  queue = [];
  return items;
}

// ─── Circuit breaker ──────────────────────────────────────────────────────────

function recordSuccess() {
  consecutiveFailures = 0;
  cooldownMs = COOLDOWN_INITIAL_MS;
  cooldownUntil = null;
  if (cooldownTimer) { clearTimeout(cooldownTimer); cooldownTimer = null; }
  if (currentState === 'half_open') {
    transition('active');
  }
}

// Called by HealthAwareExporter in otel.js after each failed OTLP export.
function recordFailure(reason) {
  consecutiveFailures++;
  if (currentState === 'half_open') {
    // Half-open trial failed: double cooldown (capped) and re-trip.
    cooldownMs = Math.min(cooldownMs * 2, COOLDOWN_MAX_MS);
    _tripCircuit(reason || 'half-open trial failed');
  } else if (consecutiveFailures >= CIRCUIT_TRIP_THRESHOLD && currentState !== 'circuit_open') {
    _tripCircuit(reason || `${consecutiveFailures} consecutive failures`);
  }
}

function _tripCircuit(reason) {
  if (cooldownTimer) { clearTimeout(cooldownTimer); cooldownTimer = null; }
  if (currentState !== 'circuit_open') {
    transition('circuit_open', { reason });
  }
  cooldownUntil = Date.now() + cooldownMs;
  cooldownTimer = setTimeout(_openHalfOpen, cooldownMs);
  if (cooldownTimer.unref) cooldownTimer.unref(); // don't block process exit
}

function _openHalfOpen() {
  cooldownTimer = null;
  cooldownUntil = null;
  if (currentState === 'circuit_open') transition('half_open');
}

// ─── Injection points ─────────────────────────────────────────────────────────

// Called by otel.js once the drops counter is registered with the SDK.
function setDropsCounter(counter) { dropsCounter = counter; }

// Called by otel.js to drain buffered payloads when the circuit closes.
function onCircuitClose(fn) { onCircuitCloseCallback = fn; }

function _onCircuitClose() {
  if (typeof onCircuitCloseCallback === 'function') {
    try { onCircuitCloseCallback(drainQueue()); } catch {}
  }
}

// ─── Test helpers ─────────────────────────────────────────────────────────────

function _resetForTests() {
  if (cooldownTimer) { clearTimeout(cooldownTimer); cooldownTimer = null; }
  currentState = 'disabled';
  lastTransitionAt = Date.now();
  lastReason = null;
  queue = [];
  queueMaxSize = DEFAULT_QUEUE_SIZE;
  consecutiveFailures = 0;
  cooldownMs = COOLDOWN_INITIAL_MS;
  cooldownUntil = null;
  dropsCounter = null;
  onCircuitCloseCallback = null;
}

module.exports = {
  STATES,
  getState,
  getStatus,
  transition,
  enqueue,
  drainQueue,
  recordSuccess,
  recordFailure,
  setDropsCounter,
  onCircuitClose,
  _resetForTests,
};
