# Export onboarding

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

What leaves the machine is a per-session summary and a daily aggregate. See
`bq/01-summaries-external-table.json` for the full v3 schema. Key fields:

- `user_email` — `CCXRAY_USER_EMAIL` or the resolved identity
- `team` — `CCXRAY_TEAM` (daily row only; session rows do not carry it)
- `cost_total`, `cost_confidence`
- `turn_count`, `session_count`, `error_count`
- `model_primary`, `models` (per-model turn/token/cost breakdown)
- `cwd` — masked to `[other]` when `CCXRAY_EXPORT_CWD_ALLOWLIST` is set and the
  repository is not in the list. When the variable is unset or empty, `cwd` is
  exported as-is (no masking)
- `flags`, `tool_usage`, `skill_usage`, `tool_sources`
- `provider`, `agent_id`, `session_id_kind`

The export never contains prompts, titles, tool arguments, response bodies,
credentials, or absolute paths. Failed turns (e.g. 401) are included with
`error_count` and `cost_confidence:"unknown"`, not excluded.

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
| `discovery` | `key-file`, `adc`, `none`, `no-config-root` | exporter startup and every upload; offline |
| `parse` | `ok(type)`, `missing`, `unreadable`, `malformed`, `unsupported-type`, `missing-fields` | same; offline. Supported types are `service_account` and `authorized_user` |
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
