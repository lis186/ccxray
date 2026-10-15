# `ccxray agentflow report`

Tokens, cost and time for every Ask of an [agentflow](https://github.com/agfnow/agentflow) notebook. Experimental.

agentflow records a project's work as rounds in a notebook (`.agentflow/devlog.md`): an Ask, then a Reply. This command tells you what each round cost: which models ran, at what reasoning effort, for how long, and at what price, split by the host session, its subagents and any external workers it dispatched.

The design, with every attribution rule, is in [`agentflow-integration.md`](agentflow-integration.md). This page covers using it.

## Quick start

```bash
cd my-project                        # a checkout with an agentflow notebook
ccxray claude                        # work through the proxy as usual
ccxray import --once                 # bring transcripts into the index
ccxray agentflow report              # every Ask of the default notebook
ccxray agentflow report --ask A-012  # one Ask
ccxray agentflow report --json       # the same data as JSON
ccxray agentflow report --notebook .agentflow/features/auth/auth.devlog.md
```

Without `--notebook`, the report reads `ag.json`'s `target-doc` (inside its `workspace-dir`), else `.agentflow/devlog.md`. The checkout is the Git worktree holding the notebook, else the nearest folder with an `ag.json`.

## What you need

- **An agentflow notebook.** Each Reply's stamp line (`* _2026-10-14 09:14:40 +0000 (…)_`) ends its Ask; an Ask with no Reply yet runs to now.
- **Transcripts on this machine.** The report reads Claude Code and Codex transcripts from the same homes `ccxray import` uses.
- **The proxy, for complete figures.** Without it the report still works, but some requests never reach a transcript. Claude Code's prompt suggestions and title generation are billed, yet only the proxy sees them. In one measured interactive session the transcripts alone came out 11.7% low. Run your sessions through `ccxray claude` / `ccxray codex` for complete figures.
- **Fresh imports.** The report does not import anything itself and starts no server. Run `ccxray import --once`, or keep a hub running, before reporting; `import --once` skips if it ran in the last 10 minutes unless given `--force`. Transcript turns not yet imported are counted in a `not yet imported` label.

## Reading the report

```
## A-012 · complete · 16m35s · $0.177 · 11 calls · in 7.2k · out 5.6k · cache read 295.0k / write 12.3k (read share 94%)
attribution: unique $0.177
- host · prompt-match · unique · complete · claude-opus-5-5×6, claude-sonnet-5×2 · effort high · 13m40s (duration estimated) · $0.144 · 8 calls
  - subagent general-purpose · claude-sonnet-5 · effort high · 30s (duration estimated) · $0.018 · 2 calls
  unmatched owner submissions: 0 · follow-up submissions: 0 (—)
- external review · dispatch · unique · complete · claude-sonnet-5 · effort low · 3m30s (duration estimated) · $0.033 · 3 calls (requested claude-sonnet-5 low)
```

**The Ask line** gives the completeness label, the Ask's wall time (from the owner's prompt to the Reply stamp, plus 2 minutes for wrap-up turns), cost, model calls and tokens. "Read share" is cache-read tokens over all input tokens.

**One row per executor.** Each row reads: kind, evidence, status, completeness, models, effort, time, cost, calls.

- `host`: the interactive session you talked to. Its cost includes its native subagents, which are indented under it.
- `external <role>`: a worker started by agentflow's external runner (`claude -p`, `codex exec`). The role comes from its dispatch record, and `(requested …)` shows the model and effort the dispatch asked for.
- Executor time is measured turn time when the transcript has it, otherwise first to last turn, marked `duration estimated`.

### Completeness: was the usage captured?

| Label | Meaning |
|---|---|
| `complete` | Every transcript turn has a proxy copy, so the proxy saw this traffic, including requests no transcript records. |
| `partial proxy coverage` | Some turns went through the proxy and some did not. |
| `transcripts only` | No proxy copy. For an interactive host the cost is a lower bound. |
| `unknown` | No host session for this Ask on this machine. |

Hosts and workers are labelled the same way. An Ask is `complete` only when every host of it is.

### Attribution: was it filed under the right Ask?

| Status | Meaning |
|---|---|
| `unique` | The usage belongs to this Ask alone. Only `unique` cost is added to the Ask's total. |
| `ambiguous` | It could belong to several Asks or notebooks. Listed with its own subtotal, never added. |
| `unassigned` | The notebook is known but the Ask is not. Listed per notebook, never added. |

The evidence column says how the row was tied to the Ask: `prompt-match` (the owner's prompt in the transcript matches the Ask), `dispatch` or `completion` (an agentflow record names the worker's clone), `launch-chain` (the host's tool call started the worker), or `window` (time alone).

### Other labels

- `unmeasured`: no turns found for the Ask.
- `estimated start`: the Ask's prompt was not found in a transcript, so its start is estimated.
- `no local evidence`: the Ask ran on another machine.
- `not yet imported: n turns`: run `ccxray import --once` and report again.
- `unmatched bullets` / `unmatched owner submissions`: prompts in the notebook with no matching transcript message, or the reverse. Claude Code background-task notices recorded as bullets by agentflow's hook show up here too.
- A `+` after a cost: some calls had no price, so the cost is a lower bound. A `~` marks a cost partly estimated from fallback rates.

### Footer

The footer lists the data sources per provider, and says the figures are recomputed from data still on disk and cover this machine only. It also counts external runs it could not place in this report.

## What stays out

The report and `--json` carry only Ask ids, executor kinds, roles, models, effort, times, tokens, costs, call counts and labels. They never contain prompts, Ask text, tool arguments, transcript content or absolute paths.

## Limits

- **Figures change as data ages.** Proxy records are pruned after 14 days (`LOG_RETENTION_DAYS`), so an older Ask drops from `complete` to `transcripts only`. Claude Code deletes transcripts after 30 days by default. Saved snapshots are planned.
- **This machine only.** Rounds worked on another machine show `no local evidence`.
- **Codex** turns carry no response id, so each Codex session is read from one source: the proxy if it saw the session, otherwise the import.
- **A Codex worker started with `--ephemeral`** writes no transcript. Unless its requests went through the proxy, it is invisible and nothing flags the gap.
- **Grok** sessions are untested.
- **Memory**: the report holds every index line from a day before the notebook's first round to now, across all projects on the machine. A 31,847-line span took about 3 s and 0.5 GB on one machine.

See [Known gaps and risks](agentflow-integration.md#known-gaps-and-risks) for the full list.
