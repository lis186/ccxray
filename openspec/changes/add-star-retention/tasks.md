## 1. Server foundations (helpers, settings, sentinels)

- [x] 1.1 Add `SENTINEL_SESSIONS = new Set(['direct-api'])` and `SENTINEL_PROJECTS = new Set(['(unknown)', '(quota-check)'])` exports in `server/helpers.js`
- [x] 1.2 Add `getProjectName(cwd)` in `server/helpers.js` — null/undefined → `'(unknown)'`, leading `(` passthrough, otherwise last non-empty path segment
- [x] 1.3 Extend `DEFAULTS` in `server/settings.js` with `starredProjects: []`, `starredSessions: []`, `starredTurns: []`, `starredSteps: []`
- [x] 1.4 Update `readSettings()` to coerce non-array values for the four star keys to `[]` and log a single warning when the file parses to a non-object

## 2. Server retention logic

- [x] 2.1 Add `isProtectedByStar(meta, retainedSessions, retainedProjects, starredTurnIds)` helper in `server/helpers.js` (pure: takes pre-computed sets, returns boolean)
- [x] 2.2 Add `computeRetentionSets(indexLines, stars)` helper — single pass over parsed index lines; returns `{retainedSessions, retainedProjects, starredTurnIds}` honoring sentinel exclusion; extracts turn IDs from `starredSteps` entries by splitting on `::`
- [x] 2.3 Modify `pruneLogs()` in `server/restore.js` to read settings, call `computeRetentionSets()` over the index, and add all star-protected ids to `protectedIds` before the file-deletion loop
- [x] 2.4 Modify `restoreFromLogs()` in `server/restore.js` so the `RESTORE_DAYS` cutoff filter is bypassed when `isProtectedByStar(meta, ...)` is true; reuse the same retention sets (compute once at startup)

## 3. Server REST API

- [x] 3.1 Add `GET /_api/stars` handler in `server/routes/api.js` returning `{projects, sessions, turns, steps}` from `readSettings()`
- [x] 3.2 Add `POST /_api/stars` handler — parse JSON body, validate `kind ∈ {'project','session','turn','step'}` and boolean `starred`, mutate the matching array (set-add or set-remove), `writeSettings()`, respond with full new state
- [x] 3.3 Reject malformed POST bodies with HTTP 400 (no settings change, no partial write)
- [x] 3.4 Ensure handlers respect existing `auth.js` middleware path (no special-case bypass)

## 4. Server tests

- [x] 4.1 Unit tests for `getProjectName(cwd)`: standard path, sentinel passthrough, null, empty string
- [x] 4.2 Unit tests for `computeRetentionSets()`: direct turn star, derived session retention, derived project retention, sentinel exclusion (no upward derivation from `direct-api` or `(unknown)`); step star extracts parent turn id
- [x] 4.3 Integration test for `pruneLogs()`: starred entry older than `LOG_RETENTION_DAYS` survives; sibling in same real session also survives; sibling in `direct-api` does not
- [x] 4.4 Integration test for `restoreFromLogs()`: starred entry older than `RESTORE_DAYS` is restored; non-starred old entry is skipped
- [x] 4.5 API tests: GET returns shape including `steps`; POST validates kind and starred; POST is idempotent on repeat; bad JSON → 400

## 5. Frontend turn card (cost line + star toggle)

- [x] 5.1 In `public/entry-rendering.js`, replace `costHtml` on line 1 with a `starHtml` element (filled `★` when `entry.id ∈ stars.turns`, hollow `☆` otherwise)
- [x] 5.2 Insert a new cost line in the card render between `titleLine` and `ctxBarHtml`: only renders when `turnCost != null`; format `$N.NN` with `toFixed(2)`
- [x] 5.3 Add CSS `.turn-cost-line` (dim color via `var(--dim)`, font-size 11px, right-aligned with card padding) and `.turn-star` (cursor pointer, click target ≥ 16px, `stopPropagation` semantics) in `public/style.css`
- [x] 5.4 Add click handler that calls `event.stopPropagation()`, POSTs `/_api/stars` with kind `turn`, awaits response, then triggers a column re-render so derived badges on parent cards update

## 6. Frontend project / session columns (tri-state badge)

- [x] 6.1 In `public/miller-columns.js`, replace the existing pin button rendering on session cards with a tri-state star badge: filled `★` when `sid ∈ stars.sessions`, hollow `☆N` when not but `N = count of starred turns under sid > 0`, dim hollow otherwise
- [x] 6.2 Same tri-state on project cards: count = distinct starred sessions + distinct starred turns whose project name matches (excluding sentinel buckets)
- [x] 6.3 Wire badge clicks to `POST /_api/stars` with the appropriate kind; on response, refresh local `stars` cache and re-render all three columns
- [x] 6.4 Add tooltip on derived `☆N` badges: `"Retained because N starred descendants — click to star this directly."`
- [x] 6.5 Detect sentinel session (`'direct-api'`) and sentinel project name (`'(unknown)'`, `'(quota-check)'`) and render the badge as visually disabled (opacity, `cursor:not-allowed`) with explanatory tooltip; ignore clicks

