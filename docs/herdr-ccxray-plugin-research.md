# Herdr ccxray Plugin Research and Plan

> Date: 2026-08-14
> Scope: analysis and planning only; no product code was changed.
> Primary sources:
> - Herdr plugin docs: https://herdr.dev/docs/plugins/
> - Herdr socket API docs: https://herdr.dev/docs/socket-api/
> - Herdr marketplace docs: https://herdr.dev/docs/marketplace/
> - Herdr marketplace index: https://assets.herdr.dev/plugins/index.json
> - Local Herdr reference: `reference/herdr`
> - Local ccxray reference: `CLAUDE.md`, `README.md`, `server/routes/*.js`, `server/sse-broadcast.js`, `docs/usage.md`

## Executive Thesis

The ccxray Herdr plugin should not be "a dashboard launcher" or "another token meter".
The defensible product is **agent runtime observability inside Herdr**:

1. **Every Herdr agent pane gets a live X-ray badge**: context pressure, spend, cache health, tool failures, session weather, and whether the pane is actually being observed by ccxray.
2. **A Herdr-native Mission Control pane triages the herd**: which agent is wasting money, about to compact, thrashing tools, losing cache, or waiting for human input.
3. **One-click guardrails close the loop**: open the exact ccxray turn, toggle intercept for the current session, star evidence, ask the agent to explain or fix the risky turn, and preserve the forensic trail.

That makes ccxray a daily Herdr habit: before acting on an agent's output, users check the X-ray signal. Before starting serious work, they start it through the ccxray launcher. When something feels off, ccxray is the source of truth.

## Herdr Plugin Constraints That Matter

Herdr plugin v1 is deliberately simple:

- A plugin is a directory with `herdr-plugin.toml` plus executable commands. Herdr owns install/link, manifest validation, keybindings, panes, event hooks, invocation context, logs, and socket access; the plugin owns implementation language and durable files.
- There is no separate SDK or sandbox. Plugins can call the whole Herdr CLI, and arbitrary plugin code runs as the user. Trust messaging must be explicit.
- Runtime action registration and native non-terminal UI are not in plugin v1. Actions, startup hooks, event hooks, panes, and link handlers must be declared in the manifest.
- Runtime commands receive `HERDR_SOCKET_PATH`, `HERDR_BIN_PATH`, `HERDR_PLUGIN_ID`, `HERDR_PLUGIN_ROOT`, `HERDR_PLUGIN_CONFIG_DIR`, `HERDR_PLUGIN_STATE_DIR`, `HERDR_PLUGIN_CONTEXT_JSON`, and available workspace/tab/pane ids.
- Plugins should prefer `HERDR_BIN_PATH` for portability; raw socket transport differs between Unix sockets and Windows named pipes.
- Startup hooks are one-shot commands after restore/API readiness, not supervised daemons. A long-running watcher should be launched intentionally and made self-checking.
- Plugin pane placements can be `overlay`, `popup`, `split`, `tab`, or `zoomed`; popup is modal and has no pane id.
- Link handlers can capture matching terminal URLs on modified-click and route to plugin actions.
- There is no Herdr-managed plugin storage API; config/state directories are path discovery only.

Local source confirms the manifest schema in `reference/herdr/src/api/schema/plugins.rs`: required plugin metadata, build/startup/actions/events/panes/link_handlers, action contexts (`global`, `workspace`, `tab`, `pane`, `selection`), platforms (`linux`, `macos`, `windows`), invocation context fields, command logs, and plugin pane open parameters.

## Socket API Surfaces To Exploit

The socket API is richer than "open pane":

- `session.snapshot` provides a bootstrap view of workspaces, tabs, panes, layouts, and agents.
- `events.subscribe` streams workspace/tab/pane/layout/worktree/agent events.
- `pane.report_metadata` and `workspace.report_metadata` can write display-only tokens into the Herdr UI without taking lifecycle authority.
- `agent.view.set` can temporarily project the built-in Agents view so the sidebar prioritizes, for example, stormy or expensive agents.
- `notification.show` can surface threshold alerts through Herdr.
- `pane.read`, `agent.read`, `agent.wait`, and `agent.prompt` enable current-pane drilldowns and closed-loop prompts.
- `plugin.pane.open` gives the plugin a managed terminal UI surface.
- `pane.graphics.*` exists for image overlays, but should be a later experiment, not an MVP dependency.

