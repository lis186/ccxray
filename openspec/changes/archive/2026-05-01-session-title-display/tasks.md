## 1. Pre-work (cleanup, pinned fixture)

- [ ] 1.1 Copy one real title-gen `_req.json` + `_res.json` pair from `~/.ccxray/logs/` into `test/fixtures/title-gen/` (well-formed). Create a second synthetic fixture with deliberately truncated JSON for the negative path.
- [ ] 1.2 Remove the current (broken) assumption for title-gen entries: audit `server/forward.js:247-252` and `server/forward.js:358-364` and note both call sites explicitly in code comments before refactoring.

## 2. Server — extraction

- [ ] 2.1 Add `extractTitleGenPayload(events)` to `server/helpers.js`: concat `text_delta` → `JSON.parse(...).title` → regex fallback `/"title"\s*:\s*"([^"]+)"/` → `null`. Export from module.
- [ ] 2.2 Add unit tests in `test/extract-title-gen.test.js` covering: well-formed JSON, truncated JSON with regex-recoverable prefix, empty response, non-string `.title`, arrays-of-titles, unicode/emoji/CJK.
- [ ] 2.3 In `server/forward.js`, branch on `agentKey === 'title-generator'` (available via `extractAgentType(parsedBody.system)`) for both the SSE and non-SSE title-computation blocks. When matched, call `extractTitleGenPayload` instead of `extractResponseTitle`; write the result to `entry.title`.

## 3. Server — attribution

- [ ] 3.1 In `server/store.js`, add `sessionTitles` map with shape `{ sessionId → { title, titleReqTs } }`, plus `setSessionTitle(sessionId, title, reqTs)` helper that applies the monotonic `titleReqTs` guard and returns a boolean indicating whether the value changed.
- [ ] 3.2 Add `attributeTitleGen(parsedBody, receivedAt)` in `server/store.js` that returns a `sessionId` or `null`. Algorithm: collect inflight sessions whose `lastSeenAt` ≥ `receivedAt - 1000`; filter to those whose stored first-user-message text equals `parsedBody.messages[0].content[0].text`; if exactly one survives, return its id, otherwise return `null`. (Track first-user-message per session on session creation; small field on `sessionMeta`.)
- [ ] 3.3 Populate `sessionMeta[sid].firstUserMsg` the first time a main request is attributed to a session (inside `detectSession`). Do not overwrite on subsequent requests.
- [ ] 3.4 In `server/forward.js`, after the title is extracted for a title-gen entry, call `attributeTitleGen` and if it returns a sessionId, call `setSessionTitle`. Log one warning when attribution fails (`[title-gen] unattributable: candidates=N, content-match=M`).

## 4. Server — broadcast + persistence

- [ ] 4.1 In `server/sse-broadcast.js`, add a `broadcastSessionTitleUpdate(sessionId)` function that emits `{ _type: 'session_title_update', sessionId, title, titleReqTs }`. Apply a per-session 3 s debounce so bursts collapse to one outbound event carrying the latest stored value.
- [ ] 4.2 Call `broadcastSessionTitleUpdate` from `setSessionTitle` when the returned boolean indicates the title changed.
- [ ] 4.3 In `server/restore.js`, after parsing `index.ndjson`, walk the restored entries once and for each entry whose `isSubagent` is true and whose stored `title` looks like a clean session title (length ≤ 80, no newlines, not starting with `{`), call `setSessionTitle` with the entry's `receivedAt` as `titleReqTs`. Skip entries that don't meet the heuristic (legacy verbatim-user-text persisted under the old bug).
- [ ] 4.4 Gate everything behind `process.env.CCXRAY_DISABLE_TITLES === '1'` at the extractor entry point — when set, `extractTitleGenPayload` returns `null` and no attribution/broadcast/persistence runs.

## 5. Server — tests