## 7. Frontend migration and cleanup

- [x] 7.1 On dashboard load, fetch `GET /_api/stars`. If all arrays are empty AND `localStorage.xray-pinned-projects`/`xray-pinned-sessions` exist, POST each id (kind = project/session) and `localStorage.removeItem` for both keys after all POSTs resolve
- [x] 7.2 If server already has stars, just `localStorage.removeItem` the legacy keys without POSTing (treat legacy as stale)
- [x] 7.3 Delete `expireSessionPins()` definition and all call sites in `public/miller-columns.js`
- [x] 7.4 Remove `pinnedProjects` / `pinnedSessions` Set/Map and their `savePinnedX()` writers; replace with a single in-memory `stars` cache populated from `GET /_api/stars`
- [x] 7.5 Update sort and filter logic that currently reads `pinnedProjects.has(...)` / `pinnedSessions.has(...)` to read from the new `stars` cache (preserves existing "starred sorts first, never hidden by filter" behavior)

## 8. Verification

- [x] 8.1 Run `npm test` — all new tests pass; existing tests unaffected
- [x] 8.2 Manual check: star a turn → its session and project show `☆¹`; unstar that turn → both badges disappear
- [x] 8.3 Manual check: star a project, then unstar it while a session inside is starred → project transitions to `☆¹`, session keeps `★`
- [x] 8.4 Manual check: try to click star on `direct-api` session card and `(unknown)` project card → no API call, tooltip explains
- [x] 8.5 Manual check: temporarily set `LOG_RETENTION_DAYS=0`; restart proxy; confirm starred files survive and non-starred files are pruned (use a non-production logs dir)
- [x] 8.6 Manual check: temporarily set `RESTORE_DAYS=0`; restart proxy; confirm starred old entries appear in dashboard while non-starred old entries do not
- [x] 8.7 Manual check: legacy localStorage migration — open dashboard with stale `xray-pinned-projects` set in DevTools, reload, confirm POSTs occur and localStorage is cleared

## 9. Step stars

- [x] 9.1 Frontend: render `★`/`☆` toggle at the trailing edge of each timeline step row in `public/messages.js`; glyph reads from `window.xrayStars.steps`
- [x] 9.2 Step-star click handler calls `event.stopPropagation()`, flips glyph synchronously (optimistic), calls `toggleStar('step', stepId, newState)`; reverts on POST failure
- [x] 9.3 Step ID format: `<entryId>::<stepIdx>[:<sub>]` where sub is `'thinking'`, an integer tool-call index, or omitted
- [x] 9.4 `computeRetentionSets()` extracts `entryId` from each `starredSteps` entry (split on `::`, take first segment); treats extracted IDs as turn stars for upward retention
- [x] 9.5 Step-star POST has no sentinel guard — users may star steps inside `direct-api` or `(unknown)` turns
- [x] 9.6 Manual check: star a timeline step → its turn card shows `☆¹`; unstar → badge disappears

## 10. Deeplink navigation

- [x] 10.1 `targetFromDeepLinkParams(params)` parses URL params into a TargetRef (`{kind:'project'|'session'|'turn'|'step', ...}`); supports both canonical and legacy `?s=&msg=&t=` formats
- [x] 10.2 `writeTargetToUrlParams(target, params)` encodes a TargetRef into URL params for `syncUrlFromState`
- [x] 10.3 `navigateTarget(target, opts)` routes through all Miller columns: selectProject → selectSession → selectTurn → selectSection → selectStep; each level is a no-op if already selected
- [x] 10.4 `_applyStepTargetWhenReady(idx, stepIdx, sub, attempts, opts)` polls rAF frames (max 120) until timeline has rendered the target step row, then calls `selectStep` and scrolls
- [x] 10.5 `_runTargetNavigation` wraps navigation with a depth counter so intermediate column renders do not trigger `syncUrlFromState` race-updates to the address bar
- [x] 10.6 `syncUrlFromState` guards on `_loading` and `_targetNavigationUrlSyncDepth > 0`; writes current selection to URL via `replaceState`; clears step params when section switches away from timeline
- [x] 10.7 Keyboard shortcuts e/E/s/S/a/A/m/M jump to next/prev error / skill / subagent / mcp steps in timeline; navigation is position-aware (finds nearest candidate forward/backward from current step, not index 0); URL syncs on each jump
- [x] 10.8 `window._entriesLoading` flag set before initial `fetch('/_api/entries')` and cleared after; `renderProjectsCol()` shows a Loading… / Resolving link… placeholder while the flag is set and no projects exist
- [x] 10.9 Chunked `addEntry` processes entries in batches of 60 with `requestAnimationFrame` yields; shows "Restoring N entries · …" then "Restoring… K / N" progress text; single sort + `renderProjectsCol()` after all chunks complete
- [x] 10.10 Server starts HTTP listener before log restore: `listen()` resolves, then `runPostListenStartupTasks()` runs async; `store.restoreState` tracks phases (`restoring` / `ready` / `error`) and is exposed via `GET /_api/entries`
- [x] 10.11 `Cache-Control: no-store` added to all static asset responses (HTML, CSS, JS) so browsers never serve a stale dashboard build