The strongest ccxray use of Herdr is therefore **augmenting Herdr's own sidebar and focus model**, not replacing it.

## ccxray Assets To Bring Into Herdr

ccxray already has data Herdr and most plugins do not:

- Wire-level request/response capture for Claude Code, Codex, and Grok.
- Real-time dashboard and SSE stream (`/_events`) with entry summaries.
- Session/turn APIs (`/_api/entries`, `/_api/sessions`, `/_api/session/:sid/entries`).
- Cost/budget endpoints (`/_api/costs/current-block`, `/_api/costs/daily`, `/_api/costs/monthly`, `/_api/pricing`).
- System prompt version/diff APIs (`/_api/sysprompt/versions`, `/_api/sysprompt/diff`, `/_api/tools-diff`).
- Intercept endpoints for session toggling and approve/reject flows.
- Stable no-server usage contract via `ccxray usage --json`, documented in `docs/usage.md`.
- Per-entry summary fields in `server/sse-broadcast.js`: provider, agent, session id, cost, usage, context window, model, tool calls, tool failures, subagent classification, core/tool hashes, title, parent session id, and token breakdown.
- Existing deployment fields in `server/entry.js`: `CCXRAY_AGENT_ID`, `CCXRAY_USER_EMAIL`, `CCXRAY_TEAM`, `CCXRAY_AGENT_TYPE`, local date, timezone. These can become the bridge between Herdr pane identity and ccxray entries if the plugin's launcher wrapper sets them.

The first implementation should mostly compose existing ccxray surfaces. New ccxray core changes should be small and explicit, such as `ccxray status --json` or a first-class "current session by agent id" API.

## Marketplace Landscape

Official marketplace index snapshot:

- `generatedAt`: `2026-08-14T15:00:47.218Z`
- `pluginCount`: 632
- `repositoryCount`: 622
- Languages by repo: Rust 143, Shell 141, Python 104, JavaScript 94, Go 65, TypeScript 51.
- Common topics beyond `herdr-plugin`: `herdr`, `terminal`, `tui`, `claude-code`, `ai-agents`, `developer-tools`, `coding-agents`, `codex`.

Category counts below are keyword buckets over repository + manifest metadata, so they overlap:

| Category | Count | Representative competitors | What they own |
| --- | ---: | --- | --- |
| Review/diff/file | 159 | `persiyanov/herdr-reviewr`, `smarzban/herdr-file-viewer`, `alexarthurs/herdr-sidebar` | Reading code, diffs, PR context, comments |
| Layout/worktree/bootstrap | 208 | `cloudmanic/herdr-plus`, `herdr-worktrunk`, `herdr-spreader`, `sessionizer` | Starting and arranging workspaces |
| Issue trackers/GitHub/Jira | 199 | `ghzinga`, `herdr-plugin-github-start`, `herdr-jira`, `worktree-from-linear` | Pulling tasks into Herdr |
| Session/history/search | 129 | `nicosuave/memex`, `session-digger`, `herdr-agent-inbox` | Finding and resuming past sessions |
| Remote/mobile/notify | 67 | `AltanS/collie`, `dcolinmorgan/herdr-remote`, `herdr-mobile-relay` | Checking agents from phone/menu bar |
| Observability/usage/cost/context | 72 | `llmtrim-herdr`, `herdr-agent-usage`, `herdr-token-dashboard`, `herdr-telemetry` | Token/cost/context/status visibility |
| Browser | 28 | `ogulcancelik/herdr-browser`, `StructuPath/herdr-browser` | Browser panes and CDP |

### Direct Competitor Notes

