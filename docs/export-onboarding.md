# Export onboarding

## Install and configure

Install ccxray. Before setup, make sure Claude Code is installed and ccxray can
read its logged-in account email; the `--domains` list must include that
account's domain. Setup also requires a readable gcloud Application Default
Credential of type `authorized_user`. Setup rejects
`CCXRAY_EXPORT_GCS_KEY_FILE`, even though the exporter itself supports a service
account key file. For setup, use gcloud Application Default Credentials:

```bash
npm install -g ccxray
gcloud auth application-default login
ccxray setup --bucket "<bucket>" --domains example.com --cwd-allowlist "project-a,project-b" --retention-days 30
```

Replace the placeholders with your GCS bucket, the account domain to allow, and
repository basenames to reveal. Setup adds an owned block to the selected shell
startup file. The block defines a `claude` shell wrapper and sets
`CCXRAY_EXPORT_GCS_BUCKET`, `CCXRAY_EXPORT_GCS_PREFIX`,
`CCXRAY_EXPORT_DOMAINS`, `LOG_RETENTION_DAYS`, and
`CCXRAY_IMPORT_DISABLE=1`; it also sets `CCXRAY_EXPORT_CWD_ALLOWLIST` when
provided. It does not add Codex or Grok wrappers. If `--retention-days` is
omitted on a first install, setup writes 30 days; a re-run keeps the value
already in its existing block. Without a repository allowlist, repository
basenames are exported without masking.

Use `ccxray setup --dry-run` with the same setup options to preview changes
without writing them. After setup, open a new terminal or reload the edited
shell profile, then run:

```bash
ccxray setup --check
```

Setup checks configuration and credential parsing; a successful parse is not a
test upload and does not prove that a real upload will succeed.

### Windows PowerShell

On Windows, setup discovers both installed PowerShell editions by default. To
select one explicitly, use either command:

```powershell
ccxray setup --shell pwsh --bucket "<bucket>" --domains example.com --cwd-allowlist "project-a,project-b"
ccxray setup --shell powershell --bucket "<bucket>" --domains example.com --cwd-allowlist "project-a,project-b"
```

Setup checks the selected edition's effective `Get-ExecutionPolicy`. It refuses
to install when `Restricted` prevents profile loading or when `AllSigned` would
block the modified unsigned profile. Choosing `pwsh` instead of `powershell`
does not bypass an effective policy. Run setup from the PowerShell edition and
host whose profile you intend to configure. The check does not cover
host-specific profiles such as VS Code or ISE; open those hosts and confirm
`Get-Command claude` resolves to the ccxray wrapper.

### Removal and shell-file safety

To stop future uploads and remove ccxray's owned shell block, run:

```sh
ccxray setup --remove
```

Removal writes an enrollment tombstone and removes only a block that still
matches its generated output. It does not delete uploaded summaries or local
raw logs. A wrapper already loaded into an open shell remains there until that
shell closes or you remove it manually: use `unset -f claude` in bash/zsh or
`Remove-Item Function:claude` in PowerShell.

If setup reports a malformed block, delete everything from the start marker
line through the end marker line in that startup file, then re-run setup.
Removal still writes the tombstone but leaves a malformed block unchanged and
reports cleanup incomplete. Setup assumes marker lines are ordinary top-level
lines; do not place its block inside a here-document, here-string, or multi-line
quoted string, where removal could delete text belonging to the surrounding
construct.

## Account filter and collection start

`CCXRAY_EXPORT_DOMAINS` filters by the account snapshot attached by the Claude
launcher. When it is non-empty, only turns whose Claude launch-account snapshot
matches one of the configured domains are exported. Turns without that snapshot
are excluded. Codex and Grok launches do not attach a Claude account snapshot,
so their turns are excluded whenever this filter is set. This is the current
intended behavior.

When `CCXRAY_EXPORT_DOMAINS` is unset, empty, or contains only whitespace and
commas, export is blocked: no uploads occur and the cursor stays unchanged.
Startup prints one warning; `ccxray status` reports `refused (domains-required)`.
Set allowed domains with `ccxray setup --domains example.com`, reload your shell,
and restart the exporter. Existing enrolled homes retain the usual bounded
prune hold for unsent data. Imported transcripts have no account snapshot, so
the configured-domain filter excludes them. `CCXRAY_USER_EMAIL`, when set, supplies
summary identity but does not create or replace the per-turn account snapshot used by the filter. Without it,
a configured-domain export needs exactly one observed allowed-domain email;
otherwise a nonempty index fails without advancing its cursor. An empty or missing
index is `nothing-new`, with no upload or prune hold. A domain filter cannot
distinguish multiple accounts within the same domain.

The first cursor starts at `lastId: null` and uses the enrollment timestamp's
UTC calendar date as its lower bound. It scans the whole date, so an eligible
turn already in the index earlier on that same UTC date can be included. Earlier
UTC dates are not backfilled.

## What can be uploaded

