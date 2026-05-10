# ccxray Roadmap: Positioning, Pain Points & Integration

> Self-contained planning document. Captures the conclusions of a research session
> (May 2026) that audited ccxray against three user pain points, compared it to
> `ColeMurray/claude-code-otel`, and designed a Replay & Diff feature plus a
> drill-down integration path. Written so a future maintainer (or another agent)
> can act on it without re-reading the original conversation.

---

## 1. Background: the three pain points being solved

The trigger was a slide titled **「踩雷經驗分享」** that listed three field-tested
pain points when developing with LLM agents:

1. **Log Everything** — record every request and response, no exceptions.
2. **Errors get swallowed by chat** — to keep a conversation flowing, errors are
   silently absorbed, leading to **infinite loops → bill explosion**.
3. **Are AI results truth or hallucination?**
   - Don't trust that a tool was actually invoked (did `web_fetch` really run?).
   - Tiny prompt differences cause big result swings.
   - CLI / fixed-flow scaffolding around the AI helps reliability.

Recent (Feb–May 2026) industry consensus on each, from research:

| Pain | 2026 expert practice |
|---|---|
| Log everything | OpenTelemetry GenAI semantic conventions; prompt content as **span events**, not attributes; tail-based sampling (keep all errors, sample 10% successes). |
| Loop / bill | Multi-tier guardrails: soft (model downgrade, context truncation) + hard (per-session token cap, dollar cap). Real incidents: a $47K LangChain ping-pong, a 2.3M-call weekend, a $437 overnight. SDK / proxy-level enforcement is the only reliable layer. |
| Hallucination / tool reality | Span-level claim verification; token-level real-time hallucination detection (vLLM HaluGate); function-call grounding; **prompt sensitivity testing** (Forrester predicts 75% of enterprise LLM deployments will include this in 2026). Hybrid (deterministic backbone + agents at specific steps) dominates production. |

---

## 2. Positioning: what ccxray is, and is not

This is the foundational decision that drives every priority below.

> **ccxray is the wire-level debugger ("Wireshark") for Claude Code.**
>
> *"I see everything. I change nothing."*

| Reinforcing signals (in code / docs) | Source |
|---|---|
| Self-described as "transparent HTTP proxy" | `README.md` |
| Zero config / zero runtime deps | `package.json`, no build step |
| Miller-column UX = exploratory drill-down, not aggregated dashboards | `public/miller-columns.js` |
| Claude-Code-specific knowledge baked in (`KNOWN_AGENTS`, B2 splitting, subagent inference, `cc_version` versioning) | `server/system-prompt.js` |
| Hub mode = single developer × many repos | `server/hub.js` |
| Delta storage = engineer-grade long-session optimization | `server/restore.js` |
| Cost budget reports but never enforces | `server/cost-budget.js` (deliberate, not an oversight) |

**What ccxray is NOT, and shouldn't try to be:**

- ❌ Enterprise gateway (Kong / agentgateway own this)
- ❌ Multi-account load balancer (`ccflare` owns this)
- ❌ Aggregated metrics platform (`claude-code-otel` + Grafana / LangSmith / Datadog own this)
- ❌ Generic LLM proxy (`litellm` owns this)
- ❌ Agent runtime that executes tools, retries, recovers (out of scope)

---

## 3. Reference: how `claude-code-otel` differs (and why this matters)

`ColeMurray/claude-code-otel` is a Docker Compose stack
(OTel Collector + Prometheus + Loki + Grafana) that consumes Claude Code's
**built-in** OpenTelemetry emission (enabled via `CLAUDE_CODE_ENABLE_TELEMETRY=1`).