- `fkiene/llmtrim-herdr`: routes agent panes through a token-compression proxy and shows savings badges. Strong "money saved" story; not a wire-level forensic tool.
- `senna-lang/herdr-agent-usage`: per-pane context meters, provider limits, backend spend. Strong sidebar fit; depends on harness-local records and does not expose full request/response causality.
- `Davidcreador/herdr-token-dashboard`: live token/cost dashboard and notifications for multiple agents. It reconstructs from provider transcripts/rollouts; ccxray can be more authoritative where it proxies live traffic.
- `DIodide/herdr-telemetry`: streams workspace/agent telemetry with privacy-first defaults. It is a data pipe; ccxray should be an interactive diagnostic product.
- `nicosuave/memex`: local history search and resume across agent transcripts. Very strong memory/search adjacency; ccxray should integrate by linking/starring evidence, not compete on full transcript search first.
- `persiyanov/herdr-reviewr`: owns review workflow and line comments. ccxray should feed it "why this diff happened" evidence, not build another file viewer.
- `AltanS/collie` / `dcolinmorgan/herdr-remote`: own remote control and mobile notifications. ccxray should provide better alert signals, not remote shell UI.

The gap: none of the close competitors combine **wire-level causality + live Herdr pane metadata + agent guardrails**. That is ccxray's wedge.

## Product Concept

Working name: **ccxray for Herdr**

Tagline: **X-ray vision for every Herdr agent.**

Marketplace description:

> Live request-level observability for Claude Code, Codex, and Grok panes in Herdr: cost, context pressure, cache health, tool failures, prompt diffs, intercept controls, and one-click forensic drilldown.

Primary user promise:

> "When an agent looks stuck, expensive, or suspicious, I know why without leaving Herdr."

## Proposed Plugin Surfaces

### Actions

- `launch-claude`, `launch-codex`, `launch-grok`: start the agent through `ccxray` in the current or new pane.
- `open-mission-control`: open the ccxray Herdr TUI pane.
- `open-current-session`: open/focus the exact ccxray dashboard URL for the current Herdr pane/session.
- `summarize-current-pane`: produce a compact diagnostic summary from ccxray data and optionally paste/send it to the agent.
- `toggle-intercept-current-session`: toggle ccxray intercept for the mapped session.
- `star-current-session` / `star-current-turn`: preserve evidence in ccxray.
- `apply-xray-agent-view`: use `agent.view.set` so Herdr's Agents view prioritizes panes with ccxray alerts.
- `doctor`: verify Herdr socket, ccxray install, ccxray hub, auth/loopback reachability, mapping confidence, and statusline/rate-limit setup.

### Panes

- `mission-control`: a compact TUI with all observed Herdr panes, current status, spend, context %, cache hit, weather, and last risky turn.
- `session-xray`: focused view for one pane/session with turns, cost waterfall, tool failures, prompt/cache churn, and dashboard links.
- `usage-budget`: account/provider cost and quota view, backed by ccxray cost APIs and `ccxray usage --json`.

### Startup Hook

One-shot restore:

- Reconnect to ccxray if a known hub is running.
- Reapply saved `agent.view.set` projection if the user enabled it.
- Start or refresh a lightweight watcher if the plugin uses one.
- Reapply pane/workspace metadata tokens from saved state, then let live SSE replace them.

Important: because Herdr startup hooks are not supervised daemons, the watcher should have a visible health token and a `doctor` action.

### Event Hooks

- `pane.agent_detected`: if the pane is an agent but not observed by ccxray, report a subtle token like `xray: off` and offer launch/wrap guidance.
- `worktree.created`: optionally create an X-rayed agent pane using project defaults.
- `pane.closed` / `workspace.closed`: clean plugin-owned mapping state.

### Link Handlers

- Capture `http://localhost:<ccxray-port>/...` ccxray links and open/focus the matching Herdr context.
- Capture local diagnostic links emitted by plugin panes, e.g. `ccxray://session/<sid>/turn/<id>`, and route to actions.

## Identity and Data Mapping

Mapping Herdr panes to ccxray sessions is the hardest product seam.

MVP should avoid magic where possible:

1. Plugin launcher wrappers start `ccxray claude|codex|grok` inside Herdr panes.
2. The wrapper exports stable identity into ccxray:
   - `CCXRAY_AGENT_ID=herdr:<pane_id>` or `herdr:<workspace_id>:<pane_id>`
   - `CCXRAY_AGENT_TYPE=claude|codex|grok`
   - optional `CCXRAY_TEAM`, `CCXRAY_USER_EMAIL`
