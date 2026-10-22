# Security

## Reporting

ccxray is a local-first developer tool maintained by one person. To report a
security issue, open a GitHub issue — or, for something sensitive, a private
advisory at <https://github.com/lis186/ccxray/security/advisories>.

## Trust model

### Where it listens

The HTTP proxy and dashboard listen on the configured port (default 5577) on
loopback only by default: `127.0.0.1`, plus `::1` when the host has IPv6
loopback. Set `PROXY_HOST` (for example `0.0.0.0`) to listen on another address;
the Docker image does this. Hub coordination uses a separate local Unix-domain
socket on macOS/Linux.

### Who is authenticated

Loopback peers (`127.0.0.1`, `::1`, and `::ffff:127.0.0.1`) are trusted by
default for dashboard requests, upstream `/v1/*` requests, and WebSocket
upgrades. Set `CCXRAY_LOOPBACK_REQUIRE_AUTH=1` to require authentication for
loopback requests too.

Protected dashboard/API requests from non-loopback peers require valid
dashboard authentication. `AUTH_TOKEN` is an optional shared secret; when it is
unset, ccxray uses the local secret at `<CCXRAY_HOME>/local-secret` (default
`~/.ccxray/local-secret`) to derive local credentials. A dashboard session
cookie or the credential injected by a ccxray launcher can also authenticate
an authorized dashboard caller.

ccxray listens on loopback by default. `PROXY_HOST` opts in to listening on
other addresses. Clients on other hosts then need the ccxray credential.
`CCXRAY_ALLOW_REMOTE_CHATGPT_LOGIN=1` relaxes this for ChatGPT login from Codex;
use it only on a trusted network.

`/_api/health` is public and returns a minimal listener identity, including
`app`, `pid`, `hub`, `version`, and `capabilities: []`. The additional export
diagnostics are returned only to a trusted caller. The static dashboard shell
and the `/_auth/redeem` / `/_auth/status` bootstrap routes are available before
the normal API gate; conversation data and state-changing API routes remain
behind it. `/_auth/bootstrap-token` is loopback-restricted and gated.

An authenticated caller can use interception controls to pause an agent request,
approve it (optionally with an edited body), or reject it. These actions affect
what the agent receives and whether the request completes, so treat a caller
that passes the auth gate as able to change the agent's work.

### Data boundary

Raw request/response JSON logs stay on the local filesystem in `LOGS_DIR`
(default `~/.ccxray/logs/`). If summary export is configured, ccxray can upload
daily and per-session aggregates. Those summaries can identify work through
fields such as `user_email`, `session_id`, repository basenames, and tool or
skill names. Source-derived names and configured metadata are not
comprehensively scrubbed, so review them before enabling upload.
`CCXRAY_EXPORT_CWD_ALLOWLIST` masks an unlisted repository basename as
`[other]`; it does not exclude the summary row. See the [export onboarding
guide](docs/export-onboarding.md) for the full exported field list and filter
behavior.

`ccxray setup --remove` writes an enrollment tombstone to stop future uploads
and removes ccxray's owned shell block. It does not delete existing local logs
or summaries already uploaded to remote storage.
