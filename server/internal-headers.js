'use strict';

// The `x-ccxray-*` request-header namespace, and the rule for what may leave
// this process.
//
// DEFAULT-DENY BY PREFIX, not by allowlist. The allowlist version of this rule
// shipped `x-ccxray-agent-id` (the Herdr pane-identity header) straight through
// to Anthropic: the header was added in one place and the two strip lists —
// duplicated in `index.js` and `ws-proxy.js` — were never updated, and the one
// e2e strip test asserted only `x-ccxray-auth`, so nothing went red. A prefix
// rule cannot be forgotten by a future header, and it is testable as a single
// structural assertion ("no forwarded header starts with x-ccxray-").
//
// Members today, for readers (the rule does not enumerate them):
//   x-ccxray-auth        hop-by-hop credential (base64url K_upstream)
//   x-ccxray-bootstrap   one-time bootstrap token
//   x-ccxray-agent-id    Herdr pane identity — client metadata, never upstream
const CCXRAY_HEADER_PREFIX = 'x-ccxray-';

// Headers that are DELIBERATELY forwarded despite the prefix. Empty by design:
// an exception must be written here and justified, rather than the whole
// namespace defaulting to forwardable.
//
// The intended first member is ADR 0012 Layer B's `x-ccxray-relay`, which is
// meant to be read by the *next* ccxray hop. Note that reading an inbound
// relay header never needed this exception — stripping happens while building
// the OUTBOUND header set, so an inbound value is fully readable by this hop.
// What the exception buys is the ability to pass one onward; when it is added,
// the injection must run after the strip in the forward path.
const FORWARD_ALLOWED = new Set();

function isInternalHeader(name) {
  const lower = String(name).toLowerCase();
  return lower.startsWith(CCXRAY_HEADER_PREFIX) && !FORWARD_ALLOWED.has(lower);
}

module.exports = { CCXRAY_HEADER_PREFIX, FORWARD_ALLOWED, isInternalHeader };
