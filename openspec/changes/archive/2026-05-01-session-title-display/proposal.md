## Why

Session cards in the Miller column currently show an 8-character session hash (e.g. `982b8528`) as their primary identifier. Hashes are not scannable — users cannot tell sessions apart at a glance, and the value adds nothing beyond what the copy button already provides. Claude Code already generates a human-readable title for every session (via its built-in title-generator subagent), but ccxray captures it incorrectly and never surfaces it to the dashboard. Turning that existing signal into the session's visible label makes the Sessions column scannable without changing storage cost or adding dependencies.

## What Changes

- **Session cards display the generated title as their primary label**, with the short hash kept as a tooltip and still accessible via the copy button. When no title has arrived yet (or for non-Claude-Code sources), fall back to the short hash exactly as today.
- **Fix the title-generator JSON extraction bug.** Title-gen responses are `{"title":"..."}` JSON, but the existing `extractResponseTitle` helper returns the raw JSON string. Add a dedicated extractor that JSON-parses, falls back to regex, and returns `null` on malformed output rather than writing garbage.
- **Attribute title-gen calls to their parent session.** Title-gen requests have no `metadata.user_id`, but they fire in the same millisecond as the main request and contain the user's first message verbatim. Match on temporal proximity (inflight session started within 1s) confirmed by content equality.
- **Persist session titles through restart.** The existing `index.ndjson` already carries a per-turn `title` field. Repurpose it for title-gen entries so that `restore.js` rebuilds `sess.title` on startup at zero extra I/O cost.
- **Apply the new label consistently across the UI** — session card, breadcrumb, intercept overlay — via a single `formatSessionLabel(sess, sid)` helper. Deep-link URLs (`?s=`) keep using the short hash so existing shared links stay valid. **BREAKING**: none — short hash remains canonical in URLs and logs.
- **Defer**: pin/lock title UI (for sessions that regenerate titles on topic drift) and title redaction mode are out of scope.

## Capabilities

### New Capabilities

- `session-title-attribution`: Detecting Claude Code title-generator calls, extracting the generated title, attributing it to the correct parent session, broadcasting updates to dashboard clients, and rebuilding titles on server restart.

### Modified Capabilities

None. Dashboard rendering of the Sessions column is UI-only; no existing spec covers its label contents.

## Impact

- **Server**
  - `server/helpers.js`: new `extractTitleGenPayload(events)` helper; `extractResponseTitle` remains for non-title-gen entries.
  - `server/forward.js` (~L246-252 and ~L358-364): branch on `agentKey === 'title-generator'` to use the new extractor and write the result to the entry's title field + session's title.
  - `server/store.js`: sessions map gains `title` and `titleReqTs` fields; add a helper to set them with monotonic-timestamp guard.
  - `server/restore.js`: after building the entries list, pass over title-gen entries to populate `sess.title`.
  - `server/sse-broadcast.js`: new event type (or reuse of existing entry broadcast) carries the session's current title so dashboards update live.
- **Client**
  - `public/entry-rendering.js`: `sessionsMap` entries gain `title`; swap on receipt of title update.
  - `public/miller-columns.js` (L156, L408, L922, L966): session card, breadcrumb, and URL-writing code route through `formatSessionLabel`.
  - `public/intercept-ui.js` (L34, L283, L301, L312): same helper for overlay header.
  - `public/style.css`: ellipsis + `title=` tooltip styles on the session-title element.
- **Data**
  - `~/.ccxray/logs/index.ndjson` gains meaningful values in its existing `title` column for title-gen entries. No schema change; older entries with verbatim user text stay readable (will just display as fallback text until repopulated by fresh sessions).
- **Out of scope**: pin/lock title mechanism, slug-based URL sharing, privacy redaction mode, hub-mode title broadcast fan-out optimization.
