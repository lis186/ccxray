# Export onboarding

ccxray's export is machine-level telemetry, not an account boundary. ccxray
cannot distinguish a company account from a personal account when both accounts
write to the same Claude or Codex config store. Switching accounts with `/login`
does not create a separate store.

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

If you use a personal account on this machine, either do not set
`CCXRAY_EXPORT_GCS_BUCKET` here, or keep personal data out of ccxray's view with
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
