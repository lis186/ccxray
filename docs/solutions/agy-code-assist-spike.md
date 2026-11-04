# Antigravity CLI (`agy`) Code Assist proxy spike (#698)

- Date: 2026-10-17
- agy: 1.4.0, OAuth (consumer) login, model `gemini-3.8-flash-high`
- Scope: answer the three open questions in #698 before any production code.
  No ccxray code was changed; this records wire observations only.

## Method

- A throwaway Node pass-through proxy (outside the repo, deleted afterwards) on
  `127.0.0.1:<port>`, forwarding to the Code Assist host over HTTPS. It logged,
  per request, only: method, path, status, header **names**, the **key paths** of
  JSON/SSE bodies, and the numeric fields of any `usageMetadata` object. No
  values, prompts, tokens, account ids or project ids were recorded.
- The proxy was attached to one isolated invocation per run via an env var on
  that command only:
  `CLOUD_CODE_URL=http://127.0.0.1:<port>/agyprefix agy -p "Reply with exactly OK" --sandbox --mode plan --model gemini-3.8-flash-high --output-format json`.
  The shared hub (:5577) was not used; no agy config, login or settings were touched.
- agy calls used: 6 (2 plain `agy models`, 1 plain `-p`, 3 proxied `-p`).
- Login check: after the last proxied run, a plain `agy models` with no env
  override succeeded, and the OAuth token file fingerprint matched the
  pre-spike baseline. Note: agy refreshes OAuth itself and can rotate the token
  file on any call (it did so once before the spike started), so a changed
  fingerprint after a plain call is normal. The real check is that a plain call
  succeeds without re-login.

## Finding 0 (load-bearing, not in the issue): the default host is `daily-cloudcode-pa`

agy 1.4.0 talks to **`https://daily-cloudcode-pa.googleapis.com`** by default
(its own per-run log under `~/.gemini/antigravity-cli/log/` names this host for
every `v1internal:` call). The binary also contains `cloudcode-pa.googleapis.com`,
`autopush-cloudcode-pa.sandbox.googleapis.com` and
`preprod-daily-cloudcode-pa.sandbox.googleapis.com`.