Raw request and response JSON files remain in local `LOGS_DIR` (default
`~/.ccxray/logs/`). When export is configured, ccxray uploads daily and
per-session summary rows, not the raw logs. The v3 summary fields are:

- `daily`: `type`, `_summary_schema_version`, `agent_id`, `user_email`, `team`,
  `dt`, `local_date`, `tz`, `provider`, `upload_seq`, `summary_id`,
  `partial_day`, `cost_total`, `cost_confidence`, `models`,
  `context_utilization`, `first_turn_context_pct_median`, `compaction_count`,
  `distinct_sys_hash_count`, `distinct_tools_hash_count`, `tool_usage`,
  `tool_sources`, `skill_usage`, `tool_defined_count`, `tool_used_count`,
  `tool_fail_count`, `duplicate_tool_call_count`, `credential_flag`,
  `error_count`, `stop_reasons`, `session_count`, `turn_count`,
  `subagent_turn_count`, `cwd_repos`, and `thinking_ratio`.
- `session`: `type`, `_summary_schema_version`, `agent_id`, `user_email`, `dt`,
  `session_id`, `session_id_kind`, `summary_id`, `cost_total`,
  `cost_confidence`, `turn_count`, `imported_turn_count`, `inferred_turn_count`,
  `model_primary`, `models`, `cwd`, `flags`, `import_sources`, `thinking_ratio`,
  `turn_set_size`, `turn_set_hash`, and `turn_set_basis`.
- Each daily `models` value contains `turns`, `input`, `output`, `cache_read`,
  `cache_creation`, `thinking_turns`, `beta1m_turns`, and `cost`. Each session
  `models` value contains `turns`, `cost`, `fallback_cost`, `fallback_count`,
  and `unknown_count`.

These summaries identify work. Session rows carry `session_id` and repository
basename (`cwd`); daily rows carry `cwd_repos`; `tool_usage`, `tool_sources`,
and `skill_usage` carry tool, source, and skill names; and both row types can
carry `user_email`. The daily `team` field is optional configured metadata. No
full cwd path is exported. `CCXRAY_EXPORT_CWD_ALLOWLIST` masks a repository
basename outside its list as `[other]`; it does not exclude the row.

The exporter does not copy raw prompts, response bodies, or full tool-argument
objects into these summaries. It does aggregate source-derived model, tool,
tool-source, and skill names, as well as the identifying fields listed above.
Names and configured metadata are not comprehensively scrubbed and may contain
unexpected or sensitive text; review them before enabling export. Failed turns
(e.g. 401) increment `error_count` and contribute unknown-cost evidence when the
turn has no priced cost; they are not excluded.

Each upload is a newly aggregated per-day snapshot. A file contains that date's
daily row and session rows, and its object name includes an increasing
`upload_seq`. Downstream consumers must keep the latest snapshot for each daily
key (`dt`, `agent_id`) and session key (`dt`, `agent_id`, `session_id`); do not
sum every object file, because later files repeat eligible data already present
in earlier snapshots for that date.

Set `CCXRAY_EXPORT_DISABLE=1` to suppress export for a process even when export
settings are present. Export failures normally keep unsent local logs. A
safety cap can allow pruning after there has been no successful upload for twice
the configured retention period; if the cap has no valid basis, pruning can
proceed immediately to keep disk use bounded.

## Writer credentials

The exporter authenticates to GCS with one of two credentials, in this order:

1. `CCXRAY_EXPORT_GCS_KEY_FILE` — a protected service-account JSON key file.
2. The gcloud application-default credential (`gcloud auth application-default
   login`), read from gcloud's own config root: `CLOUDSDK_CONFIG` if set,
   otherwise `%APPDATA%\gcloud` on Windows and `~/.config/gcloud` elsewhere.

There is no working-directory fallback: with no key file and no config root
the exporter reports `discovery:no-config-root` and uploads fail before any
network call. `GOOGLE_APPLICATION_CREDENTIALS` is deliberately not read;
when it is set, status shows it under `ignored:` so you know it has no effect
here.

Credential state is reported in four stages, and each is stated only as far
as it was actually exercised:

| Stage | Values | When it is evaluated |
|---|---|---|
| `discovery` | `key-file`, `adc`, `none`, `no-config-root` | exporter startup and once per uploading flush; offline |
| `parse` | `ok(type)`, `missing`, `unreadable`, `malformed`, `unsupported-type`, `missing-fields` | same (once per flush); offline. Supported types are `service_account` and `authorized_user` |
| `token` | `not-attempted`, `refused:<reason>`, `network:<code>`, `timeout` | only by a real upload |
| `authorization` | `unauthenticated`, `denied` | only by a real upload's 401/403 |

`token` and `authorization` are omitted from the rendered line until they are
actually exercised — a freshly started exporter that has not uploaded anything
shows only `discovery` and `parse`.

