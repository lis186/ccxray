'use strict';

// Work attribution: which task, pipeline role, and project a proxied request
// belongs to. An orchestrator (Agentflow is the first) launches many short-lived
// workers and needs their cost grouped by the unit of work, not by session.
//
// TWO CARRIERS, because the three supported CLIs do not share one:
//
//   1. URL path prefix   /_ccxray/attr/<task=..&role=..&project=..>/v1/...
//      Every CLI accepts a base URL (ANTHROPIC_BASE_URL, codex
//      openai_base_url/chatgpt_base_url, GROK_CLI_CHAT_PROXY_BASE_URL), so this
//      is the only carrier that works for all of them. It is stateless: no hub
//      registration, no pid lifecycle, no wrapper process around the worker.
//
//   2. Request headers   x-ccxray-task / x-ccxray-role / x-ccxray-project
//      Only Claude Code can send these (ANTHROPIC_CUSTOM_HEADERS). Codex on a
//      ChatGPT login and the Grok CLI cannot inject custom headers at all —
//      see the ChatGPT-OAuth carve-out in server/auth.js. Headers stay
//      supported for integrators that already own the HTTP client.
//
// The path prefix wins per key: it is set by the launcher closest to the
// worker, while header env vars are inherited down a process tree and can be
// stale by the time a nested worker sends a request.
//
// Values are client-supplied and land in a persisted index field, so they are
// bounded and stripped of control characters here, once, for both carriers.

const ATTRIBUTION_ROUTE_PREFIX = '/_ccxray/attr/';
const MAX_ATTRIBUTION_LENGTH = 128;

// Wire name → entry field. `project` is stored as `taskProject` because ccxray
// already uses "project" for the cwd-derived grouping on the dashboard; this
// one is a label the orchestrator declares and the two may legitimately differ
// (an Agentflow worker runs in a disposable clone, not the project directory).
const ATTRIBUTION_FIELDS = Object.freeze([
  Object.freeze({ wire: 'task', field: 'task', header: 'x-ccxray-task' }),
  Object.freeze({ wire: 'role', field: 'role', header: 'x-ccxray-role' }),
  Object.freeze({ wire: 'project', field: 'taskProject', header: 'x-ccxray-project' }),
]);

function sanitizeAttributionValue(raw) {
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const value = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!value || value.length > MAX_ATTRIBUTION_LENGTH) return null;
  return value;
}

// One path segment holding a URL-encoded query string. A malformed escape
// yields no attribution rather than a rejected request: attribution is
// metadata and must never be the reason a worker's API call fails.
function parseAttributionSegment(segment) {
  let decoded;
  try {
    decoded = decodeURIComponent(String(segment || ''));
  } catch {
    return {};
  }
  const params = new URLSearchParams(decoded);
  const out = {};
  for (const { wire, field } of ATTRIBUTION_FIELDS) {
    const value = sanitizeAttributionValue(params.get(wire));
    if (value) out[field] = value;
  }
  return out;
}

// Inverse of parseAttributionSegment, exported so launchers and tests build the
// prefix the same way the router reads it. Returns '' when nothing is set.
function buildAttributionPrefix(attribution = {}) {
  const params = new URLSearchParams();
  for (const { wire, field } of ATTRIBUTION_FIELDS) {
    const value = sanitizeAttributionValue(attribution[wire] ?? attribution[field]);
    if (value) params.set(wire, value);
  }
  const query = params.toString();
  return query ? `${ATTRIBUTION_ROUTE_PREFIX}${encodeURIComponent(query)}` : '';
}

// Node joins duplicate request headers with ', ', and ccxray's own launcher
// comma-joins ANTHROPIC_CUSTOM_HEADERS, so a value can arrive as
// 'A-012, X-Ccxray-Auth: …'. The attribution value is the first segment.
function headerAttributionValue(raw) {
  if (raw === undefined || raw === null) return null;
  const first = String(Array.isArray(raw) ? raw[0] : raw).split(',')[0];
  return sanitizeAttributionValue(first);
}

function requestAttribution(req) {
  const out = {};
  const headers = (req && req.headers) || {};
  for (const { field, header } of ATTRIBUTION_FIELDS) {
    const value = headerAttributionValue(headers[header]);
    if (value) out[field] = value;
  }
  const routed = req && req.ccxrayAttribution;
  if (routed && typeof routed === 'object') {
    for (const { field } of ATTRIBUTION_FIELDS) {
      if (routed[field]) out[field] = routed[field];
    }
  }
  return out;
}

module.exports = {
  ATTRIBUTION_FIELDS,
  ATTRIBUTION_ROUTE_PREFIX,
  MAX_ATTRIBUTION_LENGTH,
  buildAttributionPrefix,
  parseAttributionSegment,
  requestAttribution,
  sanitizeAttributionValue,
};
