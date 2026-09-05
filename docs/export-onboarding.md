# Export onboarding

ccxray's export is machine-level telemetry with an account-domain filter for
turns that carry a Claude launch-account snapshot. Set
`CCXRAY_EXPORT_DOMAINS=example.com,example.org` to aggregate only turns whose
recorded account domain is in that list. Turns with no account snapshot and
turns from other domains are excluded before daily and session rows are built.

`CCXRAY_USER_EMAIL` remains the explicit summary identity when set. Without
it, ccxray requires exactly one observed email among the allowed-domain turns;
zero or multiple candidates hard-fail the export without advancing its cursor.
The filter cannot distinguish two accounts in the same allowed domain, so keep
personal same-domain traffic out of ccxray's view or do not set the exporter.

What leaves the machine is the per-session summary:

- `cost_total`
- `turn_count`
- `model_primary`
- `cwd`
- `flags`
- `cost_confidence`

The export also contains the day's aggregate totals and breakdowns. It never
contains prompts, titles, or tool arguments. `cwd` is masked to `[other]` unless
the repository is included in `CCXRAY_EXPORT_CWD_ALLOWLIST`.

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

Do not set `CCXRAY_EXPORT_CONFIG_DIRS`. It never worked as an account or config
directory filter. Setting it now disables export until you unset it, and ccxray
prints a refusal explaining why.

`CCXRAY_EXPORT_CWD_ALLOWLIST` does work: it masks repositories outside the
allowlist. That is why the broken config-directory control is being removed
rather than kept.
