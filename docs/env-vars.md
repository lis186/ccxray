# Environment variables

Every environment variable the server (`server/`) reads, with its default and the file that reads it.

**Maintenance rule:** a change that adds, removes, renames, or changes the default of an environment variable read under `server/` must update this file in the same change. `test/docs-consistency.test.js` fails when a `CCXRAY_*`, `ANTHROPIC_*`, `OPENAI_*`, or `CHATGPT_*` name found under `server/` is missing here. Names outside those prefixes are not checked automatically; keep them current by hand.

Unless noted, a variable is read once at process start. In hub mode the hub's own environment applies — the environment of the shell that forked it — not the environment of later `ccxray <agent>` clients.

## Ports, paths, storage

| Variable | Default | Purpose | Defined in |
|---|---|---|---|
| `PROXY_PORT` | `5577` | Port for proxy + dashboard. `--port` overrides it and opts out of hub mode; `PROXY_PORT` alone keeps hub mode on that port. | `server/config.js` |
| `PROXY_HOST` | — (loopback) | Address the proxy + dashboard listens on. Unset: `127.0.0.1`, plus `::1` on the same port when the host has IPv6 loopback. Set: a single listener on that address only — `0.0.0.0` or `::` for all interfaces (IPv6 literals without brackets; `[::]` is accepted too), or one address. `localhost` binds only the one family the OS resolves it to. A single non-loopback interface address is not reachable as `localhost`, so local `ccxray <agent>` launches and hub checks cannot reach it; use `0.0.0.0` (with a firewall if needed) instead — startup warns in that case. When the value is not a loopback address, startup prints the bound address. The Docker image sets `0.0.0.0`. | `server/listen.js` |
| `PORT` | — | **Not read.** `config.PORT` is derived from `PROXY_PORT`. Listed because it is a common guess. | `server/config.js` |
| `CCXRAY_HOME` | `~/.ccxray` | Base directory for `hub.json`, `hub.sock`, `hub.log`, secrets, settings, and (by default) logs. Created 0700. A loose existing home is tightened to 0700 at startup only when it is the default `~/.ccxray`; a loose custom directory gets a one-line warning on every startup and keeps its mode, even after ccxray has written its own files (`local-secret`, `hub.sock`) into it. A symlinked `~/.ccxray` is warning-only, and `$HOME` and its ancestors are never chmod'ed, including through a symlink. | `server/paths.js` |
| `LOGS_DIR` | `<CCXRAY_HOME>/logs` | Log directory (`index.ndjson`, `_req`/`_res` files, `sessions.json`). | `server/paths.js`, `server/cost-worker.js` |
| `LOG_RETENTION_DAYS` | `14` | Prune `_req`/`_res` files older than N days at startup; `0` disables (an export enrollment can impose its recorded retention). Starred items are protected. | `server/retention.js`, `server/restore.js` |
| `RESTORE_DAYS` | `LOG_RETENTION_DAYS` (`14`) | Days of index lines the dashboard loads at startup; `0` = all. | `server/config.js`, `server/restore.js` |
| `STORAGE_BACKEND` | `local` | Storage adapter. Only `local` works; `s3` fails fast. | `server/storage/index.js` |
| `CCXRAY_PRICING_CACHE` | `<package>/pricing-cache.json` | Path of the LiteLLM pricing cache (package-relative by default, so outside `CCXRAY_HOME`). | `server/pricing.js`, `server/default-rates.js` |
| `CCXRAY_PRICING_WAIT_MS` | `8000` | How long an importer waits for the LiteLLM price list when no `pricing-cache.json` exists (positive integer ms, capped at 120000; invalid → default). One shared fetch runs regardless of how many callers time out. | `server/pricing.js` |

## Limits and tuning

