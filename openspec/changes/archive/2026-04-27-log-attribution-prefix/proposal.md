## Why

Server-side stdout/log lines (`📤 REQUEST` and the response counterpart) carry no attribution: in hub mode where multiple projects share one ccxray process, every request line looks the same and you cannot tell from `~/.ccxray/hub.log` which project / session / conversation turn produced a given request. Dashboard already groups requests by project → session → turn, but the CLI surface — used for live tail and post-hoc grep — is opaque. The owner has confirmed they personally want project, session, turn, and step visible in every line.

## What Changes

- Add an attribution prefix to every REQUEST and RESPONSE log line: `[<project>/<session8> · #<sessNum> R<turn>.<step>]`.
- Compute logical turn / step from `messages[]` using the same injected-tag classification the dashboard uses (`system-reminder`, `user-prompt-submit-hook`, `context`, `antml:function_calls`).
- Extract the injected-tag regex into a shared module so server (Node) and dashboard (browser) load from one source of truth.
- Display rules for non-standard sessions: `direct-api` shown verbatim; quota checks shown as `[quota-check]`; orphan subagents (no inferred parent) shown as `[orphan/<reqId>]`; `sessionInferred` requests get a trailing `~` after the session id.
- Add a hub-aware cwd fallback so the first request of a session — which sometimes lacks the system prompt that carries `Primary working directory` — still shows a project name by looking up the registered hub client.
- Add response-line attribution with status glyph (`✓` 2xx, `✗` non-2xx) so failures are grouped with their originating request without scrolling.
- Add unit tests for `computeTurnStep()` covering 8 boundary cases (first request, tool-loop steps 1-3, mixed text+tool_result content, system-reminder injection, direct-api, orphan, quota check, empty messages).

Not included (deferred to backlog): project-basename collision auto-disambiguation, dashboard column rename, replacing browser-side `INJECTED_TAG_RE` with a shared script load.

## Capabilities

### New Capabilities

- `server-log-attribution`: Per-request attribution prefix on REQUEST/RESPONSE stdout lines (project, session, dashboard request number, logical turn and step), with rules for direct-api / quota-check / orphan / inferred sessions and a hub-aware cwd fallback.

### Modified Capabilities

_None — no existing spec's requirements change. The dashboard's per-entry numbering and turn-card display continue to behave exactly as before; this change only adds a new server-side surface._

## Impact

- **Code**:
  - `server/index.js` — REQUEST log line format
  - `server/forward.js` — RESPONSE log line format and status glyph
  - `server/helpers.js` — new `computeTurnStep()` helper; `summarizeRequest()` Messages-line removed (subsumed by new prefix)
  - `server/store.js` — read path for cwd fallback (no schema change)
  - `server/hub.js` — expose registered client cwd lookup
  - `shared/injected-tags.js` (new) — shared regex + classifier
  - `tests/turn-step.test.js` (new) — boundary coverage
- **APIs**: None. Public HTTP/SSE contract unchanged.
- **Dependencies**: None added.
- **External consumers**: `~/.ccxray/hub.log` format changes (no known external parsers; single-user project).
- **Risk**: Low. Pure presentation layer over existing server state. No data persisted in the new format.