`ccxray status` shows these stages on the `Process:` line for a reachable
exporter. Status checks the hub lock/socket first. If a lock exists, status
follows it and does not probe the selected `--port`, even when that hub is
unresponsive. Only when no hub lock is found does it probe the configured port,
so `ccxray --port 5602 status` probes port 5602 only in that case. Status
reaches HTTP export reports through trusted loopback by default. With
`CCXRAY_LOOPBACK_REQUIRE_AUTH=1`, an HTTP probe can still receive the public
minimal `/_api/health` identity response but not its export report; status
reports that authentication is required. A hub with its Unix-domain socket
available can return status over that socket. Error output names a category,
not an upstream response body.

## Reading `ccxray status`

The status output includes `Process:` and `Home:` for the server and its local
export state, followed by diagnostics from three sources:

- `Shell:` is the environment of the process running `ccxray status`. It is not
  the environment of a detached hub. Its `hash=` value is a SHA-256 fingerprint
  of the enumerated export settings; it does not prove that credentials work,
  storage matches, enrollment is valid, or uploads are healthy.
- `Config:` compares that shell fingerprint with the hash reported by the
  running hub. `equal` means the enumerated settings match. `DIFFERS` prints
  “close every ccxray session and start again” because the hub keeps the
  environment it inherited when it started. `unknown` means no reachable hub
  reported a hash; it is never inferred from the shell alone.
- `Durable:` reads enrollment, cursor, the last attempt, lock-loss history,
  and fail-open history from the storage home. When a hub names both its home
  and logs directory, those paths are authoritative and the line says
  `named by hub`; otherwise it reads the invoking shell's paths and says
  `from this shell`.

`enrollment=removed` comes from the durable removal marker, even if the last
attempt record is an older successful export. `enrollment=invalid` includes
the stored reason and detail so a malformed or unreadable marker remains
visible. On a failed attempt, `[stage/category]` identifies the last exporter
step entered and a safe category label: `enrollment`, `enrollment-write`,
`cursor-read`, `cursor-write`, `index-read`, `aggregate`, or `upload`, plus
credential-specific stages such as `token` or `authorization`. The detail is
never an exception message or upstream response body. A failure before
aggregation leaves its aggregate counts unavailable; uploaded `files` and
`rows` count only uploads that completed successfully.

## Restricting transcript roots

The importer follows `$HOME`, not `CCXRAY_HOME`, when it discovers transcript
roots. To disable import for a process, set `CCXRAY_IMPORT_DISABLE=1`. To allow
only selected transcript stores, set `CCXRAY_IMPORT_HOMES` to a comma-separated
list of absolute Claude `projects/` directories and
`CCXRAY_IMPORT_CODEX_HOMES` to a comma-separated list of absolute Codex
`sessions/` directories. An empty value means that provider has no roots; pass
the actual `projects/` or `sessions/` directory, not `~/.claude` or `~/.codex`.

Import appends summary lines to `LOGS_DIR/index.ndjson`; disabling future import
does not remove those lines. For a private report that must be isolated from a
live index or exporter, use a separate `CCXRAY_HOME` and `LOGS_DIR`. Setting
`CCXRAY_EXPORT_DISABLE=1` on a one-off command does not stop another running
process from reading the same index.

## Upgrading from a pre-socket-lock version

Before the first launch of this version on a machine, stop every ccxray process
that shares its `CCXRAY_HOME`: the hub, every standalone or `--port` server, and
every Windows server. Verify that no `node … server/index.js` process remains.
If several checkouts can launch ccxray on that machine, update each one or stop
using it to launch. Then delete `<home>/export.lock` if it exists. This version
does not use that file; if it remains, startup prints one advisory line and
continues with the socket lock.

The exporter lock is a listening socket on `127.0.0.1`, with a port derived
from the home directory's filesystem identity. `export-lock-port` can pin a
numeric port from `1` through `65535` when that port is occupied. Create or
change the pin only while every ccxray using the home is stopped. Pinning works
only when the home directory can be statted and has a usable nonzero inode;
identity checks fail closed before the pin is read when `ino === 0n`. ReFS file
identity behavior is unverified.

If another process occupies the selected port, startup records a structured
`lock-lost` event and skips its startup flush-and-prune critical section.
Freeing the port triggers no immediate retry. Enabled exporters keep flushing
through their existing lifecycle; pruning requires another successful startup
acquisition and a prune decision that permits it.

## Flush timing

The exporter flushes on three occasions: once at startup (initial flush),
on an hourly interval, and during graceful shutdown (`SIGTERM` / `SIGINT`).
A restart therefore triggers two flushes — the old process flushes on
shutdown, and the new process flushes on startup. The upload confirmation
(`exported files=N rows=M`) appears in whichever process performed the
flush, which is usually the **old** process's final output, not the new one.

Do not set `CCXRAY_EXPORT_CONFIG_DIRS`. It never worked as an account or config
directory filter. Setting it now disables export until you unset it, and ccxray
prints a refusal explaining why.

`CCXRAY_EXPORT_CWD_ALLOWLIST` masks repositories outside its list to `[other]`.
When unset or empty, no masking is applied — all repository names are exported
as-is. Set it to a non-empty list to activate masking.