| Variable | Default | Purpose | Defined in |
|---|---|---|---|
| `CCXRAY_MAX_ENTRIES` | `5000` | Max in-memory entries; oldest evicted (disk unaffected). | `server/store.js` |
| `CCXRAY_SESSION_ENTRY_CAP` | `500` | Max entries per session loaded at restore; larger sessions keep only their first entry and are cold-loaded on demand. | `server/store.js` |
| `CCXRAY_MAX_BODY_MB` | `50` | Max request body size accepted by the proxy. | `server/config.js` |
| `CCXRAY_SSE_MAX_PER_IP` | `20` | Max concurrent dashboard SSE connections per IP. | `server/config.js` |
| `CCXRAY_SSE_RING_SIZE` | `2000` | SSE replay ring size. | `server/sse-broadcast.js` |
| `CCXRAY_RECENT_SESSIONS` | `10` | Number of recent sessions returned by the recent-sessions API. | `server/routes/api.js` |
| `CCXRAY_DELTA_SNAPSHOT_N` | `0` | Force a full `_req.json` snapshot every N delta writes (`0` = only the session-start anchor). | `server/config.js` |
| `CCXRAY_WS_IDLE_TIMEOUT_MS` | `60000` | Idle timeout for proxied WebSocket sessions. | `server/ws-proxy.js` |
| `CCXRAY_WS_MAX_QUEUE_BYTES` | `4194304` (4 MiB) | Cap on client→upstream bytes buffered while the upstream WebSocket connects. | `server/ws-proxy.js` |
| `CCXRAY_GROK_BILLING_TTL_MS` | `60000` | Suppression window for repeat Grok billing calls after a success. | `server/adapters/grok-adapter.js` |

## Upstreams

| Variable | Default | Purpose | Defined in |
|---|---|---|---|
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | Anthropic upstream; base paths are supported. ccxray refuses to start if it points back at its own port unless the loop is allowed. | `server/config.js` |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI (Codex API-key) upstream. | `server/config.js` |
| `CHATGPT_BASE_URL` | `https://chatgpt.com/backend-api/codex` | Upstream for requests carrying `chatgpt-account-id`. | `server/config.js` |
| `CODEX_CHATGPT_BASE_URL` | — | Fallback name for `CHATGPT_BASE_URL`. | `server/config.js` |
| `XAI_BASE_URL` | `https://cli-chat-proxy.grok.com` | Grok/xAI upstream (also used for the Grok billing call). | `server/config.js` |
| `GROK_BASE_URL` | — | Fallback name for `XAI_BASE_URL`. | `server/config.js` |
| `HTTPS_PROXY` / `https_proxy` | — | Send outbound HTTPS through an HTTP CONNECT proxy. | `server/forward.js` |
| `CCXRAY_ALLOW_UPSTREAM_LOOP` | — | `1` allows an upstream that points at ccxray's own port (same as `--allow-upstream-loop`). | `server/index.js` |
| `CCXRAY_MODEL_PREFIX` | — | String prepended to the model name before forwarding. | `server/config.js` |

## Auth

| Variable | Default | Purpose | Defined in |
|---|---|---|---|
| `AUTH_TOKEN` | — | Optional shared access token; when unset ccxray uses `<CCXRAY_HOME>/local-secret`. | `server/auth.js` |
| `CCXRAY_LOOPBACK_REQUIRE_AUTH` | — | `1` requires auth on loopback too (loopback is trusted by default). | `server/auth.js` |
| `CCXRAY_ALLOW_REMOTE_CHATGPT_LOGIN` | — | `1` accepts ChatGPT login from Codex on clients on other hosts, not only from loopback. Enable it only on a trusted network. | `server/auth.js` |
| `CCXRAY_LOOPBACK_NO_AUTH` | — | Legacy; ignored apart from a startup notice that it is no longer needed. | `server/index.js` |

## Launch and hub