3. ccxray persists these fields in index rows already.
4. The plugin watcher reads ccxray entries and updates the Herdr pane with `pane.report_metadata` tokens.

For pre-existing unmanaged panes, use heuristic fallback only:

- Match by provider/agent + cwd + recent activity + Herdr `agent_session` if available.
- Show confidence in the UI (`linked`, `likely`, `unlinked`) so users are never fooled by false attribution.

Future ccxray core nicety:

- Add `ccxray status --json`.
- Add `/_api/herdr/panes` or `/_api/sessions?agentId=...`.
- Persist `HERDR_PANE_ID` automatically when present, or map it into `agentId` if `CCXRAY_AGENT_ID` is unset.

## What Makes Users Unable To Leave

The plugin should create recurring "I need this" moments:

1. **Launch habit**: starting agents via `ccxray launch` becomes the default because it gives immediate pane badges and better postmortems.
2. **Trust habit**: a green X-ray badge means "this agent is observed"; no badge means "I am flying blind."
3. **Triage habit**: Herdr's Agent view floats stormy, costly, blocked, or context-critical panes to the top.
4. **Intervention habit**: intercept is one key away when the next turn looks dangerous.
5. **Postmortem habit**: when a run goes wrong, the exact turn, prompt diff, tool failure, and cost trail are already preserved.
6. **Budget habit**: cache expiry, quota pressure, and runaway spend appear where the user is already working, not in a separate browser tab.

The winning mental model is:

> Herdr shows where my agents are. ccxray shows what they are doing to the model, context, tools, and budget.

## MVP

MVP name: **X-ray Launch + Live Badges**

Must ship:

- Installable Herdr plugin with manifest actions and one mission-control pane.
- Actions to launch Claude/Codex/Grok through ccxray from Herdr.
- Pane/session mapping for plugin-launched agents.
- Live metadata tokens per observed pane:
  - `xray` status: `on`, `off`, `stale`, `err`
  - context percent
  - current session cost
  - cache hit or cache warning
  - last tool failure/risk
  - session weather/attention marker
- Mission Control TUI that consumes ccxray APIs/SSE and lists observed panes.
- `doctor` action with actionable setup checks.
- Clear README trust disclosure: local proxy, what data is captured, where logs live, no cloud by default, no sandbox.

Should not ship in MVP:

- Full terminal clone of the web dashboard.
- Remote/mobile access.
- Automatic prompt rewriting or autonomous intervention.
- Deep historical search competing with memex.
- Native graphics overlays.

## Phase Roadmap

### Phase 0: Compatibility Probe

- Verify Herdr versions and exact minimum required for `agent.view.set`, plugin panes, link handlers, metadata tokens, and popup placement.
- Decide minimum Herdr version. Conservative default: `0.8.0` until tested lower.
- Verify ccxray auth behavior from local plugin processes, especially if `CCXRAY_LOOPBACK_REQUIRE_AUTH=1`.
- Verify Windows: Herdr raw socket is named pipe; ccxray hub is narrower on Windows. Use CLI wrappers first, mark Windows as beta.

### Phase 1: MVP

- Manifest: actions, startup hook, mission-control pane.
- Wrapper scripts: launch `ccxray claude|codex|grok` with Herdr identity exported.
- Watcher: read `/_api/entries`, then tail `/_events`; fallback to `ccxray usage --json` when no server exists.
- Herdr metadata: update pane tokens and optional workspace rollup.
- Mission Control TUI: table + current session drilldown + dashboard URL.

### Phase 2: Guardrails

- Current-session intercept toggle.
- Threshold notifications:
  - context over 80/90%
  - cache TTL danger
  - tool failure burst
  - cost spike
  - prompt/tools hash churn
- Agent view projection: "needs X-ray attention".
- Diagnostic prompt: send a concise ccxray summary back to the current agent.

### Phase 3: Evidence Workflow

- Star current turn/session from Herdr.
- Export/share "run report" Markdown from a session.
- Link with review workflows: open reviewr/memex with ccxray evidence instead of competing with them.
- Add deep links from Herdr panes to ccxray dashboard and back.

### Phase 4: Fleet and Teams

