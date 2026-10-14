# Export onboarding

## One-step setup

Install gcloud Application Default Credentials first:

```sh
gcloud auth application-default login
ccxray setup --bucket <bucket> --domains <domain> --cwd-allowlist <allowed-repository-basename>
ccxray setup --check
```

Replace the placeholders with the bucket, allowed account domain, and repository
basenames approved for the pilot. Setup stores these values in an owned block in
the selected shell startup file. It never reads them from the invoking
environment. If no repository allowlist is supplied, repository basenames are
exported without masking.

To stop future uploads and remove the wrapper, run:

```sh
ccxray setup --remove
```

On Windows, setup discovers and configures every installed PowerShell edition
by default. Run `ccxray setup --check` in each edition and inspect the reported
edition and console host. The check does not cover host-specific profiles such
as VS Code or ISE; open those hosts and confirm `Get-Command claude` resolves to
the ccxray wrapper before relying on it.

ccxray's export is machine-level telemetry with an optional account-domain
filter for turns that carry a Claude launch-account snapshot. Set
`CCXRAY_EXPORT_DOMAINS=example.com,example.org` to aggregate only turns whose
recorded account domain is in that list. Turns with no account snapshot and
turns from other domains are then excluded before daily and session rows are
built, and every flush prints how many were excluded and why.

When `CCXRAY_EXPORT_DOMAINS` is unset or empty the filter is not configured:
every turn this machine observes is exported, exactly as before the filter
existed, with no identity resolution and no hard-fail. Only launches through
`ccxray <agent>` record an account snapshot; imported transcripts never do, so
an unconfigured exporter is the only mode in which imported history exports.

With the filter configured, `CCXRAY_USER_EMAIL` remains the explicit summary
identity when set. Without it, ccxray requires exactly one observed email among
the allowed-domain turns; zero or multiple candidates hard-fail the export
without advancing its cursor. Without the filter, an unset `CCXRAY_USER_EMAIL`
still yields `user_email: null` in the summaries. The filter cannot distinguish
two accounts in the same allowed domain, so keep personal same-domain traffic
out of ccxray's view or do not set the exporter.

What leaves the machine is a per-session summary and a daily aggregate. See `bq/01-summaries-external-table.json` (in the `team/` package, not yet on
main) for the full v3 schema. Key fields:

- `user_email` — `CCXRAY_USER_EMAIL` or the resolved identity
- `team` — `CCXRAY_TEAM` (daily row only; session rows do not carry it)
- `cost_total`, `cost_confidence`
- `turn_count`, `session_count`, `error_count`
- `model_primary`, `models` (per-model turn/token/cost breakdown)
- `cwd` — the repository directory basename (never a full path). Masked to
  `[other]` when `CCXRAY_EXPORT_CWD_ALLOWLIST` is set and the basename is not
  in the list. When the variable is unset or empty, the basename is exported
  without masking
- `flags`, `tool_usage`, `skill_usage`, `tool_sources`
- `provider`, `agent_id`, `session_id_kind`

The export never contains prompts, titles, tool arguments, response bodies,
credentials, or absolute paths. Failed turns (e.g. 401) increment `error_count` and contribute unknown-cost
evidence when the turn has no priced cost; they are not excluded.

If you use a personal account outside an allowed domain, configure
`CCXRAY_EXPORT_DOMAINS` before setting `CCXRAY_EXPORT_GCS_BUCKET`. For
same-domain personal traffic, keep it out of ccxray's view with
`CCXRAY_IMPORT_HOMES` and do not launch personal agents through ccxray. That
variable is a comma-separated list of the actual Claude `projects/` scan roots;
use the `projects/` directory itself, not a config home such as `~/.claude`.
Setting `~/.claude` imports zero and reports no error. What ccxray never observes
it can never export. For Codex, the corresponding
`CCXRAY_IMPORT_CODEX_HOMES` value is a comma-separated list of actual
`sessions/` scan roots; use the `sessions/` directory itself, not `~/.codex`.

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

`ccxray status` shows these stages on the `Process:` line for an enabled
exporter reached through a hub. Standalone, `--port`, and Windows servers
print the same stages to the terminal at startup; `status` cannot reach their
exporter yet. Error output names the category only — never the upstream
response body, which would carry the OAuth client, the principal, or the
bucket.

## Reading `ccxray status`

The export diagnostics are split across three lines because they describe three
different sources:

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

## Isolating a drill or canary run

When testing with a separate `CCXRAY_HOME`, the startup importer still scans
`~/.claude*/` and `~/.codex*/` (these paths follow `$HOME`, not
`CCXRAY_HOME`). Without further isolation, real historical sessions from this
machine are imported into the drill home and exported under whatever identity
you configured — mixing real data with a test identity.

To prevent this, either:
- set `CCXRAY_IMPORT_DISABLE=1` (disables the importer entirely), or
- point `CCXRAY_IMPORT_HOMES` and `CCXRAY_IMPORT_CODEX_HOMES` at empty
  directories so the importer finds nothing to scan.

When using a fake identity (`CCXRAY_USER_EMAIL=drill@example.invalid`), do
**not** also set `CCXRAY_EXPORT_DOMAINS` to a fake domain. The domain filter
matches the real launch-account snapshot on the wire, not the configured
`CCXRAY_USER_EMAIL`. A real account at `company.com` sending turns through a
proxy with `CCXRAY_EXPORT_DOMAINS=example.invalid` will have every turn
excluded by `domain-mismatch`, producing `rows=0` — which looks like the
exporter is broken rather than the filter working as designed.

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
