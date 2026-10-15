# `ccxray agentflow report`

Tokens, cost and time for every Ask of an [agentflow](https://github.com/agfnow/agentflow) notebook. Experimental.

agentflow records a project's work as rounds in a notebook (`.agentflow/devlog.md`): an Ask, then a Reply. This command tells you what each round cost: which models ran, at what reasoning effort, for how long, and at what price, split by the host session, its subagents and any external workers it dispatched.

The design, with every attribution rule, is in the [agentflow integration guide](https://github.com/lis186/ccxray/blob/v2.5.0-rc.1/docs/agentflow-integration.md). This page covers using the report.

## Quick start

```bash
cd my-project                        # a checkout with an agentflow notebook
ccxray claude                        # work through the proxy as usual
ccxray agentflow report              # every Ask of the default notebook
ccxray agentflow report --ask A-012  # one Ask
ccxray agentflow report --json       # the same data as JSON
ccxray agentflow report --notebook .agentflow/features/auth/auth.devlog.md
```

Without `--notebook`, the report reads `ag.json` from the current working directory and resolves its `switches['target-doc']` path relative to that directory. If there is no such setting, it uses `.agentflow/devlog.md` relative to the current working directory. It does not resolve `target-doc` relative to `workspace-dir`.

## What you need

- **An agentflow notebook.** Each Reply's stamp line (`* _2026-10-14 09:14:40 +0000 (…)_`) ends its Ask; an Ask with no Reply yet runs to now.
- **Transcripts on this machine.** The report reads Claude Code and Codex transcript files directly from the same roots as `ccxray import`. It also reads the ccxray index for proxy records.
- **The proxy, for complete figures.** Without it the report still works, but some requests never reach a transcript. Claude Code's prompt suggestions and title generation are billed, yet only the proxy sees them. In one measured interactive session the transcripts alone came out 11.7% low. Run your sessions through `ccxray claude` / `ccxray codex` for complete figures.
- **Indexed usage turns.** The report reads transcripts directly for attribution and completeness, but token, cost, model, and effort totals are aggregated from turns in `index.ndjson`. If the needed proxy or imported turns are already indexed, import can be skipped. History that exists only in transcripts must be imported before it contributes usage. The report does not start a server. `import --once` skips if it ran in the last 10 minutes unless given `--force`.

## Optional local transcript import

`ccxray setup` writes `CCXRAY_IMPORT_DISABLE=1` and leaves it enabled. This
prevents the background importer and `ccxray import --once` from adding
transcripts to the index. It does **not** prevent `ccxray agentflow report`
from reading transcript files directly. Restrict both providers to the exact
roots you want the report to read: Claude roots must be the actual `projects/`
directories, and Codex roots must be the actual `sessions/` directories. Use
comma-separated absolute paths for multiple roots. For a provider you do not
want to read, keep its variable defined with no nonblank entries: bash/zsh can
use an empty value, while PowerShell should use `','` as shown below. Do not
pass a config home such as `~/.claude` or `~/.codex`.

This bash/zsh example imports only from the default Claude projects directory;
the `CCXRAY_IMPORT_DISABLE=0` assignment applies to this command only:

```bash
CCXRAY_IMPORT_DISABLE=0 \
CCXRAY_IMPORT_HOMES="$HOME/.claude/projects" \
CCXRAY_IMPORT_CODEX_HOMES="" \
ccxray import --once

# The report reads transcript files directly, so set the same roots for it.
# CCXRAY_IMPORT_DISABLE remains at its configured value (normally 1).
CCXRAY_IMPORT_HOMES="$HOME/.claude/projects" \
CCXRAY_IMPORT_CODEX_HOMES="" \
ccxray agentflow report --json
```

In PowerShell, the example below restores the process environment even if a
command fails. Adjust `$claudeProjects` if your Claude config uses another
directory. Microsoft's Windows PowerShell 5.1 and PowerShell 7.4 docs state
that assigning `''` removes an environment variable. The non-empty comma value
below is split into blank entries and ignored by the importer, leaving no
Codex roots. The roots stay restricted for both commands, while import is
temporarily enabled only for `ccxray import --once` ([PowerShell 5.1 docs](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_environment_variables?view=powershell-5.1), [PowerShell 7.4 docs](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_environment_variables?view=powershell-7.4)):

```powershell
$names = @('CCXRAY_IMPORT_DISABLE', 'CCXRAY_IMPORT_HOMES', 'CCXRAY_IMPORT_CODEX_HOMES')
$old = @{}
foreach ($name in $names) {
  $old[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
$claudeProjects = Join-Path (Join-Path $HOME '.claude') 'projects'

try {
  $env:CCXRAY_IMPORT_DISABLE = '0'
  $env:CCXRAY_IMPORT_HOMES = $claudeProjects
  # A comma splits into blank entries, which the importer drops as zero roots.
  $env:CCXRAY_IMPORT_CODEX_HOMES = ','
  ccxray import --once
  if ($LASTEXITCODE -ne 0) { throw 'ccxray import --once failed' }

  if ($null -eq $old['CCXRAY_IMPORT_DISABLE']) {
    Remove-Item Env:CCXRAY_IMPORT_DISABLE -ErrorAction SilentlyContinue
  } else {
    $env:CCXRAY_IMPORT_DISABLE = $old['CCXRAY_IMPORT_DISABLE']
  }
  ccxray agentflow report --json
  if ($LASTEXITCODE -ne 0) { throw 'ccxray agentflow report failed' }
} finally {
  foreach ($name in $names) {
    if ($null -eq $old[$name]) {
      Remove-Item "Env:$name" -ErrorAction SilentlyContinue
    } else {
      [Environment]::SetEnvironmentVariable($name, $old[$name], 'Process')
    }
  }
}
```

The importer appends imported lines to `LOGS_DIR/index.ndjson`; they stay there
after this command. Restricting roots limits what is read and imported, but does
not remove existing index lines. If a private report must be isolated from a
live ccxray index or exporter, use a separate `CCXRAY_HOME` and `LOGS_DIR` for
both commands. `CCXRAY_EXPORT_DISABLE=1` on a one-off command does not stop a
separately running process from reading the shared index.

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

Hosts and workers each show their own completeness label. An Ask's
`completeness` folds host sessions only; a worker's completeness does not change
the Ask-level value.

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
- `not yet imported: n turns`: use the one-command import flow above, then report again.
- `unmatched bullets` / `unmatched owner submissions`: prompts in the notebook with no matching transcript message, or the reverse. Claude Code background-task notices recorded as bullets by agentflow's hook show up here too.
- A `+` after a cost: some calls had no price, so the cost is a lower bound. A `~` marks a cost partly estimated from fallback rates.

### Footer

The footer lists data sources per provider, reports that figures are recomputed
from data still on disk and cover this machine only, and counts external runs
the report could not place. The JSON also includes `notebook` (a path relative
to the checkout), `generatedAt`, setup/unassigned aggregates, worker
unassigned/ambiguous aggregates, `asks`, and this `footer`.

## What stays out

The report and `--json` do not include raw prompt or transcript text or full tool
argument objects. They do include Ask ids, executor kinds, roles, models,
effort, times, tokens, costs, call counts, labels, the relative notebook path,
`generatedAt`, and footer counts. Model and effort names come from indexed
records, and the report has no general redaction pass for those values; inspect
them before sharing the report.

When argument or notebook errors occur, `--json` does not return a JSON error
object: the message goes to stderr and the command exits with status 1.

## Limits

- **Figures change as data ages.** Proxy records may be pruned according to `LOG_RETENTION_DAYS` (14 days when unset; a first `ccxray setup` install uses 30 days by default). Local pruning can be disabled with `LOG_RETENTION_DAYS=0` when no export enrollment supplies a positive `retentionDays`; an enrolled export home uses its recorded value, so changing the process setting alone does not replace it. Export failure can delay pruning, so age alone does not guarantee when records disappear. If proxy records are pruned while transcripts remain, an Ask may lose proxy coverage. Claude Code deletes transcripts after 30 days by default. Saved snapshots are planned. The report footer currently prints fixed figures ("proxy pruning (14 days)", "transcript deletion (30 days)"); these are defaults, not your effective settings.
- **This machine only.** Rounds worked on another machine show `no local evidence`.
- **Codex** turns carry no response id, so each Codex session is read from one source: the proxy if it saw the session, otherwise the import.
- **A Codex worker started with `--ephemeral`** writes no transcript. Unless its requests went through the proxy, it is invisible and nothing flags the gap.
- **Grok** sessions are untested.
- **Memory**: the report holds every index line from a day before the notebook's first round to now, across all projects on the machine. A 31,847-line span took about 3 s and 0.5 GB on one machine.

See [Known gaps and risks](https://github.com/lis186/ccxray/blob/v2.5.0-rc.1/docs/agentflow-integration.md#known-gaps-and-risks) for the full list.
