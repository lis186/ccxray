# Weather evidence audit: provider-by-provider + scoring redesign

Ref #487 — diagnostic output. All findings verified against real corpus
(277,748 entries / 4,223 sessions) and synthetic unit exercises.

## 1. Provider-by-provider evidence audit

### 1a. Anthropic (`ccxray claude`)

**Write pipeline verified** (post-#498):
- `turnToolCallIds`: extracted from SSE `content_block_start` events (type=tool_use)
  and non-SSE response `content[]` blocks. Written at `forward.js:780` (SSE) and
  `:1083` (non-SSE). Shape: `{ "toolu_01X": "Bash", "toolu_01Y": "Read" }`.
- `turnToolResults`: extracted from the request's last user message
  (`extractAnthropicTurnToolResults`, `helpers.js:692`). Shape:
  `[{ callId, toolFail: bool, eligible: true }]`. All Anthropic results have
  explicit `is_error`, so `eligible ≡ known` — no "undecoded" state.
- `turnToolFail`: tri-state from `hasToolFailLastTurn` (`helpers.js:671`). Correctly
  distinguishes `true` (failure), `false` (checked-clean), `undefined` (no tool_result).

**Four exit shapes** (all verified):

| Shape | `turnToolResults[].toolFail` | `eligible` |
|-------|------------------------------|------------|
| exit 42 | `true` | `true` |
| exit 127 | `true` | `true` |
| exit 1 | `true` | `true` |
| exit 0 | `false` | `true` |

**Corpus state**: 0/245,934 Anthropic entries have `turnToolCallIds` or
`turnToolResults` — #498 merged today (2026-08-10), no production traffic yet.
41,917 entries (17%) have `turnToolFail` (from #438, which predates #486).

### 1b. Codex (`ccxray codex`)

**Write pipeline verified** (post-#485):
- `turnToolCallIds`: extracted from response events via `extractOpenAIToolCallIds`
  (`helpers.js:881`). Written inside `buildEntryFields` (`openai.js:324`).
- `turnToolResults`: extracted from input via `extractOpenAITurnToolResults`
  (`helpers.js:924`). Decoder dispatch: `codex:custom_tool_call_output` and
  `codex:function_call_output` both route to `decodeCodexToolOutput`.
- Three payload shapes handled:
  - `input_text` envelope with JSON `{ exit_code: N }` (primary)
  - D3 bare `{ exit_code: N }` array elements
  - D2 async start sentinel: `"Script running..."` → `eligible: false`

**Four exit shapes** (verified + D2/D3 edge cases):

| Shape | `toolFail` | `eligible` |
|-------|------------|------------|
| exit 42 (input_text envelope) | `true` | `true` |
| exit 127 | `true` | `true` |
| exit 1 | `true` | `true` |
| exit 0 | `false` | `true` |
| D3 bare exit_code | `true` | `true` |
| async start sentinel | `undefined` | `false` |
| non-JSON text | `undefined` | `true` |
| function_call_output exit 42 | `true` | `true` |

**Corpus state**: 31,813 OpenAI entries (codex: 31,804, grok: 9). Zero entries
have any of `turnToolCallIds`, `turnToolResults`, or `turnToolFail`.

### 1c. Grok (`ccxray grok`)

**Write pipeline verified** (post-#485):
- Decoder dispatch: `grok:function_call_output` → `decodeGrokToolOutput`
  (`helpers.js:1010`).
- Footer priority: last non-empty line `EXIT_CODE[=:]N`, fallback to first line
  `exit: N`.

**Four exit shapes** (verified):

| Shape | `toolFail` | `eligible` |
|-------|------------|------------|
| EXIT_CODE=42 (footer) | `true` | `true` |
| EXIT_CODE=127 | `true` | `true` |
| EXIT_CODE=1 | `true` | `true` |
| EXIT_CODE=0 | `false` | `true` |
| exit: 42 (header) | `true` | `true` |
| no exit code | `undefined` | `true` |
| EXIT_CODE:1 (colon variant) | `true` | `true` |

**Corpus state**: 9 grok entries (test residual). No production Grok traffic.

### 1d. Cross-provider: `_openAIToolEvidence` is now provider-agnostic

**Critical finding**: `_openAIToolEvidence` (weather.js:84) reads `turnToolCallIds`
and `turnToolResults` without checking `provider`. Post-#486/#498, Anthropic entries
write both fields, so they silently flow into the "OpenAI" evidence pipeline.

This is **not a bug** — it's the desired migration target. But it creates a
dual-evaluation period where the same Anthropic session is scored by BOTH:
- The old path: `stopReason === 'tool_use'` + cumulative `toolFail` (Anthropic branches
  in `sigStuck`, `sigErrorCluster`, `sigErrorCumulative`)
- The new path: paired `turnToolCallIds` ↔ `turnToolResults` join (via `_openAIToolEvidence`)

`_strongerToolSignal` picks the HIGHER severity between the two paths.

## 2. Importer coverage audit

### 2a. Claude Code transcripts (`~/.claude*/projects/**/*.jsonl`)

**Scale**: 20,808 files, 2,033,293 lines.

**Available evidence** (full-corpus scan):
- `tool_result` blocks: 424,504 (100% have `tool_use_id` — perfect call-id linkage)
- `is_error` key present: 220,367 (52%)
  - `true`: 19,002 (8.6% of keyed)
  - `false`: 201,365
- `is_error` absent: 204,137 (48% — pre-`is_error` era entries)
- Assistant `tool_use` blocks: 424,436 (100% have `id` and `name`)
- `isSidechain`: present on all user/assistant lines; 519,277 `true` — usable for
  subagent detection

**Not available** (structural gaps):
- System prompt: 0/2,033,293 lines → `coreHash`, `agentKey`, `agentLabel`, `sysHash`,
  `toolsHash` all structurally impossible
- `parentToolUseID`: not present as a top-level key (the issue's 42,740 figure may
  refer to processed data in the index, not raw transcripts)

**Current importer** (`server/importer.js:119-201`): reads `msg.stop_reason`,
`msg.usage`, `msg.model`, `msg.id` (responseId). Does NOT extract:
- `tool_result.is_error` → no `toolFail`, no `turnToolFail`
- `tool_use` content blocks → no `turnToolCallIds`
- `tool_result` content blocks → no `turnToolResults`
- Any tool call counts → no `toolCalls`

**Gap**: the source data HAS the evidence. The importer can produce `turnToolCallIds`
(from assistant `tool_use` blocks) + `turnToolResults` (from `tool_result.is_error`).
The 48% without `is_error` map to `eligible: true, toolFail: undefined`.

### 2b. Codex transcripts (`~/.codex*/sessions/**/*.jsonl`)

**Scale**: 2,656 files. Line types: response_item=132,137, event_msg=85,033,
turn_context=4,192, session_meta=3,342.

**Available evidence** (full scan):
- `function_call` items: 23,733 (all have `call_id` and `name`)
- `function_call_output` items: 23,717 (all have `call_id`)
  - With parseable exit code: 18,313 (77%)
  - Without: 5,340 (23% — images, aborts, async starts)
- `custom_tool_call` items: 11,848 (all have `call_id`)
- `custom_tool_call_output` items: 11,846 (all have `call_id`)
- Exit code distribution: 0=16,959, 1=1,087, 127=60, 128=38, others=233

**Current importer** (`server/importer.js:208-278`): reads only `token_count` events
for usage data. Zero tool fields extracted.

**Gap**: 77% of Codex tool outputs have parseable exit codes. The importer can
produce `turnToolCallIds` + `turnToolResults` using the same `decodeCodexToolOutput`
decoder the proxy uses.

### 2c. Grok transcripts (`~/.grok/sessions/`)

**Scale**: 91 JSONL files across 10 workspace directories. Multiple files per
session: `chat_history.jsonl`, `events.jsonl`, `updates.jsonl`, `system_prompt.txt`.

**Available evidence** (from `chat_history.jsonl`):
- `tool_result` lines: 315 (100% have `tool_call_id`)
  - With exit code: 92 (29%)
  - Without: 223 (71% — file reads, workspace listings, tool errors)
- `system_prompt.txt` exists — unlike Claude, Grok persists its system prompt,
  so `coreHash`/`agentKey` could theoretically be derived

**Importer**: none exists. `discoverHomes` only scans `.claude*` and `.codex*`.

**Gap**: small corpus (315 results), 29% exit-code coverage. Low priority — almost
entirely test traffic from ccxray verification sessions.

## 3. Provider difference analysis

### 3a. `_strongerToolSignal` evidenceCount asymmetry

The Anthropic path counts `stopReason === 'tool_use'` turns as evidence (ALL tools).
The paired path counts only Bash tool results matched by call ID.

| Dimension | Anthropic old path | Paired new path |
|-----------|-------------------|-----------------|
| Denominator | All `tool_use` turns | Matched Bash results only |
| Numerator | `toolFail === true` (cumulative!) | `toolFail === true` (per-call) |
| Scope | All tools | Bash only |
| Accuracy | Contaminated by cumulative semantics | Correct per-call |

**Measured impact**: in a session with 15 tool turns and 1 actual failure:
- Anthropic path: 5/15 = 33% → severity 0.83 (cumulative `toolFail` persists)
- Paired path: 1/15 = 6.7% → severity 0.17

`_strongerToolSignal` picks the contaminated 0.83 because it's higher.

### 3b. Anthropic `eligible ≡ known`

For Anthropic, `is_error` is always explicit. `extractAnthropicTurnToolResults`
always returns `eligible: true`. Therefore `eligible === known` — the
`sigToolFailure` `unavailable` state is unreachable for Anthropic sessions
(except when zero Bash tool calls exist).

For OpenAI/Codex/Grok, `eligible ⊇ known` because some outputs are undecoded
(`toolFail: undefined, eligible: true`).

### 3c. Mixed sessions

A session with both Anthropic and OpenAI turns (rare but possible via provider
switching) runs both old and new paths. `_strongerToolSignal` picks the higher
severity regardless of which provider produced it. This is acceptable for now
since mixed sessions are extremely rare.

### 3d. `_openAIToolEvidence` receives Anthropic data silently

Post-#486, Anthropic entries carry `turnToolCallIds` and `turnToolResults`, which
`_openAIToolEvidence` consumes without a provider guard. This is the intended
migration direction but creates the dual-evaluation period described in §1d.

## 4. Scoring redesign (owner-approved 2026-08-11)

### 4a. Delete Anthropic cumulative branches, keep paired path

**Decision**: `sigStuck`, `sigErrorCluster`, `sigErrorCumulative` each have two
parallel paths — an Anthropic branch reading cumulative `toolFail` + `stopReason`,
and a paired branch reading `_openAIToolEvidence`. Delete the Anthropic branches,
keep the paired branches. This is not "retire vs rewrite" — the correct
implementation already exists; the contaminated input is the only thing to remove.

**Evidence**: corpus replay shows 100% false positive rate for the Anthropic branch
in `sigStuck` (132 sessions fire on cumulative, 0 on per-turn). The paired branch
is already correct and provider-agnostic (post-#486/#498 all three providers write
`turnToolCallIds`/`turnToolResults`).

**Effect**: with zero paired data currently, all three signals go silent
(severity 0). As production data accumulates they automatically start working
correctly on all providers, with no second decision needed.

Adversarial review: Fable chose "rewrite" (Option B), Codex chose "retire"
(Option A). Both missed that the paired path already exists inside each function —
the false dichotomy was caused by a poorly framed prompt that omitted the code
structure.

### 4b. `sigToolFailure` severity → `null`, availability preserved

**Decision**: set `sigToolFailure` severity to `null` (does not participate in
the weather score). Keep the function for its unique availability detection
(no_data / unavailable / clear / failure) which drives the `❔` weather state
and tooltip `toolKnownRate`. No other signal provides this.

The fixed 0.35 is removed. Tool failure severity is handled solely by
`sigErrorCumulative`'s proportional rate.

Adversarial review: both Fable and Codex independently chose Option 1
(severity null). Both identified the same risk: short sessions (< 10 tool turns)
become a blind spot because `sigErrorCumulative`'s ≥10 threshold doesn't fire.

### 4c. `sigErrorCumulative` threshold ≥10 → ≥5

**Decision**: lower the minimum tool-turn threshold from 10 to 5 to cover short
sessions after `sigToolFailure` stops contributing severity. Fable's proposal
(simpler than Codex's switchover-fallback alternative — one constant change vs
new conditional logic).

Statistical noise in 5-turn windows (3/5 = 60% vs 3/6 = 50%) is accepted:
the threshold is a constant that can be adjusted after the first calibration
replay with production paired data.

### 4d. Per-turn failure rate distribution (calibration data)

Corpus-wide (Anthropic, ≥10 tool turns, using `turnToolFail` at 17% coverage):
- 217 qualifying sessions
- p50: 1.9%, p75: 3.2%, p90: 4.6%
- 77% of qualifying sessions have >0% failure rate

These numbers are from the pre-#486 `turnToolFail` field. The `turnToolResults`
paired pipeline has zero production data. The `sigErrorCumulative` threshold of
`0.4` (40% → severity 1.0) was tuned against cumulative-contaminated data and
will need recalibration after paired data accumulates.

### 4e. Tooltip "0 errors" false claim

**Fix** (not blocked): when `stats.errTurns === 0 && stats.toolSignal === 'no_data'`,
display `"—"` or omit the error count entirely instead of `"0 errors"`.

### 4f. `turnToolFail` — keep on write path

`turnToolFail` has zero consumers in `weather.js`. `entry-rendering.js` accumulates
it as `sess.toolFailTurns` for per-turn badge rendering. Keep on the write path as
a convenience boolean; do not add to weather — the paired pipeline is strictly more
informative.

## 5. Toggle-ON criteria (#484)

### 5a. Prerequisites (must-fix before toggle)

1. **Delete Anthropic cumulative branches** from `sigStuck`/`sigErrorCluster`/
   `sigErrorCumulative` (§4a).
2. **`sigToolFailure` severity → `null`** (§4b).
3. **`sigErrorCumulative` threshold → ≥5** (§4c).
4. **Fix tooltip "0 errors"** (§4e).

### 5b. Calibration replay script

A streaming replay script is a deliverable of the implementation PR:

```
node scripts/replay-tool-signal.js [--index PATH] [--provider anthropic|openai]
```

- Streams `index.ndjson`, groups by sessionId
- Runs `assessWeather(turns)` per session
- Reports: level distribution, `sigToolFailure` availability, per-turn failure
  rate distribution (p25/p50/p75/p90)
- Outputs `ready` / `not ready` based on data sufficiency (see §5c)

### 5c. Toggle-ON decision gate — data-driven, not fixed threshold

No fixed session count. The calibration replay script determines readiness:

```
replay → if sessions with ≥5 tool turns ≥ 100
       → AND degraded samples (failure rate > 10%) ≥ 20
       → output "ready" + distribution chart
       → otherwise "not ready, N sessions, M degraded samples"
```

Existing corpus already has 1,188 sessions with ≥5 tool turns (99 in the 5–9
range, 1,089 with ≥10). Once paired data starts flowing, the first replay run
determines whether the distribution is bimodal (healthy vs degraded separable).
If not, wait one week and re-run.

Additional gate checks:
- `sigToolFailure` `no_data` rate < 50%
- Tooltip accurately represents measurement state

## Follow-up issues (at least two)

### Issue 1: weather.js read-side migration

Delete Anthropic cumulative branches in `sigStuck`/`sigErrorCluster`/
`sigErrorCumulative` (the paired path is already implemented). Also:
- `sigToolFailure` severity → `null`
- `sigErrorCumulative` threshold ≥10 → ≥5
- Tooltip "0 errors" → "—" when below measurement threshold
- Calibration replay script as deliverable

### Issue 2: importer tool-failure evidence

Extract tool evidence from source transcripts to produce `turnToolCallIds`/
`turnToolResults` matching the #486 shape. Three providers:

**Claude** (highest ROI):
- 424,504 `tool_result` blocks with perfect call-id linkage
- 220,367 have explicit `is_error` (52%); 19,002 failures
- Extract `tool_use.id`/`name` from assistant blocks → `turnToolCallIds`
- Extract `tool_result.is_error` + `tool_use_id` → `turnToolResults`

**Codex** (medium ROI):
- 35,563 tool call/output pairs with call-id linkage
- 77% have parseable exit codes (same decoder as proxy)
- Extract `function_call`/`custom_tool_call` → `turnToolCallIds`
- Extract output items → `turnToolResults` via `decodeCodexToolOutput`

**Grok** (low ROI — defer):
- 315 `tool_result` lines, 29% with exit codes, mostly test traffic
- No importer exists; adding one for 91 files is low priority

## Appendix: corpus replay raw numbers

- Total: 277,748 entries, 4,223 sessions
- Anthropic: 245,934 entries, 2,323 sessions
- OpenAI: 31,813 entries, 1,900 sessions (codex 31,804, grok 9)
- `turnToolCallIds` present: 0 entries (pre-production)
- `turnToolResults` present: 0 entries (pre-production)
- `turnToolFail` present: 41,917 entries (17% of Anthropic)
- Cumulative `toolFail` infection: 170/2,323 Anthropic sessions
  - Infected turns: 27,905 (26,443 cumulative-only, never per-turn true)
  - Per-turn `turnToolFail=true`: 1,451 (3.5% of infected total)
- sigStuck false positives (cumulative ≥10): 132 sessions → per-turn: 0
- sigErrorCumulative severity>0 (cumulative): 160 sessions
- sigErrorCumulative severity>0 (per-turn): 167 sessions
- Weather levels: sunny 3,950, stormy 142, fair 102, cloudy 19, rainy 10
- sigToolFailure: 100% `no_data` (paired fields empty)