- [ ] 5.1 Add `test/session-title-attribution.test.js`: single-inflight match happy path, two-inflight content disambiguation, two-inflight content collision (both discarded), no-inflight discard, monotonic guard (out-of-order timestamp rejected).
- [ ] 5.2 Add `test/restore-session-titles.test.js`: restore picks up a clean title from index, skips a title-looking-like-JSON legacy value, skips when agent key is not title-generator.
- [ ] 5.3 Ensure existing `test/store.test.js` and `test/startup.test.js` still pass; extend `test/sse-broadcast.test.js` with a debounce-collapse case.

## 6. Client — label helper + data plumbing

- [ ] 6.1 Create `public/session-label.js` exporting `formatSessionLabel(sess, sid)` returning `sess.title || (sid === 'direct-api' ? 'direct API' : sid.slice(0, 8))`. Also export `formatSessionTooltip(sess, sid)` returning `sess.title ? sess.title + ' · ' + sid.slice(0, 8) : sid.slice(0, 8)`.
- [ ] 6.2 Load `public/session-label.js` from `public/index.html` before `miller-columns.js`.
- [ ] 6.3 In `public/entry-rendering.js`, extend `sessionsMap` values with `title: null, titleReqTs: 0`. Ensure existing session creation paths leave these as defaults.
- [ ] 6.4 Handle the new `session_title_update` SSE event in the existing event router: look up the session in `sessionsMap`, apply the monotonic guard, update `title`/`titleReqTs`, re-render only that session card by id `sess-<shortSid>`.

## 7. Client — render swaps

- [ ] 7.1 In `public/miller-columns.js`, replace the `shortSid` display in `renderSessionItem` (L408) with `formatSessionLabel(sess, sid)`. Add `title=` attribute using `formatSessionTooltip`.
- [ ] 7.2 Replace `session:` + shortSid in the breadcrumb at L922 with `session: ` + `formatSessionLabel(sess, sid)` (look up `sess` from `sessionsMap`). Keep the URL param (L966) using the existing `shortSid`.
- [ ] 7.3 In `public/intercept-ui.js`, apply `formatSessionLabel` at L34 (overlay header) and verify L283/301/312 re-render paths pick up the title after the SSE event fires (no hard-coded `slice(0, 8)`).
- [ ] 7.4 Verify pin-toggle re-render at `public/miller-columns.js:156` still works (it calls `renderSessionItem` so it benefits automatically).

## 8. Client — styles

- [ ] 8.1 In `public/style.css`, add `.sess-title` rule for card usage: `display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; min-width: 0; word-break: break-word;`. Apply the class inside `renderSessionItem`'s title span. Breadcrumb and intercept overlay keep single-line ellipsis via a separate `.sess-title--inline` rule.
- [ ] 8.2 Verify CJK + emoji render correctly at 230 px card width by screenshotting two samples (short title, long title) and confirming the two-line clamp + card-height consistency.

## 9. Manual verification

- [ ] 9.1 With a clean `~/.ccxray/logs/` (or a scratch `CCXRAY_HOME`), run `ccxray claude` and start two new sessions with distinct first messages; confirm both cards swap from short-hash to title within ~2 s.
- [ ] 9.2 Open two new sessions in the same 500 ms window with byte-identical first messages (`"繼續"` both times); confirm both cards stay on short-hash (no mis-attribution) and one server-log warning is printed.
- [ ] 9.3 Start a session, wait for its title to appear, stop the server, restart; confirm the title is present on first dashboard load.
- [ ] 9.4 Set `CCXRAY_DISABLE_TITLES=1` and restart; confirm every session shows the short-hash label and no `session_title_update` events fire.
- [ ] 9.5 Hover a title card and confirm the tooltip shows `<full title> · <shortSid>`; click the copy button and confirm it still copies the full session id.

## 10. Ship

- [ ] 10.1 Run `npm test` — all green.
- [ ] 10.2 Update `CHANGELOG.md` with a user-facing description (`Sessions column now shows Claude Code's generated title; short hash moves to tooltip.`).
- [ ] 10.3 Self-review per `CLAUDE.md` Section 6: re-read every modified file, check for unused imports/dead code from the refactor, flag any remaining `slice(0, 8)` outside `formatSessionLabel`.
- [ ] 10.4 Open PR targeting `main`; link this OpenSpec change; include the P0 fixture findings in the description.
