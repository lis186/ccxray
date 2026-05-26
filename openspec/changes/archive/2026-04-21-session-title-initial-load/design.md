## Context

The dashboard client initialises in two steps: (1) connect SSE (`/_events`) for live updates, (2) fetch `/_api/entries` to rebuild `sessionsMap`. Session titles are stored server-side in `store.sessionMeta[sid].title`, populated either during live operation (`resolveTitleGenTitle` in `forward.js`) or on startup via `restore.js`. When the server flushes existing titles on SSE connect, the client receives `session_title_update` events before `sessionsMap` exists, so the handler's guard (`if (sess && data.title)`) drops them silently.

## Goals / Non-Goals

**Goals:**
- Deliver all known session titles to the client during initial page load with no race window
- Cover both restored (old log) and live (same server lifetime) titles
- Keep the existing SSE `session_title_update` path for subsequent live updates

**Non-Goals:**
- Changing how titles are generated or attributed
- Persisting titles across server restarts beyond what `restore.js` already does
- Invalidating or versioning titles for staleness detection (not needed: Claude Code title-gen runs once per session)

## Decisions

**D1: Deliver titles via entries API, not SSE flush**

Options considered:
- *SSE flush on connect + client pending map*: Requires new client-side state (pendingTitles Map), must hook into sessionsMap.set(), touches multiple code paths. Scored 5.5/10.
- *Reverse init order (entries before SSE)*: Eliminates race but introduces a ~200ms window where live updates are missed on page load. Scored 9.5/10.
- *Embed titles in `/api/entries` response* (**chosen**): Response changes from bare array to `{ entries, sessionTitles }`. Client applies titles after sessionsMap is built. Zero race window, no new state, no ordering dependency. Scored 10/10.

**D2: Apply titles after the entries loop, not inline**

Applying titles mid-loop would require sessionsMap to already contain the session being titled. By iterating `sessionTitles` in a second pass after the loop, all sessions are guaranteed to exist in the map.

**D3: Only re-render visible session elements**

`document.getElementById('sess-' + sid.slice(0, 8))` returns null for sessions not currently rendered (filtered out or in a different project column). Skipping null elements naturally limits DOM mutations to the visible set, avoiding layout thrash on large session lists.

## Risks / Trade-offs

- **Breaking response shape**: Any external consumer parsing `/_api/entries` as a bare array will break. Mitigation: this is an internal dashboard API with no documented external contract; the client is the only consumer.
- **titleReqTs not included in sessionTitles**: The initial-load path sets `sess.title` without `sess.titleReqTs`, so a subsequent SSE `session_title_update` with the same title will always win the `nextTs >= (sess.titleReqTs || 0)` comparison. This is correct behaviour — live beats restored.

## Open Questions

None.
