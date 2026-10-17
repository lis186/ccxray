# Codex importer response ID investigation (#508)

2026-10-17 — stopped at the task's no-shared-ID boundary; no importer change.

## Evidence

`parseCodexSessionFile` in `server/importer.js` creates entries from
`event_msg.payload.type = token_count`, using `info.last_token_usage`.
The upstream [0.133 protocol schema](https://github.com/openai/codex/blob/rust-v0.133.0/codex-rs/protocol/src/protocol.rs)
defines `TokenCountEvent` with only `info` and `rate_limits`; `TokenUsageInfo`
contains cumulative usage, last usage and context window, without a response ID.
`RolloutItem` has no `response.completed` variant. The wire event and the saved
rollout are different formats.

The [0.133 response-item schema](https://github.com/openai/codex/blob/rust-v0.133.0/codex-rs/protocol/src/models.rs)
also marks message/reasoning IDs `skip_serializing`. Even when an item ID is
available, it identifies an output item, not its enclosing upstream response.
Tool `call_id`, session ID and user `turn_id` are likewise not response IDs;
one user turn can require multiple upstream responses.

The [0.145 protocol schema](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/protocol/src/protocol.rs)
does define `RawResponseCompletedEvent { response_id, token_usage }`.
However, its [rollout persistence policy](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/rollout/src/policy.rs)
explicitly returns **false** for `EventMsg::RawResponseCompleted`, while
persisting `EventMsg::TokenCount`. A streamed event's existence therefore does
not establish its presence in session JSONL. These findings are version-bounded,
not a claim about every later Codex release or custom transcript producer.

In ccxray, `server/ws-proxy.js` retains response events in response logs but
does not set the entry's `responseId`; the OpenAI HTTP paths are also exempt
from response-ID merging (ADR 0012). Fixing the importer alone would not
connect the current WS entry to the shared merge.

## Options

1. Persist the actual upstream response ID and its exact per-response usage in
   Codex rollouts upstream, then add version-specific synthetic fixtures and
   importer parsing once that persisted format is verified. Separately expose
   the same response ID on proxy entries.
2. Support a verified later/custom rollout format that already persists this
   information, with an explicit version boundary and tests for association
   with the correct usage record. No such format was established here.
3. For older rollouts, timestamp/content matching would require a separately
   designed heuristic and collision policy. It is outside this task; do not
   substitute item, tool-call, session or user-turn IDs for `responseId`.

No real user sessions were inspected or copied. No synthetic success fixture
was invented for an unverified persisted format. Runtime code, fixtures and
existing no-ID behavior remain unchanged; no bug-fix claim or old-fail/new-pass
claim is made.
