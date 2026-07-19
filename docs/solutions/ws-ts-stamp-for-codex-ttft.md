# WS `_ts` stamp for Codex TTFT (#204)

## Diagnosis

**Question**: Can we stamp `_ts: Date.now()` on recorded WS events without perturbing the relay?

**Answer: Yes — structural isolation proves it.**

### Evidence (code-level, no live traffic required)

`server/ws-proxy.js` upstream→client message handler (L537-568):

```
upstreamWs.on('message', (data, isBinary) => {
  // ...
  const parsed = JSON.parse(data.toString());     // L543: parse for recording
  // ...
  currentTurn.responseEvents.push(parsed);        // L554: record (parsed object)
  ctx.responseEvents.push(parsed);                // L560: record (parsed object)
  // ...
  safeSend(clientWs, data, isBinary);             // L568: relay (raw buffer)
});
```

- **Recording path**: uses `parsed` (JavaScript object) — enrichable
- **Relay path**: uses `data` (raw buffer from upstream) — never touches `parsed`
- **Conclusion**: adding `{ ...parsed, _ts: Date.now() }` at push sites cannot alter frames forwarded to client. The two paths are structurally independent.

### Relay latency

`Date.now()` itself is a syscall that takes <1μs and runs after `parsed` is
already constructed (JSON.parse already happened), so the stamp itself adds
nothing. But the *shape* of what gets pushed onto `responseEvents` matters:
`response.completed` triggers `finalizeTurn()` synchronously in the same
message handler, and `finalizeTurn` → `recordWebSocketEntry` (JSON
serialization + credential scan over the recorded event array) runs on that
relay path **before** `safeSend` forwards the frame (see the P1 finding
below) — so a large recorded object on that turn's `responseEvents` array
does sit in front of the relay, unlike the non-terminal events. The compact
`{ type, _ts }` marker (see "Revision" below) keeps that array small
regardless of envelope size, so this cost stays negligible in practice.

## Design

### Change (2 lines)

```js
// L554
if (!WS_SKIP_EVENTS.has(parsed.type)) currentTurn.responseEvents.push({ ...parsed, _ts: Date.now() });
// L560
if (!turnEmitted && !WS_SKIP_EVENTS.has(parsed.type)) ctx.responseEvents.push({ ...parsed, _ts: Date.now() });
```

### TTFT derivation (downstream consumer)

```
response.created._ts     → t0 (response accepted)
first output_text.delta._ts → first token (TTFT = Δt - t0)
response.completed._ts   → stream end (duration = completed - created)
```

Note: existing data shows `response.created` and `response.completed` are in `WS_SKIP_EVENTS` — verify and remove from skip set if needed. Current WS_SKIP_EVENTS definition at L41.

### Verification plan (for the implementation PR, not this diagnostic)

1. Before/after frame bytes: `ctx.byteCounts.upstreamToClient` unchanged (already tracked)
2. Test: existing `test/websocket-proxy.test.js` exercises the relay path — add assertion that recorded events have `_ts` while forwarded frames don't
3. No `critical-path` browser-harness relay test needed — the isolation is structural, not empirical

## Revision: codex P1 — keep anchors in WS_SKIP_EVENTS, record compact markers instead

The first implementation (#293) removed `response.created`/`response.completed`
from `WS_SKIP_EVENTS` outright so their `_ts` would get recorded — but that's
exactly why they were in the skip set to begin with: each is a ~35KB envelope
(full `instructions` + `tools`). Recording the full body on every turn
measured 1,626 → 142,976 bytes per `_res.json` (88× bloat for a 2-turn
session), and put that enlarged serialization + credential scan on the relay
path, since `recordWebSocketEntry` runs inside `finalizeTurn`, which fires
synchronously on `response.completed` **before** `safeSend` relays the frame.

Owner-approved fix: put both anchors back in `WS_SKIP_EVENTS` (full envelope
never recorded), but record a **compact `{ type, _ts }` marker** for exactly
these two events via a small helper, so downstream TTFT derivation still
works off the timestamps with no bloat and no added relay cost:

```js
const WS_TS_ANCHORS = new Set(['response.created', 'response.completed']);

function wsRecordValue(parsed) {
  if (!WS_SKIP_EVENTS.has(parsed.type)) return { ...parsed, _ts: Date.now() };
  if (WS_TS_ANCHORS.has(parsed.type)) return { type: parsed.type, _ts: Date.now() };
  return null;
}
```

Both push sites call `wsRecordValue(parsed)` and only push if it returns
non-null. `usage`/`model`/`lastResponseStatus` are still extracted from `r`
before this check runs, so no consumed data is lost — only the raw
`instructions`/`tools`/`response` envelope is dropped for these two event
types.

Measured after the fix (`test/fixtures/codex-ws-frames/say-hi.ndjson`):
recorded-events serialized size back down to ~1.8KB (vs. the ~143KB
full-envelope regression), with `response.created`/`response.completed`
still present as `{type,_ts}` markers.

## Revision: codex P2 — `response.done` terminal variant

Codex review round 2 flagged that `response.done` — a documented terminal-event
variant some Codex versions emit instead of `response.completed`
(`docs/wire-protocol-reference.md`, treated as completion in
`public/renderers/openai.js`) — was missing from `WS_TS_ANCHORS`, so those
sessions got no terminal `_ts`. Fix: add it as a third compact anchor.

```js
const WS_TS_ANCHORS = new Set(['response.created', 'response.completed', 'response.done']);
```

Note: `finalizeTurn()` still fires only on `response.completed`; a
`response.done`-terminal turn finalizes via the next `response.create` or the
socket-close path. The `_ts` marker is recorded at receive time regardless, so
duration is derivable; changing turn-splitting on `response.done` is a separate
concern, out of scope here.

## Scope (TTFT-only — owner-defined, explicit)

Captured: success-path timestamps only — `response.created` (t0) → first
`output_text.delta` → `response.completed`/`response.done` (end). Deliberately
**not** captured (accepted, TTFT needs none of it):

- **Failure/interrupt terminals** (`response.failed` / `response.incomplete`, or
  close-without-terminal): no `stop_ts` anchor; any such non-anchor terminal
  envelope that reaches the recorder is stored in full, not compacted. Future
  pure addition (extend `WS_TS_ANCHORS`).
- **Terminal `output_tokens`**: kept in `ctx.lastUsage` for cost, but dropped
  from the compact `{type,_ts}` markers, so a throughput consumer (#195) can't
  read per-event tokens from a marker. Future pure addition.

## Test barrier (round-2 review)

The `response.done` regression test drives finalization by an **event-driven
barrier** — it waits until the proxy relays the `response.done` frame (which
happens *after* `wsRecordValue()` records the marker, since `safeSend` is last),
then closes. It does **not** use a fixed `setTimeout` sleep: a fixed-sleep pass
is a load-dependent (possibly false) green and an unreliable old-fail/new-pass
anchor.

## Status

Implemented (#293), P1 + P2 fixed. `test/websocket-proxy.test.js` locks in the
`_ts` stamping, the compact-marker shape (incl. `response.done`), and the
relay-integrity contract as regression guards.
