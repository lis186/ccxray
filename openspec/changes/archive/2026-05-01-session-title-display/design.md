## Context

Claude Code emits a built-in "title generator" subagent call for every session: a small haiku-model request whose job is to summarise the user's first message into a 3-7 word title. ccxray already classifies these requests (`server/system-prompt.js:31` → `agentKey = 'title-generator'`) but never surfaces the output — the Sessions column instead shows the first 8 hex characters of the session id (`982b8528`). P0 investigation produced the ground truth this design depends on:

- Title-gen requests carry `messages[0].content[0].text === <parent's first user message, verbatim>`; they have no `metadata.user_id` and therefore no session id.
- Title-gen and main request hit the proxy within the same millisecond; the response returns in ~100 ms.
- The response is JSON-wrapped: `{"title": "Systematic problem-solving …"}`. The current `extractResponseTitle` helper returns the raw JSON string, so any existing persisted title for a title-gen entry is garbage.
- The ccxray `index.ndjson` already has a per-turn `title` column, written on every request (`server/sse-broadcast.js:20`, `server/forward.js:247-251`). `restore.js` reads only the index, never lazily loading `_res.json`.

Constraints:
- No new dependencies, no new storage backends.
- Must degrade gracefully: direct-api, quota-check, restored-from-old-logs sessions must keep working.
- Deep-link URLs (`?s=<shortSid>`) must remain stable; only the visible label changes.
- Hub mode (multi-project dashboard, `server/hub.js`) already fans out SSE broadcasts — no topology change.

## Goals / Non-Goals

**Goals:**
- Replace the visible short-hash label with the generated title on the Sessions column, breadcrumb, and intercept overlay.
- Extract the title correctly (JSON-aware) and never persist malformed output.
- Attribute titles to the correct parent session when multiple sessions start concurrently.
- Persist titles through restart using the existing `index.ndjson` column.
- Keep the short hash reachable (tooltip, copy button, URL param).

**Non-Goals:**
- Pin/lock UI to freeze a title against regeneration (deferred).
- URL slugging or title-based routing.
- Privacy redaction mode for screenshots.
- Backfilling titles for historical sessions whose `index.ndjson` entries stored the verbatim user text instead of a clean title — those stay on the short-hash fallback until a fresh title-gen call fires.

## Decisions

### 1. Dedicated `extractTitleGenPayload(events)` helper, not a change to `extractResponseTitle`

**Chosen**: Add a new helper in `server/helpers.js` with three layers of fallback — `JSON.parse` → regex `/"title"\s*:\s*"([^"]+)"/` → `null`. Call it from `forward.js` only when `agentKey === 'title-generator'`.

