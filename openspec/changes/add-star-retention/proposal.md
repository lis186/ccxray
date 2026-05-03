## Why

Log files in `~/.ccxray/logs/` auto-prune after `LOG_RETENTION_DAYS` (default 14). There is no way for a user to mark a project / session / turn as "keep this forever, regardless of age." The existing `pinned-projects` / `pinned-sessions` state in `localStorage` is browser-only — the server has no idea what is pinned, so it cannot honor the intent during prune. Long-running investigations, archival of unusual incidents, and forensic review all break the moment retention kicks in.

This change introduces server-side **stars** at three levels of granularity (project / session / turn) that protect logs from auto-prune. Stars are stored per-level; retention is a **derived query** over the union of starred sets — so the user sees one knob ("star this thing"), the system applies one rule ("retain anything starred or containing a starred descendant"), and there is no cascading write to undo.

## What Changes

- New `~/.ccxray/settings.json` fields: `starredProjects: string[]`, `starredSessions: string[]`, `starredTurns: string[]`.
- New REST endpoints: `GET /_api/stars`, `POST /_api/stars` (single-level toggle, no cascade write).
- `pruneLogs()` (`server/restore.js`) protects any entry whose project / session / turn — or any descendant — is starred. Sentinel session/project (`direct-api`, `(unknown)`, `(quota-check)`) are excluded from upward derivation so a single starred turn inside a sentinel does not pin the whole bucket.
- `restoreFromLogs()` lifts the `RESTORE_DAYS` cutoff for star-protected entries, so old starred items remain visible after restart.
- Turn card replaces the top-right `$cost` with a star toggle; cost moves to a new line between title and context bar (dim, 11px, right-aligned).
- Project / session columns gain a tri-state star indicator: filled `★` (directly starred), hollow `☆³` with descendant count (derived retention), or no badge (unprotected).
- Sentinel session/project disable the star button at their own level (turn-level star inside still works); tooltip explains why.
- **BREAKING (frontend-only)**: existing `localStorage` `xray-pinned-projects` / `xray-pinned-sessions` are migrated once on first dashboard load (POSTed to server, then cleared). The browser-side `expireSessionPins()` 7-day expiry is removed — stars do not expire.

## Capabilities

### New Capabilities

- `star-retention`: server-side storage, REST API (with sentinel rejection), derived retention rule for prune and restore, and sentinel-bucket exclusion at retention computation.
- `star-ui`: dashboard tri-state star control on project / session columns, turn-card star toggle, sentinel disabled state, optimistic UI with revert-on-failure, one-time migration from `localStorage`.
- `star-popover`: click on a parent's derived `☆ [N]` badge opens a floating list of starred descendants; each row's ★ toggles in place, the row body navigates to the descendant (re-selecting its project on the way), explicit `[×]` button dismisses, viewport edges clamp the popover.

### Modified Capabilities

- `turn-card-v2`: line-1 right-edge cost is replaced by the star toggle; a new cost line is inserted between line 2 (title) and line 3 (ctx-bar).

## Impact

- `server/settings.js` — DEFAULTS gain three array fields.
- `server/routes/api.js` — new `/_api/stars` GET/POST routes.
- `server/restore.js` — `pruneLogs()` protection set computed from settings + index scan; `restoreFromLogs()` cutoff exception.
- `server/helpers.js` — new shared `getProjectName(cwd)` and `isProtectedByStar(meta, stars)` helpers; new `SENTINEL_SESSIONS` / `SENTINEL_PROJECTS` constants.
- `public/entry-rendering.js` — turn card identity-line cost → star, new cost line, click handler with `stopPropagation`.
- `public/miller-columns.js` — pin → star throughout, tri-state indicator, sentinel disabled state, migration shim, `expireSessionPins()` removed.
- `public/style.css` — `.turn-cost-line`, `.turn-star`, `.cascade-badge` styles.
- No new dependencies. No data migration on disk; settings file gains fields with safe defaults.
