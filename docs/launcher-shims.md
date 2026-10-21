# Launcher shims (`ccxray setup --wrap-binaries`)

`ccxray setup` installs a `claude()` shell function. That covers interactive shells only. A program that runs
`spawn("claude", ["-p", …])` or `spawn("codex", ["exec", …])`, a cron job or a script never reads your shell
profile, so its traffic is not recorded. `--wrap-binaries` closes that gap **without making the agents depend on
ccxray being up** (#732). It is opt-in; plain `ccxray setup` does not install shims.

```bash
ccxray setup --wrap-binaries --dry-run   # list every file and PATH change, write nothing
ccxray setup --wrap-binaries --yes       # install
ccxray setup --wrap-binaries --check     # PATH order, proxy health, recent bypass counts
ccxray setup --wrap-binaries --remove    # restore the previous state (plain `setup --remove` does this too)
```

Options: `--shim-dir D` installs the two shims into a directory that is already ahead of the real binaries on PATH
(for example `~/.local/bin`) instead of `<CCXRAY_HOME>/shims`; `--strict` makes strict mode the default;
`--no-session-env` skips the Linux `environment.d` file; `--shell zsh|bash` picks the startup file.

## What a launch does

1. The shim finds the real binary by walking `PATH`, skipping its own directory (compared by physical path, so a
   doubled or symlinked entry is skipped too) and any other ccxray shim. A symlinked binary or a version-manager
   shim is used as found; the shim `exec`s it, so exit codes, signals, stdin/stdout/stderr are the real tool's.
2. It runs a small node probe (`<CCXRAY_HOME>/shim-probe.js`, built-ins only) that asks `GET /_api/health` on the
   proxy port (`CCXRAY_SHIM_PORT`, else `hub.json`, else `PROXY_PORT`, else 5577) with a 300 ms budget
   (`CCXRAY_SHIM_TIMEOUT_MS`). Cost: one node start (tens of milliseconds) per launch.
3. **Healthy:** Claude runs with `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` (plus the print-mode marker for
   `-p`); Codex runs with `-c openai_base_url="http://127.0.0.1:<port>/v1"` placed before your arguments. A launch
   that is already routed (ccxray's own launcher, a base URL or `openai_base_url` pointing at a ccxray listener)
   and non-model subcommands (`--version`, `mcp`, `codex login`, …) pass through untouched.
4. **Not healthy** (refused, timeout, error, not ccxray): the real binary runs directly with your original args
   and environment, and one JSON line is appended to `<CCXRAY_HOME>/shim-bypass.log`:
   `{t, tool, cwd, reason, action}`. No args, prompts, env values or secrets. A custom non-ccxray base URL
   (a gateway) is left alone and logged as `custom-base-url`.
5. **Strict mode** (`CCXRAY_SHIM_STRICT=1`, or `--strict` at install with `CCXRAY_SHIM_STRICT=0` as the escape
   hatch): the launch is refused with exit code 111 and a message, and logged with `action: "refused"`.
   `CCXRAY_SHIM_DISABLE=1` skips everything.

`ccxray status`, `ccxray setup --wrap-binaries --check`, `GET /_api/shim-bypass` and a dashboard topbar notice
report the bypass count (counts only; `cwd` never leaves the log).

**The proxy has to be running.** The shims never start it. Run `ccxray` (standalone, port 5577) or keep a hub
alive; a hub idle-exits seconds after its last client. Without a running proxy every launch is a bypass, which
is the point of fail-open and also why the counter exists.

## Getting the shim ahead of the real binary

A spawned program uses the `PATH` it inherited. Coverage depends on where that `PATH` came from:

| Launch path | Covered when |
|---|---|
| Interactive shell | the startup-file block put the shim directory first (open a new terminal) |
| Program started from such a shell | it inherited that PATH |
| Linux desktop/systemd user session | `environment.d/50-ccxray-shims.conf` is read at login (log out and in) |
| cron, CI, launchd, services with their own PATH | **not covered** by the profile. Use `--shim-dir` with a directory that is already first on that PATH, or set PATH in the job |
| macOS GUI-started parents | not covered. `launchctl setenv PATH …` works until reboot only; prefer `--shim-dir` |
| Absolute-path launches (`/usr/local/bin/claude`) | not covered, by design |
| A version manager that prepends its own directory later (nvm, asdf, mise) | the shim is shadowed. `--check` shows what this process resolves; reorder PATH or use `--shim-dir` |
| Windows | **out of scope.** The shims are POSIX `sh`; `--wrap-binaries` refuses. Use `ccxray claude` / `ccxray codex` |

bash reads no startup file for a non-interactive, non-login shell, so for `bash -c` parents the session PATH
(or `--shim-dir`) is what matters, not the profile.

## Fail-open shims vs fail-closed tool config

The alternative is writing the proxy URL into each tool's own config (`openai_base_url` in
`~/.codex/config.toml`, `env.ANTHROPIC_BASE_URL` in `~/.claude/settings.json`). That covers every launch path with
no PATH games, but it is **fail-closed**: when the proxy is down every Claude Code and Codex session on the
machine stops working until it is restarted.

| | Shims (this feature) | Tool config |
|---|---|---|
| Proxy down | agent still runs, unrecorded, bypass logged | agent cannot reach its API at all |
| Coverage | launches that resolve `claude`/`codex` through the shimmed PATH | every launch that reads the config, including absolute paths |
| Recording guarantee | best effort, with a visible gap counter | complete while the proxy is up |
| Per-launch cost | one node start | none |
| Footprint | files + PATH edits, all removable | edits a file the tool owns |

Choose shims when losing the agent is worse than losing a recording. Choose strict mode (a middle path: shim
coverage, but refuse instead of running unrecorded) or tool config when a gap in the record is unacceptable.

## Exact restore

Everything setup changes is listed in `<CCXRAY_HOME>/shims.json`: owned files with their hashes, each profile
edit with whether setup created the file and what separator it added, the `environment.d` file, and every
directory it created. `--remove` deletes only what still matches, strips the marked block, deletes files and
directories setup created if they are empty again, and keeps your later edits (it says so and exits non-zero).
The bypass log is user data and is kept. Re-running `--wrap-binaries` first restores the original state, so the
recorded "previous state" never becomes a previous install.