- Multi-project and multi-machine summary.
- Optional telemetry export with explicit opt-in.
- Team labels from `CCXRAY_TEAM` and `CCXRAY_USER_EMAIL`.
- Policy packs for budget/context guardrails.

## Technical Architecture Sketch

Recommended implementation language: Node.js initially.

Reasons:

- ccxray already requires Node >= 18.
- Node can parse SSE via `fetch` streaming without adding dependencies.
- Herdr plugins can be arbitrary argv commands.
- A later Go/Rust rewrite can improve packaging if the marketplace demands single binaries.

Processes:

1. `launcher` action/pane command: exports identity, starts `ccxray <agent>`.
2. `watcher` startup/action command: maintains ccxray connection and reports metadata to Herdr.
3. `mission-control` pane command: renders a keyboard TUI or simple terminal table, using the same local data client.
4. `doctor` command: synchronous checks and setup advice.

Data flow:

```
Herdr pane -> plugin launcher -> ccxray <agent> -> upstream API
                      |              |
                      |              v
                      |       ccxray logs + SSE + APIs
                      v              |
              identity env           v
                    Herdr metadata <- plugin watcher
                    Herdr pane UI  <- mission-control pane
```

## Marketplace Strategy

Repository:

- GitHub public repository with topic `herdr-plugin`.
- Root `herdr-plugin.toml` unless repo must also host ccxray code; root is easier to install and list.
- Marketplace card should lead with "request-level observability", not "token dashboard".

Suggested metadata:

- id: `ccxray.herdr`
- name: `ccxray`
- description: `X-ray vision for Herdr agents: cost, context, cache, tool failures, prompt diffs, and intercept controls for Claude Code, Codex, and Grok.`
- topics: `herdr-plugin`, `ccxray`, `observability`, `claude-code`, `codex`, `ai-agents`, `token-usage`, `developer-tools`.
- platforms: start `linux`, `macos`; add `windows` only after named-pipe + ccxray launcher testing.

README must show:

- One-command install.
- One-key launch path.
- Before/after screenshot or terminal capture: Herdr agent list with X-ray badges.
- "What data is captured" and "What never leaves your machine".
- How to disable/remove, where config/state/logs live.
- Compatibility table for Herdr and ccxray versions.

## Risks

| Risk | Why it matters | Mitigation |
| --- | --- | --- |
| False pane/session mapping | Users may act on wrong diagnostics | Prefer plugin-launched panes; show confidence; expose `doctor` |
| Auth and loopback differences | Plugin may fail to read ccxray APIs | Use local loopback default; support explicit token/config; add `ccxray status --json` |
| Startup hook is not supervised | Badges can go stale silently | Watcher heartbeat token + manual restart action |
| Trust burden | ccxray proxies sensitive prompts and credentials | Transparent local-only docs, source review, no cloud default, pin install refs |
| Marketplace crowding | Many plugins already claim usage/context | Position on wire-level causality + guardrails, not generic meters |
| Windows behavior | Herdr transport + ccxray hub differ | Use CLI wrappers; mark Windows beta until tested |
| Competing with review/search plugins | Dilutes product | Integrate and deep-link instead of rebuilding file review/history search |

## Open Questions

1. Should the plugin live in the ccxray repo or a separate `ccxray-herdr-plugin` repo? Separate repo is marketplace-cleaner; monorepo is easier for shared releases.
2. Should ccxray core automatically persist `HERDR_PANE_ID` as `agentId` when available?
3. Should Mission Control be a terminal TUI, a simple textual dashboard, or an optional action that opens the existing browser dashboard through `herdr-browser`?
4. What is the lowest Herdr version that reliably supports every needed surface?
5. Should intercept controls be hidden behind an explicit opt-in because they can alter live requests?

## Recommendation

Build **Phase 1: X-ray Launch + Live Badges** first.

That is the smallest product that proves ccxray belongs inside Herdr:

- It uses Herdr-native surfaces users already scan.
- It exploits ccxray's unique wire data.
- It avoids rebuilding crowded marketplace categories.
- It creates a launch habit and a trust habit.

Once users rely on the badges, Mission Control and guardrails become natural rather than decorative.