When the proxy forwarded to `cloudcode-pa.googleapis.com` (the host #698 named),
every discovery/onboarding call returned 200 but every `streamGenerateContent`
returned **429 `RESOURCE_EXHAUSTED`**, and agy retried for ~110 s before failing.
The same model through the same proxy pointed at `daily-cloudcode-pa` returned
200 immediately, and a plain call (no proxy) succeeded between the two runs. So
the 429 was the wrong upstream pool, not quota exhaustion.

Implication: the ccxray upstream must be the host agy itself would have used.
`daily-` is an implementation detail of this build and may change per version
or tier — **obs-fragile**. Prefer making the upstream overridable
(`CCXRAY_*`-style env) and documenting how to read it from agy's log, rather
than hardcoding one host.

## Q1 — Does `CLOUD_CODE_URL` accept plain http and a path prefix?

**Yes to both.** — obs-stable for 1.4.0 (3/3 proxied runs), unverified on other versions.

- `http://127.0.0.1:<port>/agyprefix` was accepted with no TLS error, no warning,
  and no CA configuration. agy's own log records the http base URL.
- The prefix is **preserved and prepended**: every request arrived as
  `POST /agyprefix/v1internal:<method>` (query string kept, e.g.
  `/agyprefix/v1internal:streamGenerateContent?alt=sse`). Nothing arrived
  without the prefix.
- The proxy must strip the prefix before forwarding. Forwarding it verbatim
  makes Google return an HTML 404, and agy then fails closed with
  `Eligibility check failed: request failed (code 404)` after retrying
  `loadCodeAssist` 8 times. Login state on disk was unaffected.

So the prefix is usable as a routing discriminator for a shared hub
(e.g. `/agy/...`), the same way a unique path family would be.

## Q2 — Do discovery / onboarding / quota calls pass through?

**Yes, all 200 through the http+prefix proxy** (pointed at the correct host). — obs-stable

Calls observed in one print-mode run, in order of first appearance:

| Path (`/v1internal:` …) | Status | Role (inferred) | Count per run |
|---|---|---|---|
| `loadCodeAssist` | 200 | tier / project discovery (onboarding) | 4 |
| `fetchUserInfo` | 200 | user settings | 2 |
| `fetchAdminControls` | 200 | admin policy | 1 |
| `fetchAvailableModels` | 200 | model list + per-model quota | 1 |
| `retrieveUserQuotaSummary` | 200 | quota buckets | 4 |
| `listExperiments` | 200 | experiment flags | 3 |
| `writeTrajectoryAcls` | 200 | trajectory ACL | 1 |
| `streamGenerateContent?alt=sse` | 200 | **generation** | 2 |
| `recordTrajectoryAnalytics` | 200 | telemetry | 1 |

No `onboardUser` call appeared (account already onboarded). `:generateContent`
(non-streaming) did not appear in print mode. Only `streamGenerateContent` is
conversation traffic; every other path is noise for the dashboard.

Header names (all requests): `authorization`, `content-type`, `user-agent`,
`accept-encoding`, `host`, plus `content-length` or (for streams)
`transfer-encoding`. No session/conversation header exists — identity is in
the body only. Discovery responses carry `x-cloudaicompanion-trace-id`; stream
responses do not (they carry `content-disposition`).

## Q3 — Where does `usageMetadata` appear?

**In every SSE `data:` chunk of `streamGenerateContent`, at
`response.usageMetadata`, cumulative; the last chunk is final.** — obs-stable
for the fields seen; obs-fragile for cache (never observed non-zero).

Stream body: plain `data: <json>` lines only (no `event:`/`id:` fields).
Each chunk is the Code Assist envelope:

```
{ response: { candidates[]: { content: { role, parts[]: { text | thought | thoughtSignature | functionCall{ id, name, args } } },
                              finishReason },
              usageMetadata: { promptTokenCount, candidatesTokenCount, thoughtsTokenCount, totalTokenCount },
              modelVersion, responseId },
  traceId, metadata }
```

- `finishReason` appears only on the last chunk; `usageMetadata` is present on
  every chunk (first chunk may have only `promptTokenCount`/`totalTokenCount`).
- Observed token fields: `promptTokenCount`, `candidatesTokenCount`,
  `thoughtsTokenCount`, `totalTokenCount`. Arithmetic held exactly:
  `total = prompt + candidates + thoughts`; `candidates` excludes thoughts.
- `cachedContentTokenCount` was **not observed** (fresh prompts, CLI also
  reported `cache_read_tokens: 0`). Its presence/nesting is still unverified —
  the parser should accept it at `response.usageMetadata.cachedContentTokenCount`
  (public Gemini shape) and treat absence as unknown, not zero, per
  `contextUsageKnown` (ADR 0020).
- The CLI's `--output-format json` `usage` matched the **main** stream exactly:
  `input_tokens = promptTokenCount`, `output_tokens = candidates + thoughts`,
  `thinking_tokens = thoughtsTokenCount`. The CLI total **excludes** the
  auxiliary stream (below), so CLI totals and per-request wire totals differ.

### Two streams per print turn

| | aux stream | main stream |
|---|---|---|
| prompt tokens | ~10² | ~10⁴ |
| `request.tools` | absent | present |
| `request.labels` | absent | present |
| `thinkingConfig` | `thinkingLevel` | `thinkingBudget` (+ `maxOutputTokens`) |
| response parts | `text`, `thought` | `text`, `thought`, `functionCall` |

The aux call looks like title/summary generation (same family as Claude Code's
title-gen requests). It must still be priced (it is billed) but should not be
counted as a conversation turn; `request.labels` presence / `requestType` are
candidate discriminators (values not inspected in this spike).

### Request envelope and identity fields (key names only)

```
{ model, project, requestId, requestType, userAgent,
  request: { contents[]{role, parts[]{text}}, systemInstruction{role, parts[]{text}},
             generationConfig{ thinkingConfig{includeThoughts, thinkingLevel|thinkingBudget}, maxOutputTokens },
             tools[]{functionDeclarations[]{name, description, parameters}},
             sessionId,
             labels{ cascade_id, root_cascade_id, trajectory_id, request_id, last_step_index,
                     model_enum, used_claude, used_claude_conservative, used_non_gemini_model } } }
```

Identity candidates for ccxray:
- session: `request.sessionId` (body); `labels.trajectory_id` / `cascade_id`
- subagent relation: `labels.root_cascade_id` vs `labels.cascade_id`
  (unverified — no subagent was spawned; agy does expose a `Subagents` tool)
- turn: top-level `requestId`, `labels.request_id`, `labels.last_step_index`
- response: `response.responseId` (dedup key, ADR 0012 analogue),
  `response.modelVersion`, `traceId`
- `project` and `loadCodeAssist.cloudaicompanionProject` are account-linked
  ids — must be redacted from any persisted summary/export.

`labels.used_claude` and the model list (`claude-sonnet-4-6`,
`gpt-oss-120b-medium`) show the same Code Assist wire carries non-Gemini models;
pricing must key on the request `model`/`modelVersion`, not assume Gemini.

## Implications for #698

1. **Routing.** Code Assist traffic is identifiable by path alone
   (`/v1internal:` family, or a launcher-chosen prefix such as `/agy`). The
   launcher can set `CLOUD_CODE_URL=http://127.0.0.1:<port>/agy` and the server
   strips `/agy` before forwarding — no TLS needed. A prefix is preferable to
   bare `/v1internal:` matching because it cannot collide with any other wire
   and makes the hub unambiguous.
2. **Upstream.** Default to the host agy would use (`daily-cloudcode-pa` for
   1.4.0) with an env override; a wrong host fails as a slow 429 loop, which
   looks like quota exhaustion — the diagnostics should say so.
3. **Noise.** Everything except `streamGenerateContent` / `generateContent`
   should be `skipEntry: true`: `loadCodeAssist`, `fetchUserInfo`,
   `fetchAdminControls`, `fetchAvailableModels`, `retrieveUserQuotaSummary`,
   `listExperiments`, `writeTrajectoryAcls`, `recordTrajectoryAnalytics`
   (and presumably `onboardUser`). About 17 noise calls per print turn.
4. **Parser.** New wire family (`wire-parsers/gemini.js`): fold the SSE stream
   by taking the last chunk's `response.usageMetadata`; map thoughts into
   output (as the CLI does) but keep them separately; cached tokens optional.
   Tool calls are `parts[].functionCall` with an `id`.
5. **Launcher env.** Only `CLOUD_CODE_URL` is needed for OAuth mode. Set it on
   the child process only; never write agy settings.
6. **Fail-open.** A wrong path or host breaks generation or onboarding loudly
   (404 eligibility error, 429 retry loop) but did not damage stored login.
   Pass-through must still be byte-faithful; the spike proxy dropped
   `accept-encoding` to read bodies, which ccxray's forward path should not
   need to do.

## Risks / open questions

- Host is build-specific (`daily-` vs prod vs sandbox) — obs-fragile; re-verify per agy release.
- `cachedContentTokenCount` never observed; cache pricing unverified.
- Subagent identity (`root_cascade_id`) and multi-turn `sessionId` stability unverified.
- The aux stream's discriminator (`requestType` / `labels`) is inferred from key
  presence only.
- Consumer-tier OAuth has no per-token bill; costs will be estimates.
- `--sandbox --mode plan` print mode only; interactive mode and API-key mode
  (`GOOGLE_GEMINI_BASE_URL`) were not tested.
- OAuth refresh rewrites the token file on its own schedule; any future
  automated check must test a successful plain call, not the file hash.
