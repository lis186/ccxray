## 1. Continue chip (#1)

- [x] 1.1 In `public/miller-columns.js` `renderSessionItem`, replace the `shortSid` span with a `<button class="continue-chip">▶ continue: {shortSid}</button>`. The button gets `onclick="event.stopPropagation();copySessionContinue('{shortSid}')"`.
- [x] 1.2 Add `copySessionContinue(shortSid)` to `public/miller-columns.js`: writes `claude --continue ${shortSid}` to `navigator.clipboard`, then finds the chip by id and swaps its text to `✓ copied!`, reverting after 1500 ms.
- [x] 1.3 In `public/style.css`, add `.continue-chip` rule: `background: none; border: none; color: var(--dim); font-size: 10px; font-family: inherit; cursor: pointer; padding: 0; text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%;`. Add `.continue-chip:hover { color: var(--accent); }`.

## 2. Cache TTL label and colour (#2)

- [x] 2.1 In `public/miller-columns.js` `renderSessionItem`, locate the `cacheRowHtml` block (around line 459). Change the displayed text from the raw countdown to `cache · {N}m left` (or `{N}s left` if < 60 s).
- [x] 2.2 Compute `ttlPct = remainingMs / planTtlMs` where `planTtlMs` comes from `window.ccxraySettings` (`Max` = 3600000, `Pro` = 300000, default to Max if unknown). Map: `> 0.6` → `var(--green)`, `0.3–0.6` → `var(--yellow)`, `< 0.3` → `var(--red)`.
- [x] 2.3 Add an inline `color` style to the cache dot (`●`) element driven by the computed colour variable.

## 3. Last-assistant-message preview (#3)

- [x] 3.1 In `public/entry-rendering.js`, extend the session entry in `sessionsMap` with `lastAssistantText: null`. When processing an entry whose `role === 'assistant'` (or whose parsed response events contain assistant text), extract the first non-empty text block and store the first 200 chars in `sessionsMap[sid].lastAssistantText`. Always overwrite (last wins).
- [x] 3.2 In `public/miller-columns.js` `renderSessionItem`, after the model/cost/date row, add a conditional `lastMsgHtml` block: if `sess.lastAssistantText` is non-null, strip basic HTML entities, truncate to 60 chars adding `…`, and render in a `<div class="si-preview">` element. If null, emit empty string.
- [x] 3.3 In `public/style.css`, add `.si-preview { font-size: 11px; color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }`.
- [x] 3.4 Remove the existing tool-stats row HTML (the `Bash-N Read-N Edit-N` line) from `renderSessionItem`.

## 4. Project dot tooltips (#4)

- [x] 4.1 In `public/miller-columns.js` `renderProjectsCol`, locate the sdot span for project items (around line 522). Compute `dotTitle` based on `statusClass`: `'sdot-stream'` → `"streaming"`, `'sdot-idle'` → `"idle · ${Math.max(1, Math.round((Date.now() - proj.lastSeenAt) / 60000))}m ago"`, `'sdot-off'` → `"offline"`.
- [x] 4.2 Add `title="${dotTitle}"` to the sdot span. `proj.lastSeenAt` must be maintained: in `addEntry` / SSE processing, update `proj.lastSeenAt = Date.now()` whenever an entry arrives for that project.

## 5. Decimal places (#5)

- [x] 5.1 Global search for `.toFixed(3)` in `public/` — replace each with `.toFixed(2)`. Verify all affected sites: project card cost, session card cost, turn card cost, topbar ROI.
- [x] 5.2 Run a quick visual check: confirm `$297.067` → `$297.07`, `$2.461` → `$2.46`.

## 6. Turn time layout (#6)

- [x] 6.1 In `public/miller-columns.js`, locate the turn-card time row render (the `wait:Xs dur:Xs (think:Xs)` line). Reorder output to: `dur:{N}s` first in normal colour, then `(wait:{N}s · think:{N}s)` in a `<span style="color:var(--dim);font-size:10px">` wrapper. Omit `think` segment if absent/zero; omit `wait` segment if absent/zero.
- [x] 6.2 If `wait`, `dur`, and `think` are all absent, emit no time row.

## 7. `hit` → `cache` rename (#7)

- [x] 7.1 In `public/miller-columns.js`, find the turn-card stats line that renders `hit:${hitPct}%` and change the prefix to `cache:`.
- [x] 7.2 Verify no other file references the `hit:` prefix for display purposes.

## 8. Project filter parity (#8)

- [x] 8.1 Add `active+idle` (→ renamed `Recent`) option to project filter dropdown, making it symmetrical with session filter (Streaming / Recent / All).
- [x] 8.2 Rename internal filter values: `active` → `streaming`, `active+idle` → `recent`. Add migration IIFEs to upgrade stale sessionStorage keys on load.
- [x] 8.3 Show visible count `(N)` next to both project and session filter selects; hidden in `All` mode.
- [x] 8.4 Add `<option title>` tooltips: Streaming = "Only projects with in-flight API calls", Recent = "Projects active within the last 5 minutes".

## 9. Verification

- [ ] 8.1 Open dashboard, confirm session cards show `▶ continue: {hash}`, clicking copies correct command.
- [ ] 8.2 Confirm cache row reads `cache · Xm left` with correct colour (green/yellow/red).
- [ ] 8.3 Confirm tool-stats row is gone; last assistant message preview appears.
- [ ] 8.4 Hover project dots, confirm tooltip appears with correct text.
- [ ] 8.5 Confirm all `$` values show exactly two decimal places.
- [ ] 8.6 Confirm turn time row reads `dur:Xs (wait:Xs · think:Xs)` with secondary dims.
- [ ] 8.7 Confirm turn stat reads `cache:100%` not `hit:100%`.
- [ ] 8.8 Run `npm test` — all green.
