# Running ccxray: hub vs standalone, uptime, and external workers

This page describes current behaviour only. ccxray has no official keep-alive or service option today; whether to ship one is undecided.

## Two kinds of server

Only one process can listen on a port, and it is one of two kinds:

| | Hub | Standalone |
|---|---|---|
| Started by | `ccxray <agent>` on macOS/Linux without `--port` (forks a detached `--hub-mode` process) | `ccxray` with no agent; `ccxray --port N <agent>`; every agent launch on Windows; the Herdr plugin when no proxy is running (`ccxray --no-browser`, detached) |
| `hub.json` / `hub.sock` | Written after it listens; removed on shutdown | Never written |
| Client registry | Yes — `ccxray <agent>` launchers register and unregister | None |
| Shutdown | Idle shutdown `IDLE_TIMEOUT_MS` = 5 s (`server/hub.js`, not configurable) after it becomes ready with no clients, or after the last client leaves. A client whose pid dies without unregistering is dropped by a sweep every 30 s. | No idle shutdown. `ccxray` with no agent runs until stopped. `ccxray --port N <agent>` exits when its agent exits. |
| `ccxray status` | `Hub: http://localhost:<port> …` | `No hub running.` plus `Note: port <port> is held by a standalone (non-hub) ccxray` and `Machine: {"proxy":true,"hub":false,…}` |
| `GET /_api/health` | `hub: true` | `hub: false` |

`GET /_api/health` also returns `version` and `gitSha` (the 40-hex commit the process started from when the package root is a git checkout, else `null`; captured at startup before the port accepts requests, public, no other git data; reftable repositories and symlinked or malformed git metadata report `null`) — use `gitSha` to confirm a restart picked up a merge.

## Keeping a proxy up

- A hub lives only while it has registered clients, plus 5 s. Pointing an agent at a hub's port with `ANTHROPIC_BASE_URL` (or the Codex/Grok equivalents below) does **not** register it, so it does not keep the hub alive: when the last `ccxray <agent>` client exits, the hub exits and the port closes.
- A standalone `ccxray` (no agent) stays up until you stop it. That is the only way, today, to keep a proxy running independently of any launched agent. Running it under a supervisor of your choosing is outside what ccxray provides or tests.
- Hub clients recover from a hub crash: each `ccxray <agent>` client checks the hub pid every 5 s and forks a new hub when it is gone.

### When nothing is listening

ccxray is in the request path; there is no bypass. If nothing is listening on the port an agent was pointed at, its requests fail with a connection error. They are not forwarded upstream and not recorded.

At launch time, `ccxray <agent>` is different: if it cannot attach to or start a proxy (attach budget `CCXRAY_ATTACH_TIMEOUT_MS`, default 3000 ms), it starts the plain agent without the proxy and records the fallback in `<CCXRAY_HOME>/fail-open.log`. That session is not proxied. `CCXRAY_FAIL_CLOSED=1` exits instead.

## Hub and standalone on the same port

- **`ccxray <agent>` finds a standalone on the port.** There is no `hub.json`, so the launcher forks a hub. The hub cannot bind the port, retries for 5 s, and logs the occupant to `hub.log` (`port … is held by a standalone (non-hub) ccxray`). The launcher then fails open: the plain agent runs unproxied, recorded in `fail-open.log` (or exits with `CCXRAY_FAIL_CLOSED=1`). It does not reuse the standalone and does not stop it. Use `--port` (independent server) or `PROXY_PORT` (hub on another port) to run alongside it.
- **A standalone finds a hub on the port.** `ccxray` exits with `Error: port <port> is already in use`; the hub is untouched.
- **Herdr plugin launch actions** (`Launch Claude/Codex/Grok via ccxray`) choose a proxy in this order, honouring `PROXY_PORT` when set (a proxy on another port is not used):
  1. a hub reported by `ccxray status` — the launch registers the new pane's shell (from `herdr pane process-info`) as a hub client, so the hub stays up while that pane is open; the hub's dead-client sweep removes it after the pane closes;
  2. a standalone ccxray already on the port — reused as is;
  3. otherwise it starts a detached standalone `ccxray --no-browser`, which stays up after the agent exits.

  Because of step 3, a later `ccxray <agent>` on the same port meets the standalone case above. The agent itself is started natively by Herdr, not through `ccxray <agent>`.

## Wiring external workers

Agents that are not started through `ccxray <agent>` — for example a runner that spawns `claude -p`, `codex exec`, or `grok` — must be pointed at the proxy themselves. Loopback requests need no token unless `CCXRAY_LOOPBACK_REQUIRE_AUTH=1` (see [SECURITY.md](../SECURITY.md)). These settings mirror what `server/providers.js` passes when ccxray launches each agent. Remember they do not register with a hub (see above).

| Agent | Setting |
|---|---|
| Claude Code | `ANTHROPIC_BASE_URL=http://localhost:5577` |
| Codex (API key) | A custom model provider whose `base_url` is the proxy's `/v1`: `codex -c 'model_providers.ccxray={name="ccxray", base_url="http://localhost:5577/v1", wire_api="responses"}' -c 'model_provider="ccxray"' …` (or the same `model_providers.<id>` table in `config.toml`). |
| Codex (ChatGPT login) | `codex -c 'openai_base_url="http://localhost:5577/v1"' …` only. Do not set `chatgpt_base_url` to the proxy: ChatGPT workspace discovery rejects a loopback URL ([#671](codex-workspace-routing.md)) |
| Grok CLI | `GROK_CLI_CHAT_PROXY_BASE_URL=http://localhost:5577/v1` |

Use your proxy's port in place of `5577`.

Runs that bypass the proxy are not recorded live. Claude Code and Codex transcripts can be imported afterwards (`ccxray import --once`, or automatic startup import with `CCXRAY_IMPORT_DISABLE=0`). The importer reads only Claude and Codex transcripts; there is no Grok importer, so an unproxied Grok run is not recoverable.

## Imported rows and retention

- Startup pruning (`LOG_RETENTION_DAYS`, default 14) deletes old `_req.json`/`_res.json` files and then drops index lines whose proxy files are gone. Imported lines have no such files, so they survive pruning. The exception: an imported line that duplicates a proxy line (same `responseId`) is dropped once that proxy line's files are pruned.
- The dashboard's startup restore loads only index lines from the last `RESTORE_DAYS` (default: `LOG_RETENTION_DAYS`, i.e. 14) into memory. Older sessions, imported or not, still appear as session cards from the session index (`sessions.json`), and their turns are read from `index.ndjson` when the session is opened. `ccxray usage` and `ccxray agentflow report` read `index.ndjson` directly and are not limited by `RESTORE_DAYS`.

All variables mentioned here are listed in [env-vars.md](env-vars.md).
