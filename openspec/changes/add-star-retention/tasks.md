## 1. Server foundations (helpers, settings, sentinels)

- [ ] 1.1 Add `SENTINEL_SESSIONS = new Set(['direct-api'])` and `SENTINEL_PROJECTS = new Set(['(unknown)', '(quota-check)'])` exports in `server/helpers.js`
- [ ] 1.2 Add `getProjectName(cwd)` in `server/helpers.js` — null/undefined → `'(unknown)'`, leading `(` passthrough, otherwise last non-empty path segment
- [ ] 1.3 Extend `DEFAULTS` in `server/settings.js` with `starredProjects: []`, `starredSessions: []`, `starredTurns: []`
- [ ] 1.4 Update `readSettings()` to coerce non-array values for the three star keys to `[]` and log a single warning when the file parses to a non-object

## 2. Server retention logic

- [ ] 2.1 Add `isProtectedByStar(meta, retainedSessions, retainedProjects, starredTurnIds)` helper in `server/helpers.js` (pure: takes pre-computed sets, returns boolean)
- [ ] 2.2 Add `computeRetentionSets(indexLines, stars)` helper — single pass over parsed index lines; returns `{retainedSessions, retainedProjects, starredTurnIds}` honoring sentinel exclusion (per design Decision 1 + 2)
- [ ] 2.3 Modify `pruneLogs()` in `server/restore.js` to read settings, call `computeRetentionSets()` over the index, and add all star-protected ids to `protectedIds` before the file-deletion loop
- [ ] 2.4 Modify `restoreFromLogs()` in `server/restore.js` so the `RESTORE_DAYS` cutoff filter is bypassed when `isProtectedByStar(meta, ...)` is true; reuse the same retention sets (compute once at startup)

## 3. Server REST API

- [ ] 3.1 Add `GET /_api/stars` handler in `server/routes/api.js` returning `{projects, sessions, turns}` from `readSettings()`
- [ ] 3.2 Add `POST /_api/stars` handler — parse JSON body, validate `kind ∈ {'project','session','turn'}` and boolean `starred`, mutate the matching array (set-add or set-remove), `writeSettings()`, respond with full new state
- [ ] 3.3 Reject malformed POST bodies with HTTP 400 (no settings change, no partial write)
- [ ] 3.4 Ensure handlers respect existing `auth.js` middleware path (no special-case bypass)

## 4. Server tests

- [ ] 4.1 Unit tests for `getProjectName(cwd)`: standard path, sentinel passthrough, null, empty string
- [ ] 4.2 Unit tests for `computeRetentionSets()`: direct turn star, derived session retention, derived project retention, sentinel exclusion (no upward derivation from `direct-api` or `(unknown)`)
- [ ] 4.3 Integration test for `pruneLogs()`: starred entry older than `LOG_RETENTION_DAYS` survives; sibling in same real session also survives; sibling in `direct-api` does not
- [ ] 4.4 Integration test for `restoreFromLogs()`: starred entry older than `RESTORE_DAYS` is restored; non-starred old entry is skipped
- [ ] 4.5 API tests: GET returns shape; POST validates kind and starred; POST is idempotent on repeat; bad JSON → 400

## 5. Frontend turn card (cost line + star toggle)

- [ ] 5.1 In `public/entry-rendering.js`, replace `costHtml` on line 1 with a `starHtml` element (filled `★` when `entry.id ∈ stars.turns`, hollow `☆` otherwise)
- [ ] 5.2 Insert a new cost line in the card render between `titleLine` and `ctxBarHtml`: only renders when `turnCost != null`; format `$N.NN` with `toFixed(2)`
- [ ] 5.3 Add CSS `.turn-cost-line` (dim color via `var(--dim)`, font-size 11px, right-aligned with card padding) and `.turn-star` (cursor pointer, click target ≥ 16px, `stopPropagation` semantics) in `public/style.css`
- [ ] 5.4 Add click handler that calls `event.stopPropagation()`, POSTs `/_api/stars` with kind `turn`, awaits response, then triggers a column re-render so derived badges on parent cards update

## 6. Frontend project / session columns (tri-state badge)

- [ ] 6.1 In `public/miller-columns.js`, replace the existing pin button rendering on session cards with a tri-state star badge: filled `★` when `sid ∈ stars.sessions`, hollow `☆N` when not but `N = count of starred turns under sid > 0`, dim hollow otherwise
- [ ] 6.2 Same tri-state on project cards: count = distinct starred sessions + distinct starred turns whose project name matches (excluding sentinel buckets)
- [ ] 6.3 Wire badge clicks to `POST /_api/stars` with the appropriate kind; on response, refresh local `stars` cache and re-render all three columns
- [ ] 6.4 Add tooltip on derived `☆N` badges: `"Retained because N starred descendants — click to star this directly."`
- [ ] 6.5 Detect sentinel session (`'direct-api'`) and sentinel project name (`'(unknown)'`, `'(quota-check)'`) and render the badge as visually disabled (opacity, `cursor:not-allowed`) with explanatory tooltip; ignore clicks

## 7. Frontend migration and cleanup

- [ ] 7.1 On dashboard load, fetch `GET /_api/stars`. If all three arrays are empty AND `localStorage.xray-pinned-projects`/`xray-pinned-sessions` exist, POST each id (kind = project/session) and `localStorage.removeItem` for both keys after all POSTs resolve
- [ ] 7.2 If server already has stars, just `localStorage.removeItem` the legacy keys without POSTing (treat legacy as stale)
- [ ] 7.3 Delete `expireSessionPins()` definition and all call sites in `public/miller-columns.js`
- [ ] 7.4 Remove `pinnedProjects` / `pinnedSessions` Set/Map and their `savePinnedX()` writers; replace with a single in-memory `stars` cache populated from `GET /_api/stars`
- [ ] 7.5 Update sort and filter logic that currently reads `pinnedProjects.has(...)` / `pinnedSessions.has(...)` to read from the new `stars` cache (preserves existing "starred sorts first, never hidden by filter" behavior)

## 8. Verification

- [ ] 8.1 Run `npm test` — all new tests pass; existing tests unaffected
- [ ] 8.2 Manual check: star a turn → its session and project show `☆¹`; unstar that turn → both badges disappear
- [ ] 8.3 Manual check: star a project, then unstar it while a session inside is starred → project transitions to `☆¹`, session keeps `★`
- [ ] 8.4 Manual check: try to click star on `direct-api` session card and `(unknown)` project card → no API call, tooltip explains
- [ ] 8.5 Manual check: temporarily set `LOG_RETENTION_DAYS=0`; restart proxy; confirm starred files survive and non-starred files are pruned (use a non-production logs dir)
- [ ] 8.6 Manual check: temporarily set `RESTORE_DAYS=0`; restart proxy; confirm starred old entries appear in dashboard while non-starred old entries do not
- [ ] 8.7 Manual check: legacy localStorage migration — open dashboard with stale `xray-pinned-projects` set in DevTools, reload, confirm POSTs occur and localStorage is cleared
