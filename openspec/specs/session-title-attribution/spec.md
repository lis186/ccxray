# Session Title Attribution Specification

## Purpose

建立 Claude Code 內建 title-generator subagent 的 title 捕獲、attribution、persistence 與 SSE 推播機制，讓 Sessions column 顯示人類可讀的 session 標題取代 8-char hash。

## Requirements

### Requirement: Title-generator entries SHALL be classified and extracted as session titles

The server MUST recognise Claude Code's title-generator subagent requests (already detected via the b2 prefix `"Generate a concise"` → `agentKey === 'title-generator'`) and extract the generated title from the JSON-wrapped response payload. The extractor MUST try, in order: `JSON.parse` of the concatenated text deltas followed by reading the `.title` field; a regex fallback matching `/"title"\s*:\s*"([^"]+)"/`; and return `null` on total failure. Malformed or empty extractions MUST NOT be written to any session, log entry, or broadcast.

#### Scenario: Well-formed JSON response

- **WHEN** a title-generator response streams `{"title": "Fix login button on mobile"}` across any number of `content_block_delta` events
- **THEN** the extracted title is `"Fix login button on mobile"` with outer quotes and the JSON envelope removed

#### Scenario: Truncated or malformed JSON

- **WHEN** the concatenated response text is `{"title": "Add OA` (incomplete) or contains characters that break `JSON.parse`
- **THEN** the regex fallback yields `"Add OA"` if it matches, otherwise the extractor returns `null`
- **AND** no title is written to the owning session

#### Scenario: Non-title-generator entries are not affected

- **WHEN** a regular turn or a different subagent (e.g. Explore, Plan) completes
- **THEN** its `entry.title` continues to be produced by the existing `extractResponseTitle` / `extractFirstUserText` / `extractToolResultSummary` chain with no JSON parsing applied

### Requirement: Extracted titles SHALL be attributed to the correct parent session

Because title-generator requests carry no `metadata.user_id`, the server MUST attribute the title using a two-signal match: (a) temporal — the most-recently-started inflight session whose first request fired within the last 1000 ms of the title-generator request's receive time; and (b) content — the parent session's first user message text equals the title-generator request's `messages[0].content[0].text`. A title MUST be written to `sess.title` only when both signals agree. When signals disagree or no inflight session qualifies, the title MUST be discarded and the session left labelled by its short id.

#### Scenario: Single inflight session with matching content

- **WHEN** a title-generator request arrives 200 ms after a main request that opened session `A`, and the user text in both requests is byte-identical
- **THEN** the extracted title is stored as `sess[A].title` and broadcast to dashboard clients

#### Scenario: Two concurrent sessions, only one content-matches

- **WHEN** sessions `A` and `B` both opened within the last 500 ms, but only `A`'s first user text matches the title-generator request body
- **THEN** the title attaches to `A`; `B` remains labelled by its short id

#### Scenario: Temporal match but content mismatch

- **WHEN** an inflight session started 100 ms ago, but its first user message does not equal the title-generator request body
- **THEN** the title is discarded and no session's label changes

### Requirement: Session titles SHALL persist across server restart without extra I/O

The existing `index.ndjson` per-turn `title` column MUST be reused as the persistence channel for session titles. For `agentKey === 'title-generator'` entries, the server MUST write the extracted (clean) title — not the verbatim parent user message — to that column at the time the entry is recorded. On restart, `restore.js` MUST scan the already-loaded index entries, and for every entry whose stored agent key is `title-generator` it MUST populate `sess.title` for the associated session using the stored title. The restore pass MUST NOT read `_res.json` bodies or open any shared file for this purpose.

#### Scenario: Fresh title survives restart

- **WHEN** a session receives a title, the server is stopped, and then restarted
- **THEN** the session card in the Miller column renders the original title immediately on first dashboard load

#### Scenario: Pre-existing entries without clean titles

- **WHEN** the server restarts against an `index.ndjson` written by an older version (where title-gen entries stored the verbatim user text)
- **THEN** no error is thrown; affected sessions fall back to their short id; the next live title-generator call for any active session writes a clean title and corrects the display

### Requirement: Titles SHALL update in place when Claude Code regenerates them

When Claude Code fires a second title-generator call for the same session (topic drift), the server MUST replace `sess.title` only if the new request's timestamp is strictly greater than the stored `sess.titleReqTs`. Broadcasts MUST be debounced so bursts within 3 s produce at most one outgoing SSE event carrying the latest value.

#### Scenario: Later title replaces earlier

- **WHEN** session `A` has `title="Refactor API client"` with `titleReqTs=T1`, and a new title-gen response arrives at `T2 > T1` with title `"Add OAuth flow"`
- **THEN** `sess[A].title` becomes `"Add OAuth flow"` and dashboards receive one SSE update

#### Scenario: Out-of-order responses

- **WHEN** a response for a request issued at `T0` arrives after the response for a request issued at `T1 > T0` has already been applied
- **THEN** the late `T0` response is ignored; `sess.title` remains the `T1` value

#### Scenario: Burst debounce

- **WHEN** three title-generator responses for the same session arrive within 3 s
- **THEN** dashboards receive exactly one `session_title_update` event carrying the last title; intermediate values are not broadcast

### Requirement: The dashboard SHALL render the generated title in place of the short id

The Sessions column card, the breadcrumb strip, and the intercept overlay header MUST call a single `formatSessionLabel(sess, sid)` helper whose contract is: return `sess.title` if non-empty, otherwise return the 8-character short id (or the existing synthetic label for `direct-api`). The rendered element inside the session card MUST wrap to at most three lines and truncate further overflow with an ellipsis (`display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden;`). Breadcrumb and other horizontally constrained sites MAY continue to use single-line ellipsis. The `.sid` element (showing the 8-char short id) MUST carry a `title=` attribute containing the full session id so hovering reveals the underlying id. The `.si-title` element does NOT need a `title=` attribute — its content is already the human-readable label, and the short-id tooltip lives on the adjacent `.sid` span. URL deep-link parameters (e.g. `?s=`) MUST continue to use the short id so previously shared links remain stable.

#### Scenario: Session with title

- **WHEN** `sess.title` is `"Systematic problem-solving with weighted evaluation framework"` and the card is 230 px wide
- **THEN** the card shows up to three lines of the title; anything beyond three lines is ellipsed; the `.sid` span next to the title carries `title="<full session id>"`; the copy button still copies the full session id via `claude --continue <sid>`

#### Scenario: Session without title

- **WHEN** `sess.title` is empty (new session, title-gen not yet completed, or non-Claude-Code traffic)
- **THEN** the card shows the 8-character short id exactly as it does today and the tooltip shows only the short id

#### Scenario: URL stability

- **WHEN** a user navigates directly to a session via `?s=982b8528`
- **THEN** the session resolves regardless of whether `sess.title` is set, and the URL parameter is unchanged by later title updates
