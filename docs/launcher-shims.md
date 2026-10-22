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

1. The shim accepts only the names `claude` and `codex` (anything else exits 127 without evaluating the name). It
   finds the real binary by walking `PATH` with every empty entry (leading, interior, trailing, all-empty) read as
   the current directory and no pathname expansion, skipping its own directory (compared by physical path, so a
   doubled or symlinked entry is skipped too) and any other ccxray shim. A symlinked binary or a version-manager
   shim is used as found; the shim `exec`s it, so exit codes, signals, stdin/stdout/stderr are the real tool's.
   `CCXRAY_SHIM_REAL_CLAUDE|CODEX` is honoured only for an executable regular file that is not a shim.
2. It runs a small node probe (`<CCXRAY_HOME>/shim-probe.js`, built-ins only) under a **hard deadline enforced by
   the shell** (`CCXRAY_SHIM_DEADLINE_SECS`, default 2 s; plain POSIX `sh`, no `timeout`): a background watchdog
   kills the helper, so a hung Node start, a stalled synchronous read (for example `hub.json` replaced by a FIFO) or
   blocked I/O cannot keep the tool from starting. The probe asks `GET /_api/health` on the proxy port
   (`CCXRAY_SHIM_PORT`, else `hub.json`, else `PROXY_PORT`, else 5577) with a 300 ms budget
   (`CCXRAY_SHIM_TIMEOUT_MS`). Healthy cost: one node start (tens of milliseconds). A genuinely uninterruptible
   kernel wait (a dead network filesystem) cannot be killed by anyone; that is the one case the deadline cannot cover.
3. **Healthy:** Claude runs with `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>[/_ccxray/client/<pid>]` (plus the
   print-mode marker for `-p`); Codex runs with `-c openai_base_url="…/v1"` placed before your arguments. A launch
   that is already routed (ccxray's own launcher, a real `-c/--config openai_base_url=…` or `model_provider=ccxray`
   override, a base URL pointing at a ccxray listener) and non-model subcommands (`--version`, `mcp`,
   `codex login`, …) pass through untouched. Codex arguments are parsed with option arity: prompt text that merely
   mentions `openai_base_url`, or an option value such as `-m help`, is not configuration or a subcommand.
4. **Not usable** (refused, timeout, error, not ccxray, the listener requires authentication, helper crash or
   deadline): the real binary runs directly with your original args and environment, and one JSON line is appended
   to `<CCXRAY_HOME>/shim-bypass.log`: `{t, tool, cwd, reason, action}`. No args, prompts, env values or secrets.
   A custom non-ccxray base URL (a gateway) is left alone and logged as `custom-base-url`. The listener decides
   whether it needs credentials: public health reports `authentication-required` to an unauthenticated caller, and
   the shim (which holds no proxy credential) then bypasses (`auth-required`) instead of routing into 401s.
5. **Strict mode** (`CCXRAY_SHIM_STRICT=1`, or `--strict` at install with `CCXRAY_SHIM_STRICT=0` as the escape
   hatch): the launch is refused with exit code 111 and a message, and logged with `action: "refused"`. This holds
   for every failure path: no listener, auth required, helper exception, helper crash and the deadline.
   `CCXRAY_SHIM_DISABLE=1` skips everything.

## Attribution and lifetime

Against a **hub**, the probe registers the launching pid (the shim `exec`s, so that pid *is* the tool) and its cwd
over the hub socket and routes through `/_ccxray/client/<pid>`. Requests are therefore attributed to their own
project and never inherit a bystander's cwd, and the hub has a client for as long as the tool lives (its dead-client
sweep unregisters the pid after the tool exits), so it does not idle-shut-down under a shim session. Against a
**standalone** proxy there is no client registry: the plain URL is used, and a tool that puts no cwd on the wire
(Codex) is recorded without one rather than with a guessed one.

## The bypass log

`<CCXRAY_HOME>/shim-bypass.log` is created `0600` (directory `0700`) whatever the umask, written best-effort and
silently (a failure never prints and never delays the launch; a FIFO, device or symlink at that path is skipped),
and rotated to `shim-bypass.log.1` past 1 MiB by both writers. The working directory is written as ASCII JSON
(control and non-ASCII characters become `?`). The dashboard, `ccxray status` and `--check` count the active file
**and** the rotated generation, so a rotation does not make recent bypasses disappear; the "total" they show is
what is *retained*, not everything that ever happened.

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
The bypass log is user data and is kept.

Setup never takes over a file it did not write. Before the first write it checks every target (the probe helper,
both shims, the `environment.d` file): each must be absent, or exactly what a previous install left. An existing
file, a symlink, or a shim you edited makes the install **refuse with nothing changed** (`--dry-run` shows
`would REFUSE`; use `--shim-dir` or `--no-session-env` to step around it). Writes go to a temp file and `rename`,
so nothing is ever written through a symlink, and a failure half way rolls the tree back to how it was. Re-running
`--wrap-binaries` restores the original state first, so the recorded "previous state" never becomes a previous
install; if that restore fails, the install stops and the `shims.json` recovery record is kept.

Plain `ccxray setup --remove` includes the shims in its preview and consent prompt (`--dry-run` lists them), removes
them only after setup's own removal succeeds, and a shim-removal failure makes the command exit non-zero.
