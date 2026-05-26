## 1. Shared injected-tag module

- [x] 1.1 Create `shared/injected-tags.js` exporting `INJECTED_TAG_RE` (regex literal) and `isInjectedText(text)` (returns true when `text.trimStart()` matches the regex)
- [x] 1.2 Wire `server/helpers.js` to `require('../shared/injected-tags')` and replace any inline reference to the same pattern
- [x] 1.3 Leave `public/messages.js` inline copy in place; add a comment pointing at the shared module as canonical source

## 2. Pure turn/step computation

- [x] 2.1 Implement `computeTurnStep(messages)` in `server/helpers.js` per design D2 — pure function, returns `{ turn, step }`
- [x] 2.2 Treat a user message as a "human turn opener" iff `Array.isArray(content)` and at least one block satisfies `block.type === 'text' && block.text && !isInjectedText(block.text)`
- [x] 2.3 Handle string-content user messages by treating them as a single text block under the same rule
- [x] 2.4 Return `{ turn: 0, step: 0 }` for empty `messages[]` instead of throwing
- [x] 2.5 Export `computeTurnStep` from `server/helpers.js`

## 3. Tests for turn/step

- [x] 3.1 Create `test/turn-step.test.js`
- [x] 3.2 Add case: first request, single user-text message → `{turn:1, step:1}`
- [x] 3.3 Add case: tool-loop step 2 → `{turn:1, step:2}`
- [x] 3.4 Add case: tool-loop step 3 → `{turn:1, step:3}`
- [x] 3.5 Add case: mixed text + tool_result with `<system-reminder>` → `turn` unchanged from previous request
- [x] 3.6 Add case: pure system-reminder user message (no tool_result) → not a new turn
- [x] 3.7 Add case: empty messages array → `{turn:0, step:0}` and no throw
- [x] 3.8 Add case: second human turn after a completed tool loop → `{turn:2, step:1}`
- [x] 3.9 Add drift-guard test: assert `INJECTED_TAG_RE.source` in `shared/injected-tags.js` equals the regex literal source in `public/messages.js`
- [x] 3.10 Wire `test/turn-step.test.js` into the existing `npm test` runner (path is `test/`, not `tests/`)

## 4. Hub client registry lookup

- [x] 4.1 Add `lookupClientCwd()` in `server/hub.js` returning the unique client cwd or null
- [x] 4.2 Export `lookupClientCwd` from `server/hub.js`
- [x] 4.3 Use `hub.lookupClientCwd()` as fallback in REQUEST log path when sessionMeta has no cwd

## 5. Prefix renderer

- [x] 5.1 Add `renderAttributionPrefix(ctx)` helper in `server/helpers.js`
- [x] 5.2 Quota-check branch returns `[quota-check]` (still applied at REQUEST emission point; quota-check requests skip the log path entirely so prefix is never built for them)
- [x] 5.3 Orphan branch: `[orphan/<reqId12>]`
- [x] 5.4 direct-api branch: render verbatim, no truncation
- [x] 5.5 Standard branch: `[<projectBasename>/<session8>{~?} · #<sessNum> R<turn>.<step>]`
- [x] 5.6 Project field falls back to `?` when both cwd and hub registry yield nothing

## 6. Per-session request counter (sessNum)

- [x] 6.1 Increment `sessionMeta[sid].mainCount` (or `subCount` for subagents) on each logged request
- [x] 6.2 Counter persists for lifetime of in-memory session record (no reset)
- [x] 6.3 Format as `<n>` for main, `s<n>` for subagent, matching dashboard's displayNum

## 7. REQUEST line format

- [x] 7.1 Replace single REQUEST log line in `server/index.js` with the two-line layout
- [x] 7.2 Line 1: `📤 [<HH:MM:SS>] <prefix>  <method> <url>`
- [x] 7.3 Line 2 (indented): `   <model> · sys <sysTokens> · msgs <msgCount>`
- [x] 7.4 Strip the `Messages: N (Xu/Ya)` line from `summarizeRequest`
- [x] 7.5 `summarizeRequest` now returns the new line-2 format directly

## 8. RESPONSE line format

- [x] 8.1 Locate response completion log emission in `server/forward.js` (SSE path + non-SSE path)
- [x] 8.2 Render `📥 [<HH:MM:SS>] <prefix>  <glyph> <code>  <duration>  out=<tokens>`
- [x] 8.3 Glyph: `✓` for 2xx, `✗` otherwise; color too (green/red)
- [x] 8.4 Non-SSE failure path appends parsed error type from response body
- [x] 8.5 Streaming chunks unchanged; only completion line carries prefix

## 9. End-to-end manual verification

- [x] 9.1 Smoke test: POST /v1/messages reached server, proxy logged auth error from upstream as expected
- [ ] 9.2 Tool-loop with 3+ steps — pending live observation by user
- [ ] 9.3 Hub mode multi-project disambiguation — pending live observation
- [ ] 9.4 Quota check renders `[quota-check]` — pending live observation (quota check skips log path; verified by spec tracing)
- [ ] 9.5 Orphan subagent renders `[orphan/<reqId>]` — pending live observation
- [ ] 9.6 4xx response renders `✗ <code>` — pending live observation

## 10. Verification gates

- [x] 10.1 `npm test` — 78 tests / 345 sub-tests, all green
- [x] 10.2 `node -c` syntax check on every modified server file passed
- [x] 10.3 Server stayed listening on :5577 across every save (verified after each phase)
- [x] 10.4 Dashboard rendering unchanged (no public/ files modified)