| Variable | Default | Purpose | Defined in |
|---|---|---|---|
| `CCXRAY_ATTACH_TIMEOUT_MS` | `3000` | Hub-attach budget for `ccxray <agent>` before falling back to the plain agent. | `server/index.js` |
| `CCXRAY_FAIL_CLOSED` | — | `1` exits on attach/startup failure instead of launching the plain agent. | `server/index.js`, `server/launch-decision.js` |
| `CCXRAY_DISPLAY_NAME` | `ccxray` | Process/display name used by the launcher and forked hub. | `server/providers.js`, `server/hub.js` |
| `CCXRAY_HUB_CLIENT_PID` | _(set by ccxray)_ | Set by a hub client before spawning its agent; routes that agent's traffic to its client registration. Not meant to be set by hand. | `server/index.js`, `server/providers.js` |
| `CCXRAY_AGENT_ID` | — | Agent identity stamped on traffic (e.g. by the Herdr plugin), also hashed into export summaries. | `server/index.js`, `server/export-sync.js` |
| `CCXRAY_AGENT_TYPE` | — | Agent type paired with `CCXRAY_AGENT_ID`. | `server/index.js`, `server/forward.js` |
| `CLAUDE_CONFIG_DIR` | `~` | Where the Claude launcher looks for `.claude.json` to read the launch account. | `server/providers.js` |
| `OPENAI_API_KEY` | — | When set, `ccxray codex` routes through a `model_providers.ccxray` entry; otherwise through `openai_base_url` only (`chatgpt_base_url` is left at Codex's default so ChatGPT workspace discovery works, #671). | `server/providers.js` |
| `CODEX_HOME` | `~/.codex` | Read-only: `ccxray codex` (ChatGPT-OAuth mode) warns if `config.toml` there points `chatgpt_base_url` at a loopback proxy (#671). Never written. | `server/providers.js` |
| `ANTHROPIC_CUSTOM_HEADERS` | — | Newline-separated user headers. Only ccxray launchers (`ccxray claude`, the shell shim, and the Herdr plugin) append `X-Ccxray-Forward-Headers` listing existing lowercase names, excluding `x-ccxray-*`. If set another way (Claude `settings.json` env or plain `ANTHROPIC_BASE_URL` pointing to the proxy), add names with `CCXRAY_FORWARD_HEADERS=anthropic:cf-aig-authorization`. | `server/providers.js`, `server/shim/ccxray-shim.sh`, `plugins/herdr/bin/lib/ccxray.js` |
| `CCXRAY_FORWARD_HEADERS` | — | Header allowlist additions, read once at server startup: comma-separated names, optionally scoped with `anthropic:`, `openai:`, `chatgpt:`, or `xai:`; unprefixed names apply to all families. Example: `anthropic:cf-aig-authorization,openai:api-key` (Azure-style gateways and Codex `http_headers`). `openai:` does not cover ChatGPT-login traffic; use `chatgpt:`. In hub mode the hub's environment applies. Names accepted only by another family's built-in list are omitted; OpenAI and ChatGPT form one vendor group for this check. `accept-encoding`, client `host`, `x-ccxray-*`, hop-by-hop names, and `sec-websocket-*` remain omitted. Invalid entries print one startup warning per name. | `server/config.js` |
| `BROWSER` | — | `none` disables dashboard auto-open (as do `CI` and `SSH_TTY`). | `server/index.js` |
| `CI`, `SSH_TTY` | — | Either set disables dashboard auto-open. | `server/index.js` |

## Import

| Variable | Default | Purpose | Defined in |
|---|---|---|---|
| `CCXRAY_SHIM_STRICT` | `0` (or the install-time `--strict`) | `1` makes the launcher shims refuse a launch (exit 111) when the proxy is unreachable instead of running the agent directly. Read by the shim, not by the server. | `server/shim/ccxray-shim.sh`, `server/shim/shim-probe.js` |
| `CCXRAY_SHIM_DISABLE` | — | Any non-empty value makes the shims run the real binary immediately: no probe, no routing, no bypass line. | `server/shim/ccxray-shim.sh` |
| `CCXRAY_SHIM_DEADLINE_SECS` | `2` (integer 1–30) | Hard deadline for the whole probe subprocess, enforced by the shell shim with a background watchdog (not by Node). On expiry the helper is killed and the real binary runs (strict mode refuses). | `server/shim/ccxray-shim.sh` |
| `CCXRAY_SHIM_PORT` | hub lock port, then `PROXY_PORT`, then `5577` | Proxy port the shims probe and route to. | `server/shim/shim-probe.js` |
| `CCXRAY_SHIM_TIMEOUT_MS` | `300` (clamped 50–5000) | Health-check budget per launch; a slower proxy counts as down. | `server/shim/shim-probe.js` |
| `CCXRAY_SHIM_HOME` | the `CCXRAY_HOME` baked in at install | Home the shim reads `hub.json` from and writes `shim-bypass.log` to. | `server/shim/ccxray-shim.sh`, `server/shim/shim-probe.js` |
| `CCXRAY_SHIM_REAL_CLAUDE` | — | `CCXRAY_SHIM_REAL_CLAUDE=/path/to/claude`: use this binary instead of searching PATH, for unusual layouts. A bare name is run as `./name` (never searched on PATH). Ignored when it is not an executable regular file, is a ccxray shim, or lives in the shim directory. | `server/shim/ccxray-shim.sh` |
| `CCXRAY_SHIM_REAL_CODEX` | — | Same as `CCXRAY_SHIM_REAL_CLAUDE`, for `codex`. | `server/shim/ccxray-shim.sh` |
| `CCXRAY_SHIM_PID` | set by the shim | The shim's own pid (kept by `exec`, so it is the tool's pid). The probe registers it with the hub as a client for per-project attribution and hub lifetime. Internal: set by the shim for its helper, not meant to be set by hand. | `server/shim/ccxray-shim.sh`, `server/shim/shim-probe.js` |
| `CCXRAY_SHIM_SYSPATH` | `/usr/bin:/bin` | `PATH` used by the shell shim's best-effort fallback logger for `mkdir`, `chmod`, `rm`, `mv` and `date`, instead of the inherited `PATH` (a command planted there must not be able to stall a launch). A test seam; there is rarely a reason to set it. | `server/shim/ccxray-shim.sh` |
| `CCXRAY_IMPORT_DISABLE` | — | `0` enables the automatic startup transcript import; `1` also disables `ccxray import --once` and refuses `rebuild-index --reimport`. Unset = no automatic import. | `server/index.js`, `server/importer.js`, `server/rebuild-index.js` |
| `CCXRAY_IMPORT_HOMES` | `~/.claude*` discovery | Comma-separated Claude `projects/` roots to import from. | `server/importer.js` |
| `CCXRAY_IMPORT_CODEX_HOMES` | `~/.codex*` discovery | Comma-separated Codex roots to import from. | `server/importer.js` |
| `CCXRAY_IMPORT_ONCE_MIN_INTERVAL_MS` | `600000` (10 min) | Throttle for `ccxray import --once`. | `server/import-once.js` |
| `CCXRAY_IMPORT_TARGET_WATCHDOG_MS` | `30000` | Per-target watchdog for `import --once` (min 1000, max 120000). | `server/import-once.js` |
| `CCXRAY_SESSION_INDEX_NO_FLUSH` | — | `1` makes the process append index lines without writing `sessions.json` (set internally by `import --once`; ADR 0019). | `server/session-index.js`, `server/import-once.js` |
| `CCXRAY_SKIP_RECENCY_CHECK` | — | `1` skips `rebuild-index`'s recent-write refusal. | `server/rebuild-index.js` |

## Export (GCS summaries)

See the [export onboarding guide](export-onboarding.md).

| Variable | Default | Purpose | Defined in |
|---|---|---|---|
| `CCXRAY_EXPORT_DISABLE` | — | `1` disables export regardless of other settings. | `server/export-sync.js` |
| `CCXRAY_EXPORT_GCS_BUCKET` | — | Destination bucket; export is off without it. | `server/export-sync.js` |
| `CCXRAY_EXPORT_GCS_PREFIX` | `summaries` | Object prefix inside the bucket. | `server/export-sync.js` |
| `CCXRAY_EXPORT_GCS_KEY_FILE` | — | Service-account key file; otherwise ADC under gcloud's config root. | `server/export-credentials.js`, `server/export-sync.js` |
| `CLOUDSDK_CONFIG` | `~/.config/gcloud` (`%APPDATA%\gcloud` on Windows) | gcloud config root used for ADC discovery. | `server/export-credentials.js` |
| `GOOGLE_APPLICATION_CREDENTIALS` | — | Ignored (diagnosed as ignored). | `server/export-credentials.js` |
| `CCXRAY_EXPORT_DOMAINS` | — | Required account-domain filter; uploads are blocked when empty. | `server/export-sync.js` |
| `CCXRAY_EXPORT_CWD_ALLOWLIST` | — | Repository basenames exported unmasked; others become `[other]`. | `server/export-sync.js` |
| `CCXRAY_EXPORT_CONFIG_DIRS` | — | Retired; setting it refuses export. | `server/export-sync.js` |
| `CCXRAY_USER_EMAIL` | — | User identity in summaries. | `server/export-sync.js` |
| `CCXRAY_TEAM` | — | Team label in summaries. | `server/export-sync.js` |

## Display and diagnostics

| Variable | Default | Purpose | Defined in |
|---|---|---|---|
| `CCXRAY_PLAN` | _(auto)_ | Override plan detection: `pro`, `max5x`, `max20x`, `api-key`. | `server/plan-detector.js`, `server/forward.js` |
| `CCXRAY_DISABLE_TITLES` | — | `1` disables session title extraction. | `server/helpers.js` |
| `CCXRAY_DEBUG_CLASSIFY` | — | `1` logs system-prompt agent classification. | `server/system-prompt.js` |

`setup.js`, `win-launch.js`, and `providers.js` (Codex `config.toml` lookup, with `USERPROFILE`) also read `HOME`, `SHELL`, `ZDOTDIR`, `PATH`, `PATHEXT`, and `APPDATA` for shell-profile and executable discovery; they are not ccxray settings.

## Matched names that are not environment variables

The grep in the maintenance rule also matches these identifiers. They are constants or derived values, not settings; they are listed so the check stays exhaustive.

| Name | What it is | Defined in |
|---|---|---|
| `ANTHROPIC_HOST`, `ANTHROPIC_PORT`, `ANTHROPIC_PROTOCOL`, `ANTHROPIC_BASE_PATH`, `ANTHROPIC_BASE_URL_SOURCE` | Parsed parts of `ANTHROPIC_BASE_URL` | `server/config.js` |
| `OPENAI_HOST`, `OPENAI_PORT`, `OPENAI_PROTOCOL`, `OPENAI_BASE_PATH`, `OPENAI_BASE_URL_SOURCE` | Parsed parts of `OPENAI_BASE_URL` | `server/config.js` |
| `OPENAI_WIRE_CLIENTS` | Registry of non-Codex OpenAI-wire clients | `server/providers.js` |
| `OPENAI_WS_PATHS` | WebSocket paths the proxy upgrades | `server/ws-proxy.js` |
| `OPENAI_TOOL_CALL_TYPES`, `OPENAI_TOOL_ALIASES`, `OPENAI_PROCESS_TOOLS` | OpenAI-wire tool extraction tables | `server/helpers.js` |
| `OPENAI_USER_QUERY_RE`, `OPENAI_SKIP_USER_PREFIX_RE` | OpenAI-wire user-query regexes | `server/openai-response.js` |
| `CCXRAY_HEADER_PREFIX` | The `x-ccxray-` internal header prefix | `server/internal-headers.js` |
| `CCXRAY_PUBLIC_ORIGINS` | Mentioned in a comment only; not read | `server/auth.js` |