| Dimension | `claude-code-otel` | `ccxray` |
|---|---|---|
| Data source | Claude Code's internal OTel spans | HTTP proxy capturing actual wire bytes |
| Sees | Aggregated metrics: tokens, cost, tool success rates, DAU/WAU/MAU | **Full request and response bodies of every turn** |
| Does NOT see | Prompt content (privacy, off by default), wire-level SSE, tool input/output details | Cross-team aggregation, time-series trends |
| Audience | Team lead / FinOps / managers | Individual developer debugging |
| UX | Grafana dashboards (bird's-eye) | Miller column drill-down (microscope) |
| Infra | 4 services in Docker Compose | Single Node.js process |

**Critical insight:** these are **complementary**, not competing.
Together they form a natural pattern:

```
Grafana metric anomaly  →  pivot to ccxray  →  inspect the offending turn(s)
   (claude-code-otel)                              (ccxray)
```

This conclusion has two consequences for the roadmap:
1. **Drop OTel exporter from ccxray's roadmap.** Anyone wanting OTel/Grafana
   already has Claude Code's built-in path. Re-implementing it would be a worse
   duplicate, on `claude-code-otel`'s home turf.
2. **Drop hard cost-cap enforcement.** Cost dashboards + Grafana alerts already
   handle macro-level cost control. Adding hard caps inside ccxray breaks the
   "transparent" promise *and* duplicates `claude-code-otel`.

---

## 4. Pain-point coverage audit (current state)

Concrete findings from reading the code (May 2026).

### Pain #1 — Log Everything: ~80% covered

**Already done:**
- Full req/res logged to `_req.json` / `_res.json` (`server/forward.js:465,694,814`).
- Delta storage (full + `prevId` chain) compresses long sessions ~85–90%
  (`CLAUDE.md:104-125`, `server/restore.js`).
- `tool_use` and `tool_result` paired by `tool_use_id`
  (`public/messages.js:173-211`).
- Per-turn cost accumulated to session (`forward.js:638-641`).

**Gaps:**
- ❌ No PII / API-key redaction *before disk write*. UI highlights credentials
  (`messages.js:5-49`) but the `_req.json` on disk is plaintext.
- ❌ No OpenTelemetry export — and per §3, **we are not adding one**.

### Pain #2 — Errors swallowed / loops / bill explosion: ~30% covered

**Already done:**
- Per-session cost tracking (`store.js:34` `sessionCosts`).
- 5-hour block burn-rate calculation
  (`cost-budget.js:126-143`).
- `is_error: true` flag captured (`messages.js:247`).
- Self-referential proxy loop detected at startup (`server/index.js:38`).

**Gaps:**
- 🚨 `cost-budget.js` computes limits but **never enforces** them — display only.
- 🚨 No detection of repeated identical tool calls, repeated assistant text, or
  repeated tool errors.
- 🚨 Tool errors are not visually distinguished in the timeline.

### Pain #3 — Hallucination / tool execution reality: ~50% covered

**Already done — this is ccxray's strongest area:**
- ✅ Tool execution proof: `tool_use` (`messages.js:721`) + `tool_result`
  (`messages.js:725`) shown verbatim. Directly answers "did `web_fetch` actually
  run?".
- ✅ Orphan `tool_result` detection when context compaction loses the call
  (`messages.js:211`).
- ✅ System prompt versioning by `cc_version` (`system-prompt.js:36-37`).
- ✅ B2 block-level unified diff between system prompt versions
  (`system-prompt.js:142-207`).

**Gaps:**
- ❌ No claim ↔ tool-result linking (assistant says "I fetched X" — no automatic
  check the tool result actually contained X).
- ❌ The intercept editor (`server/routes/intercept.js`,
  `public/intercept-ui.js`) edits **only the next live request**, not historical
  turns. There is no replay-with-edit flow.
- ❌ No A/B comparison of the same prompt under two parameter sets.

---

## 5. Roadmap, by priority

Priorities are derived from the positioning in §2, not from "biggest gap."
Items that conflict with the "transparent / I-change-nothing" stance are
demoted or removed.

### 🥇 P0 — features that reinforce the unique moat

1. **Replay & Diff** (full design in §6).
   *Why:* Combines existing assets (`versionIndex` / B2 splitter / intercept
   editor / delta chain reconstruction) into a workflow no other tool can
   produce, because no other tool has all those pieces. Directly answers pain
   #3 ("tiny prompt change → big result swing").

2. **Tool-error visual surfacing.**
   *Scope:* `is_error: true` → red left-border + ⚠ icon; session list shows
   "N errors" badge; new "errors only" filter on the timeline.
   *Why:* Pure observation, no behavior change. Directly answers pain #2's
   "errors get swallowed" complaint.
   *Files:* `public/messages.js`, `public/style.css`, `public/miller-columns.js`.

3. **Loop detector — passive alert mode only.**
   *Rules:*
   - Same `tool_use.name + JSON.stringify(input)` hash ≥ 3 times in last 5 turns.
   - Same assistant-text hash ≥ 3 times.
   - Same tool returning `is_error: true` ≥ 3 consecutive times.
   *Behavior:* highlight + dashboard banner + SSE event. **Never auto-pause,
   never cancel requests.** The user decides.
   *Why:* Detection fits "Wireshark." Auto-blocking would break transparency.
   *New file:* `server/loop-detect.js`. Hook from `forward.js` after each entry.

### 🥈 P1 — extending observability

4. **Claim ↔ tool-result linker.**
   *Scope:* `public/messages.js` post-render: scan assistant text for URLs,
   numbers, file paths. Match against the preceding `tool_result`. Mark green
   if matched, yellow if unmatched. No server change.

5. **Cost burn-rate prominence (still display-only).**
   *Scope:* topbar shows projected monthly spend at current rate, color-graded.
   `cost-budget.js` already computes this; just lift it into the UI.

6. **Switch entry IDs to W3C trace ID format.**
   *Scope:* 16-byte hex IDs alongside the existing timestamp string.
   *Why:* Forward compatibility for the `claude-code-otel` integration in §7.
   No external integration is built yet, but the change is cheap and unblocks it
   later. Keep timestamp as `entry.createdAt` for sortability and readability.
   *File:* `server/helpers.js:7-12`, plus migrations in any code that parses IDs.

### 🥉 P2 — opt-in, off by default

7. **PII redaction (opt-in via `CCXRAY_REDACT=on`).**
   *Why opt-in:* `ccxray` is for **debugging**, where you want full fidelity.
   Redaction matters when sharing logs externally. Default off preserves the
   debug-tool stance.
   *Scope:* `server/forward.js` writes `_req.json` through a redactor:
   `sk-ant-*`, bearer tokens, emails, Luhn-validated card numbers.

### ❌ Removed from the roadmap

- ~~OTel / OTLP exporter~~ — see §3.
- ~~Hard cost cap enforcement (request cancellation)~~ — see §3 and §2 ("transparent" promise).
- ~~Auto-pause on tool error~~ — same reason.
- ~~Multi-account routing~~ — `ccflare`'s territory.
- ~~Aggregated team dashboards~~ — `claude-code-otel`'s territory.

---

## 6. Killer feature: Replay & Diff

### 6.1 What it looks like when done

**Entry point.** Every turn detail page gains a "Replay" button.

**Workspace.** Two columns (Original | Variant).
- Left: historical turn loaded via `loadEntryReqRes()` (`server/restore.js:23-79`),
  which resolves the delta chain.
- Right: editable copy. Same affordances as the current intercept editor
  (`public/intercept-ui.js:92-142`): per-message textareas, system textarea,
  tool checkboxes, model dropdown, raw-JSON tab. Add `temperature`, `top_p`,
  `max_tokens` controls.

**Send.** Confirmation dialog: "This will cost ≈ $X, billed to your current
Anthropic key." On confirm: `POST /_api/replay/:entryId/send` with the edited
body. Server builds a synthetic `ctx` and calls `forwardRequest(ctx)`
(`server/forward.js:289`). The new entry is stamped
`{ isReplay: true, replayOf: entryId, replayKeyThumb: 'abc123' }`.

**Watch.** Variant streams in via SSE, routed to the replay tab via a new
`_replayClientId` field on the broadcast (`server/sse-broadcast.js:6-35`).

**Diff.** Three tabs:
- *Response text* — reuse `computeUnifiedDiff()` (`server/system-prompt.js:142-207`).
- *Tool calls* — align by tool name, diff `input` JSON.
- *Metrics* — table: input/output tokens, cost, latency, `stop_reason`, cache hit.

### 6.2 Hard limitations (must be surfaced in the UI, not hidden)

| # | Limitation | Why it cannot be solved |
|---|---|---|
| L1 | **Replay can only run one round.** If the response contains `tool_use`, the conversation cannot continue. | ccxray does NOT execute tools (`forward.js:383-918` has zero tool-execution logic — it's a proxy, not an agent runtime). Solving this would turn ccxray into an agent runtime, breaking §2. |
| L2 | **Replay bills to the current dashboard user, not the original turn's account.** | `_req.json` does not store the `Authorization` header (`server/index.js:357`). Headers are stripped after forwarding. |
| L3 | **Replay context may be incomplete if the delta chain is pruned.** | `restore.js:48` silently degrades to delta-only when `prevId` has been evicted. |

UI must show:
- L1 → banner on responses containing `tool_use`: "ccxray cannot execute these tools. To continue, manually add `tool_result` blocks and replay again."
- L2 → before-send dialog calls out the billing account (key thumbprint).
- L3 → on workspace open, check chain integrity and warn before allowing edits.

### 6.3 Implementation blockers (must be solved in code)

| # | Blocker | Resolution |
|---|---|---|
| B1 | Synthetic `ctx` builder | New helper that fills `parsedBody`, `rawBody` (re-serialized), `fwdHeaders` (inject current user key), `reqSessionId = replay:<originalId>:<seq>`, `upstream`. |
| B2 | SSE routing — replays must not pollute live session views | Add `_replay` + `_replayClientId` fields; modify `summarizeEntry()` (`sse-broadcast.js:6-35`); frontend filters `entry.isReplay !== true` from normal session aggregations. |
| B3 | Cost / entry isolation | New entry fields `isReplay`, `replayOf`, `replayKeyThumb`. `cost-budget.js` excludes `isReplay` entries from session totals. Index NDJSON still records them (audit trail). |
| B4 | API-key source for replay | MVP: `ANTHROPIC_API_KEY` env var read by ccxray at replay time. Later: dashboard sessionStorage key entry (never persisted to disk). |
| B5 | Generic diff renderer | Wrap `computeUnifiedDiff()` with `computeMessageDiff(msgsA, msgsB)` and `computeToolCallDiff(callsA, callsB)`. Metrics diff is a pure table, no diff library needed. |
| B6 | Cost pre-estimate | Use existing tokenization (`server/helpers.js`) and `pricing.js` rates. Show `input × rate` plus `max_tokens × output_rate` as upper bound. |

### 6.4 Suggested MVP cut (≈ 1 week)

- ✅ Replay button on turn detail.
- ✅ Single Variant (no A/B/C multi-variant yet).
- ✅ Reuse intercept editor as-is.
- ✅ `POST /_api/replay/:entryId/send` + synthetic `ctx`.
- ✅ Entry tagged with `isReplay`.
- ✅ SSE routing via `_replayClientId`.
- ✅ Response-text diff only (defer tool-calls and metrics diffs to v2).
- ✅ All three L1/L2/L3 banners visible.
- ✅ Replay key from `ANTHROPIC_API_KEY` env.

This already demonstrates the killer scenario: "tweak the system prompt by one
sentence, replay, see how the response shifts." That is enough to ship.

### 6.5 Permanent non-goals (don't slip into these)

- Auto-execute tools during replay — turns ccxray into an agent runtime.
- Multi-turn replay — same reason; cannot be solved without L1 going away.
- Automated prompt-improvement suggestions — turns ccxray into a prompt-eval
  platform, off-positioning.

---

## 7. Integration: `claude-code-otel` → `ccxray` drill-down

### 7.1 Vision

> A user sees an anomaly on a Grafana dashboard powered by `claude-code-otel`.
> Clicks a panel link. Lands directly on the offending turn(s) in `ccxray`.

This is the natural pairing established in §3. The roadmap commits to it
**only for the personal-developer case** (Grafana and ccxray on the same
machine). Team / cross-machine integration is explicitly out of scope (§7.5).

### 7.2 Gaps inventory

| # | Category | Gap | Owner |
|---|---|---|---|
| A1 | Identity | No shared trace ID. ccxray uses timestamp strings; OTel uses W3C 16-byte hex. | ccxray |
| A2 | Identity | ccxray neither captures nor stores `traceparent` from incoming requests. Hop-by-hop denylist (`server/index.js:112-136`) does not preserve them. | ccxray |
| A3 | Identity | No per-entry user identity. Only `session_id` and `cwd`. `claude-code-otel` exposes per-user metrics; there is no key to join them. | ccxray (capture API key thumbprint) |
| A4 | Identity (fallback) | If `traceparent` is unavailable, the only shared key would be `session_id` + timestamp window. | OK as-is, but verify the OTel side emits the same `session_id`. |
| B1 | Topology | ccxray binds to localhost only (`server/index.js:647`). | ccxray (opt-in 0.0.0.0 mode + auth) |
| B2 | Topology | Hub mode is per-machine; no cross-machine concept. | Out of scope |
| B3 | Topology | Cross-machine pivot needs reverse proxy / VPN / per-user auth. | Out of scope |
| C1 | Privacy | OTel default = no prompt content. ccxray = full content. Pivot crosses a privacy boundary silently. | Document; consider `CCXRAY_REDACT` (P2 in §5). |
| C2 | Coverage | OTel sees anyone with `CLAUDE_CODE_ENABLE_TELEMETRY=1`; ccxray sees only those with `ANTHROPIC_BASE_URL=ccxray`. The Venn intersection determines drill-down success. | Document. |
| C3 | Semantics | OTel "session" vs ccxray "entry" / "turn" — one Grafana number = many ccxray entries. | UX: link to a filtered entry list, not a single entry. |
| D1 | Retention | ccxray default 14 days (`config.js:172`); Prometheus typically longer. Old Grafana panels will pivot to nothing. | Document; consider raising default later. |
| D2 | Query | No time-range / cost / sessionId filter API. `/_api/entries` is in-memory full dump. | ccxray (add `/_api/entries/query`) |
| E1 | UX | ✅ Deep linking already works (`miller-columns.js:310-364`): `?target=turn&e=<id>` and `?s=<sessionId>&t=<displayNum>`. | Done. |
| E2 | UX | No Grafana dashboard JSON template that knows how to construct the ccxray URL. | `claude-code-otel` side (not ccxray's repo) |
| F1 | Privacy | AUTH_TOKEN is all-or-nothing. No field-level access control. | Out of scope for personal mode. |

### 7.3 Pre-work: a one-hour experiment that gates the roadmap

**Before writing any integration code**, run this:

1. Set `CLAUDE_CODE_ENABLE_TELEMETRY=1` and the OTLP env vars per
   `claude-code-otel`'s setup.
2. Set `ANTHROPIC_BASE_URL=http://localhost:5577` to route through ccxray.
3. Run a Claude Code prompt.
4. In ccxray's `forward.js`, log every incoming request header.
5. Verify:
   - Does the request carry `traceparent`? (OTel HTTP auto-instrumentation
     **usually** injects it, but Claude Code's specific implementation is
     unverified.)
   - Does the OTel span emitted to the Collector carry the **same**
     `session.id` that ccxray captures from `metadata.session_id`?

Outcomes:
- ✅ `traceparent` present → trivial integration: just capture and store.
- ❌ `traceparent` absent → either file an upstream feature request to
  Anthropic, or commit to the `(session_id, time-window)` join (works at
  session granularity, not turn granularity).

This experiment **must be done first.** The result determines whether A1/A2
are easy wins or require upstream changes.

### 7.4 Personal-developer MVP (1–2 days, after the experiment)

1. **Capture trace ID** (if A2 verifies positive): parse `traceparent` in
   `server/index.js`; store the 16-byte trace ID on the entry; include in SSE
   summary.
2. **Capture API-key thumbprint**: SHA-256 of the `Authorization` header,
   first 8 hex chars; never store the key itself.
3. **Add query endpoint**: `GET /_api/entries/query?since=...&until=...&sessionId=...&traceId=...`.
   Filter the in-memory `entries[]`. No storage change.
4. **Switch entry IDs to W3C trace ID format** (P1 #6 in §5): unifies the ID
   space so an OTel `trace_id` *is* a ccxray entry ID when traceparent flows
   through.
5. **Provide a Grafana data-link snippet** (lives in `claude-code-otel`'s repo
   or a doc here) showing how to build the ccxray URL from a span's
   `trace_id` / `session.id` / time range.

After this MVP, a Grafana panel can link directly to `ccxray` for any user who
runs both tools locally.

### 7.5 Explicit non-goals for this integration

- **Team / cross-machine drill-down.** Requires reverse proxy, per-user auth,
  field-level privacy, audit logging. Each of those pulls ccxray toward
  enterprise-observability competitors (Datadog, Honeycomb). **Do not go there.**
- **Centralized ccxray instance for a team.** Same reason.
- **Forwarding ccxray's own data into Grafana / Loki.** That's the OTel
  exporter we already removed from the roadmap (§3). The integration is
  one-way: Grafana clicks → ccxray opens.

---

## 8. Cautions & invariants for future contributors

These are the rules that keep ccxray on-positioning. Violating any of them
should require an explicit change to this document first.

1. **Transparent first.** ccxray must not silently change request behavior.
   Inspection ✅, automatic blocking ❌. Even cost overruns. The user pulls the
   trigger; ccxray only loads the gun.
2. **Zero runtime dependencies.** Adding any `dependencies` (not
   `devDependencies`) to `package.json` requires justification. The bar is
   high: the value must be unique to ccxray's wire-level role, not duplicated
   from `claude-code-otel`.
3. **Claude-Code-aware, not generic.** Features that don't leverage ccxray's
   internal knowledge (`cc_version`, B2 splitting, subagent inference, delta
   chains) belong in a generic LLM proxy, not here.
4. **Local by default.** Listening on 0.0.0.0 is opt-in and must come with
   forced auth. Personal-developer is the canonical user.
5. **Never compete with `claude-code-otel`.** They handle aggregation, trends,
   teams. ccxray handles individual turns. If a feature could equally live in
   either, it belongs in `claude-code-otel`.
6. **Replay is one-shot.** ccxray is not an agent runtime. Tool execution
   stays out forever.
7. **Prompt content fidelity is a feature, not a bug.** Redaction is opt-in.
   Debugging tools must show what actually happened.

---

## 9. Sequenced action list (for planning)

Approximate order. Each item is independent enough to ship on its own.

| Step | Item | Effort | Dependency |
|---|---|---|---|
| 1 | Tool-error visual surfacing (P0 #2) | half day | none |
| 2 | Loop detector, passive alert (P0 #3) | 1 day | none |
| 3 | Run the OTel handshake experiment (§7.3) | 1 hour | none |
| 4 | Switch entry IDs to W3C trace ID format (P1 #6) | half day | none, but unblocks 5–7 |
| 5 | Capture `traceparent` and key thumbprint (§7.4 #1, #2) | half day | step 3 outcome |
| 6 | Add `/_api/entries/query` (§7.4 #3) | half day | step 4 |
| 7 | Document Grafana data-link template (§7.4 #5) | half day | steps 4–6 |
| 8 | Replay & Diff MVP (§6.4) | 5–7 days | none, but ideally after step 1 (so error visualization is in place for replays) |
| 9 | Claim ↔ tool-result linker (P1 #4) | 1 day | none |
| 10 | Cost burn-rate prominence (P1 #5) | half day | none |
| 11 | PII redaction, opt-in (P2 #7) | 1 day | none |

Total ≈ 12–15 working days for everything above. Steps 1–3 can be done in any
order in the first week; step 8 (Replay) is the headline shippable.

---

## Appendix A: source map for re-reading

If revising this document, the underlying code references are:

- Positioning evidence: `README.md`, `CLAUDE.md`, `server/forward.js`,
  `server/system-prompt.js`, `server/hub.js`.
- Pain-point audit: `server/forward.js:383-918`, `server/store.js:34`,
  `server/cost-budget.js`, `public/messages.js:5-49,173-211,247,721,725`,
  `server/restore.js:23-79`, `server/system-prompt.js:36-37,125-207`,
  `server/routes/intercept.js:9-87`, `public/intercept-ui.js:92-142`.
- Replay design: `server/forward.js:289` (forwardRequest), `server/index.js:357`
  (req.json contents), `server/sse-broadcast.js:6-42`,
  `server/restore.js:23-79`, `public/intercept-ui.js:92-142`.
- Integration gaps: `server/helpers.js:7-12`, `server/index.js:112-136,357,647`,
  `server/store.js`, `server/routes/api.js:36-234`, `server/auth.js:16`,
  `server/config.js:4,169-174`, `public/miller-columns.js:310-364,575-589`.

## Appendix B: dropped ideas with reasons

For posterity — these were considered and rejected.

- **Hard per-session token / dollar cap with request cancellation.** Breaks
  "transparent." Belongs to a gateway (Kong, agentgateway). Use Anthropic's
  account-level alerts or `claude-code-otel` Grafana alerts instead.
- **Auto-pause when a tool returns error.** Same as above. Loop detector flags
  it; a human decides.
- **OTel exporter from ccxray.** Duplicates `claude-code-otel`'s job.
- **Tool execution during replay.** Turns ccxray into an agent runtime.
- **Multi-turn replay.** Cannot be solved without tool execution.
- **Aggregated team dashboards.** `claude-code-otel` and friends already do
  this better.
- **Centralized ccxray for a team.** Pulls into enterprise-observability
  competition (Datadog / Honeycomb / LangSmith).

---

*End of document.*