**Rejected**: Modify `extractResponseTitle` to detect JSON. Risk: the helper is also used for regular turns, and the side effects of detecting JSON everywhere are hard to bound (a user's literal assistant response containing `{"title":"…"}` should not be parsed).

**Rationale**: keeps existing behaviour for every other agent type; the new helper has a single, auditable responsibility.

### 2. Attribution by temporal + content match, not fingerprint map

**Chosen**: When a title-gen response finishes, look at the set of sessions whose first request fired in the last 1000 ms; keep only those whose first user-message text equals the title-gen request body; require exactly one survivor before writing `sess.title`. If zero or more than one, discard.

**Rejected**: Build a separate `firstUserMsg → sessionId` map when the main request arrives, then key into it from the title-gen handler. Adds a new state container, a new invalidation lifecycle, and a new failure mode (stale keys from long-idle sessions).

**Rationale**: `store.activeRequests` + `store.sessionMeta.lastSeenAt` already carry everything we need; the proxy receives main-request and title-gen on the same connection stream within the same millisecond, so temporal matching alone is reliable in practice and content-match is a no-cost sanity check. The "two survivors" branch is rare enough that discarding is cheaper than guessing.

### 3. Reuse the existing `index.ndjson` `title` column for persistence

**Chosen**: For `agentKey === 'title-generator'` entries, write the *extracted, clean* title — not the parent user message — into the existing `entry.title` field. On restart, `restore.js` scans the already-loaded entries and, for any whose stored agent bucket is title-generator, stamps the value onto the associated session.

**Rejected A**: Add a new `sessionTitle` column to `index.ndjson`. Breaks older readers; requires a migration.

**Rejected B**: Store titles in a separate `~/.ccxray/session-titles.json`. Introduces a second source of truth and an I/O path that needs its own cache/invalidation.

**Rationale**: the index already pays the write cost on every turn; the change repurposes an already-populated column whose per-turn-title value for title-gen entries is currently meaningless (it holds the verbatim user text).

### 4. `formatSessionLabel(sess, sid)` helper used from every display site

**Chosen**: A single exported helper (colocated with `entry-rendering.js` or a new `public/session-label.js`) returns `sess.title || shortSid || 'direct API'`. Called from the session card (`miller-columns.js:408`), breadcrumb (`miller-columns.js:922`), URL hydration (`miller-columns.js:966` keeps `shortSid` instead), intercept overlay (`intercept-ui.js:34,283,301,312`), and the pin-toggle re-render path (`miller-columns.js:156`).

**Rationale**: three call sites today diverge subtly — centralising guarantees consistency and makes the "fallback to short hash" contract auditable in one place.

### 5. Two-line clamp with native tooltip

**Chosen**: Add a `.sess-title` rule using WebKit line-clamp — `display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden;` — so titles wrap to at most two lines and anything longer is ellipsed. Breadcrumb and intercept overlay stay single-line (`white-space:nowrap; overflow:hidden; text-overflow:ellipsis;`) because their host rows are horizontally constrained. Every site sets `title="{{fullTitle}} · {{shortSid}}"` so hovering reveals the full text and the short id.

**Rejected**: Pure single-line ellipsis across every site. Two lines on the card recovers roughly 2× characters (easily 40-60 CJK or ~80 latin) without visibly disturbing the existing card height; for a dev dashboard this readability win is worth the extra ~18 px.

**Rejected**: Custom tooltip component. Over-engineered for a dev-facing dashboard.

### 6. Monotonic `titleReqTs` + 3 s broadcast debounce

**Chosen**: Store `{ title, titleReqTs }` on the session. Apply new title only when its request timestamp is strictly greater. Debounce outgoing SSE `session_title_update` events so multiple responses inside 3 s collapse to one.

**Rationale**: Claude Code may re-run title-gen on topic drift (rate unknown). Monotonic guard protects against out-of-order responses; debounce prevents flicker for dashboards if we ever see bursts.

### 7. New SSE event type vs piggyback on existing entry broadcast

**Chosen**: Emit a dedicated `session_title_update` event type `{ sessionId, title, titleReqTs }`. The existing entry broadcast keeps firing unchanged (the title-gen entry is a normal subagent entry).

**Rejected**: Re-broadcast the whole session card from the server. Larger payload, larger diff surface.

**Rationale**: dashboard clients already handle multiple SSE event types; a focused event has a trivial handler (look up `sessionsMap`, set `.title`, re-render that card only).

## Risks / Trade-offs

- **Title-gen request body differs from what P0 fixture showed in some Claude Code version** → `extractTitleGenPayload` returns null; session falls back to short hash. No regression beyond "feature silently absent".
- **Two sessions open with byte-identical first user messages ("hi", "繼續", "go") in the same 1 s window** → content match tie-breaker returns multiple survivors; attribution discarded for both. Mitigation: rare; when it happens the user sees the familiar hash and can still use the copy button. Acceptable.
- **Older `index.ndjson` entries hold verbatim user text under `title` for title-gen entries** → restore won't know the difference. Mitigation: on restore, detect title-gen entries whose stored `title` parses as JSON or exceeds a length heuristic (≥ 80 chars, contains newlines) and discard them; the next live title-gen call overwrites the column. Short-hash fallback covers the gap.
- **Hub mode broadcasts `session_title_update` to dashboards connected to other projects** → trivial bandwidth; clients filter by session id they know about.
- **Kill-switch for fast revert** → gate the entire feature behind `CCXRAY_DISABLE_TITLES=1`. When set, `extractTitleGenPayload` short-circuits to `null`, `formatSessionLabel` returns the short hash. One env var, one revert.
- **CJK / emoji titles in narrow cards** → CSS ellipsis handles Unicode correctly in every modern browser; tooltip reveals the rest.
- **Request arrives before main request's `sessionId` is populated in `store.currentSessionId`** → not observed in P0 (title-gen fires within the same millisecond as main request and main-request handler runs first in the event loop when both are enqueued). If it happens, the attribution step finds no inflight session, writes nothing, and the session stays on short-hash. No corruption.

## Migration Plan

1. Ship behind the `CCXRAY_DISABLE_TITLES` flag (default off — feature active). Rollback: users export the flag before restart.
2. Deploy server changes first (extractor, forward branching, sessions map field, restore pass, SSE event). Dashboards without the new handler simply ignore the new SSE event type — no broken UI.
3. Deploy dashboard changes. The helper falls back to short hash when `sess.title` is undefined, so old server + new dashboard is safe.
4. No data migration; the next title-gen call for every live session populates the new data naturally.

## Open Questions

- **Actual regeneration cadence**: do Claude Code sessions fire title-gen more than once? P0 did not observe it in a 30-minute session, but the debounce + pin UI is speculative until we see it in the wild. Keep debounce, defer pin until we have data.
- **Should `entry.title` for a title-gen entry also be visible when the user clicks into that entry?** Current behaviour (shows the raw user message) is noisy but not wrong; out of scope for this change.
- **Hub fan-out efficiency** if many projects + many sessions churn titles simultaneously. Monitor in production; optimise only if observed.
