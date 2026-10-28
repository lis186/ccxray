# Herdr restart and agent resume research (#674)

Research date: 2026-10-29. Repository baseline: `cf4fac7`; plugin manifest version `0.4.0`. Scope: research only; no product behavior change.

- Herdr restores layout after a server restart; restoring an agent conversation additionally needs a valid native session reference. The ccxray launch action does not supply one.
- Herdr already has native auto-resume. Prefer investigating its integration prerequisites before building a second launcher; that recommendation is a proposal, not an approved behavior change.
- A resumed conversation can lose ccxray routing. Preserving proxy configuration and preventing duplicate launches require separate acceptance checks and an owner decision below.

## Evidence and limits

The [issue](https://github.com/lis186/ccxray/issues/674) reports empty restored shells, a new Grok session ID after relaunch, and continued ccxray recording. Its body was retrieved during this run with `gh issue view 674 --repo lis186/ccxray --json title,body`. Those are reporter observations, not a restart reproduced here.

Only repository files, public documentation, and local CLI help were inspected. Installed CLI help identifies Herdr `0.9.5`; it does not establish the running server version or the version at the incident. No live integration status, session snapshot, pane, agent transcript, or user configuration was read. No server or pane was stopped, started, restarted, or mutated. No actual agent CLI or ccxray command was launched.

Public pages were fetched on the research date; their current contracts must not be projected backward onto the incident. Local file:line citations below refer to the baseline. The plugin declares only Herdr `0.8.0` as its minimum at [`herdr-plugin.toml:4`](../../plugins/herdr/herdr-plugin.toml#L4); that alone does not guarantee every newer restore feature.

## Root cause (two lines)

The plugin launches a fresh native agent and stores routing attribution, but neither its startup hooks nor its routed-pane record register a resumable native session with Herdr.
Herdr needs integration-reported native session identity to resume after process loss; absent that eligible reference it restores shells, and invoking the plugin's fresh-launch action creates a new conversation.

This is the code-level explanation and a supported failure path, not proof that the affected installation lacked a particular hook. Disabled restore, an outdated integration, rejected/stale identity, or unavailable native session storage remain possible incident causes.

## What the plugin actually does

| Boundary | Evidence | Consequence |
| --- | --- | --- |
| User launch | [`herdr-plugin.toml:42`](../../plugins/herdr/herdr-plugin.toml#L42), [`launch-agent.js:34`](../../plugins/herdr/bin/launch-agent.js#L34) | Each agent action invokes `launch-agent.js`; parsing exposes placement/port/plan settings, no resume ID. |
| Pane creation | [`launch-agent.js:68`](../../plugins/herdr/bin/launch-agent.js#L68), [`launch-agent.js:152`](../../plugins/herdr/bin/launch-agent.js#L152) | Ensures proxy, creates a new tab or split, injects routing environment. Repeating the action creates another pane rather than recovering an existing one. |
| Identity | [`launch-agent.js:110`](../../plugins/herdr/bin/launch-agent.js#L110), [`launch-agent.js:188`](../../plugins/herdr/bin/launch-agent.js#L188) | A minted launch token links traffic to a pane. It is not the agent's native session ID. |
| Durable record | [`lib/ccxray.js:2572`](../../plugins/herdr/bin/lib/ccxray.js#L2572) | Writes only `paneId`, `agent`, `routedAt`, optional `launchId`; no native ID, cwd, resume argv, or restore policy. The five-minute `routedPaneKnown` check is attribution freshness, not a resume retention policy. |
| Native launch | [`launch-agent.js:197`](../../plugins/herdr/bin/launch-agent.js#L197) | Calls `herdr agent start … --kind … --pane …`. Only Codex gets extra proxy configuration arguments. No provider gets native resume arguments. |
| Failure handling | [`launch-agent.js:201`](../../plugins/herdr/bin/launch-agent.js#L201) | Retries only `agent_pane_busy`; a detection failure can occur after launch. A timeout must never be interpreted as permission to launch again blindly. |
| Startup | [`herdr-plugin.toml:11`](../../plugins/herdr/herdr-plugin.toml#L11), [`refresh-all-badges.js:15`](../../plugins/herdr/bin/refresh-all-badges.js#L15) | Startup refreshes detected agents' metadata and opens first-run onboarding; it does not walk saved launch records and resume agents. |
| Badge versus session authority | [`lib/ccxray.js:2720`](../../plugins/herdr/bin/lib/ccxray.js#L2720), [`lib/ccxray.js:2760`](../../plugins/herdr/bin/lib/ccxray.js#L2760) | Reads `agent_session` when available, but writes `report-metadata`. Display tokens do not register native restore identity. |
| Older runner | [`run-agent.js:81`](../../plugins/herdr/bin/run-agent.js#L81) | Constructs `ccxray --no-browser <agent>` with no resume ID. Current launch actions use the native path above; changing this older runner alone would not fix them. |

The existing dashboard's resume templates already distinguish the commands: [`server/providers.js:434`](../../server/providers.js#L434), [`:443`](../../server/providers.js#L443), [`:451`](../../server/providers.js#L451). A displayed command template does not schedule a restore.

## Herdr's existing recovery contract

[Session state and restore](https://herdr.dev/docs/session-state/#native-agent-session-restore) distinguishes restored layout from surviving processes. Native restore is enabled by default, controlled by `[session] resume_agents_on_restore`. Current minimum integration versions are Claude **6**, Codex **5**, Grok **2**. Eligible panes resume after a client supplies terminal size/theme; invalid, missing, stale or duplicate references fall back to shells. Detach and live handoff have different process-survival semantics. No such operation was exercised here.

[Integrations](https://herdr.dev/docs/integrations/) explains that these agents' integrations report session identity separately from screen-based lifecycle detection. Grok uses `SessionStart`; current installation writes its own hook files under the agent configuration directory. Installing an integration changes user configuration and was intentionally not performed. Screen detection succeeding is therefore insufficient evidence of resume eligibility.

[CLI reference](https://herdr.dev/docs/cli-reference/) documents `pane report-agent-session`, `--agent-session-id` / `--agent-session-path`, and optional resume argv after `--`. The command name must be a plain PATH executable, and arguments cannot contain apostrophes. `agent_session` is readable from pane/agent metadata when reported. These constraints make arbitrary saved shell command strings an unsuitable resume format.

[Plugin startup documentation](https://herdr.dev/docs/plugins/#startup-hooks) says startup hooks run asynchronously after session restoration and socket readiness, including live handoff. They are one-shot initialization, not supervised services. A plugin startup hook is therefore neither proof that native resume has finished nor permission to start another agent.

Local, non-mutating help was inspected with temporary homes:

```text
herdr --help
herdr --version                         # 0.9.5
herdr agent --help
herdr pane --help
herdr agent start --help
herdr pane report-agent-session --help
```

`agent start` accepts `[-- AGENT_ARG...]`, requires an existing shell at its interactive prompt, and waits for the expected agent to become ready. It is not itself a restart-persistence option. `report-agent-session --help` confirms the native ID/path and resume-argv interface. No help command targeted the server socket.

## Resume options by agent

Commands below are proposed argv shapes, never executed in this research. `<native-id>` is a placeholder, not recorded session content.

| Agent | Exact-session option | Other options and limitations |
| --- | --- | --- |
| Claude | `claude --resume <native-id>` (alias `-r`) | Bare `--resume` opens a picker; `--continue` / `-c` selects the most recent conversation for the directory. `--fork-session` changes identity. Persistence must exist. [Official CLI reference](https://code.claude.com/docs/en/cli-reference#cli-flags). |
| Codex | `codex resume <native-id>` | This is a subcommand, not generic `codex --resume`. Bare resume selects interactively; `--last` uses recency and `--all` widens selection. Cwd mismatch can prompt; an explicit `--cd` takes precedence in current docs. Retain applicable `-c` proxy overrides. [Official developer commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli#codex-resume). |
| Grok | `grok --resume <native-id>` (alias `-r`) | Omitted ID uses recency; `--continue` / `-c` uses the current directory. `--fork-session` creates another ID; `--session-id` is a new-session option, not interchangeable recovery. [Official CLI reference](https://docs.x.ai/build/cli/reference). |

Grok's [sessions guide](https://docs.x.ai/build/features/sessions) describes local saved sessions. For all agents, a wire-log ID alone is insufficient: the matching CLI must have compatible persisted conversation state in the intended account/configuration scope. Never substitute latest-session selection when an exact ID cannot be verified.

ccxray accepts explicit wire IDs from several header/metadata shapes, but falls back to inferred raw buckets: [`openai.js:52`](../../server/wire-parsers/openai.js#L52), [`openai.js:292`](../../server/wire-parsers/openai.js#L292). Grok has its own header names and `grok-raw` bucket at [`providers.js:350`](../../server/providers.js#L350). Reject raw/inferred buckets, subagent IDs and mismatched kinds as automatic resume candidates. A telemetry ID must be corroborated against the pane's current native identity; shared cwd or the latest global session is not sufficient. The existing display fallback at [`lib/ccxray.js:1415`](../../plugins/herdr/bin/lib/ccxray.js#L1415) must not become a recovery selector.

## Routing and operational risks

- **Conversation restored, recording lost:** Claude receives base URL/custom headers; Grok receives `GROK_CLI_CHAT_PROXY_BASE_URL`; Codex receives actual `-c` overrides. See [`lib/ccxray.js:2983`](../../plugins/herdr/bin/lib/ccxray.js#L2983), [`:3040`](../../plugins/herdr/bin/lib/ccxray.js#L3040). A canonical native resume command does not prove those settings survive. Whether Herdr persists the injected pane environment and original Codex args must be verified with synthetic fixtures against the supported version; public restore docs do not guarantee this.

- **Proxy unavailable:** The hub hold happens once during launch ([`launch-agent.js:170`](../../plugins/herdr/bin/launch-agent.js#L170)). After pane shell loss, liveness registration and proxy readiness need fresh validation. Do not reuse old PIDs, ports or authentication material as current evidence.

- **Double execution:** Native restore, plugin startup, handoff and repeated hook delivery can overlap. Checking only for an empty shell is insufficient while another restore is pending. Never send a prompt, Enter, approval answer, or replay the unfinished task as part of resume. Agents or their startup hooks may themselves continue pending work; exactly-once external side effects cannot be promised.

- **Wrong target:** Pane moves, removed workspaces, reused server-scoped IDs, session rotation, shared cwd, subagents and failed launches can invalidate old mappings. Record server/session scope and provenance; refuse ambiguous matches. A routing token is not a resume ID.

- **Privacy and command injection:** Persist a minimal typed record, never prompts, transcripts, arbitrary environment, secrets or fully expanded authenticated command lines. Use argv plus provider allowlists; validate IDs and schema, permissions and atomic writes. Treat untrusted IDs containing shell syntax, flags, quotes or control characters as invalid. Herdr's quoting restrictions also constrain wrapper designs.

- **Missing state or changed CLI:** Removed/compacted native state, changed account/configuration root, missing executable/cwd, outdated hooks and trust/auth dialogs should produce an explicit unavailable/blocked result. Do not silently create a fresh conversation or bypass permissions.

## Proposed implementation (conditional; no code authorized)

**Minimality check:** The smallest first change is a read-only readiness diagnostic plus guidance for Herdr's existing restore path. A new startup resume engine is substantially more work and introduces two restore owners. Add it only if synthetic evidence proves the native route cannot satisfy traced recovery.

1. Extend a future doctor/Quick Start check to distinguish screen detection, native session reporting, supported integration versions, restore policy and tracing readiness. It should diagnose only; integration installation remains a separate explicit action. Do not scan transcripts or start the proxy to answer readiness.

2. First evaluate **Herdr-owned recovery** with synthetic agents and current official integrations. Confirm exact native identity is saved and restored, and whether pane environment plus Codex overrides survive. Keep ccxray on `report-metadata`; do not overwrite integration session ownership just to attach badges.

3. If proxy routing does not survive, propose a small provider-aware resume entrypoint that reconstructs proxy settings from fresh configuration before launching the exact native session. Reuse `proxyEnvVars`, `codexAgentArgs` and existing provider launch rules. Resolve auth at invocation time; persist no secrets. Whether Herdr will accept and retain a plugin wrapper as resume argv without an integration overwriting it is an explicit feasibility check, not an assumed API guarantee. The current `run-agent.js` would need redesign before serving that purpose.

4. Only if approved instead, build **plugin-owned recovery** with a separate versioned resume record: server/session scope, pane/workspace, agent kind, native ID and provenance, cwd, non-secret routing identity, policy, lifecycle generation and attempt state. Update on verified native-session changes; retire on confirmed exit/closure. Do not repurpose five-minute routing records as session history. Recovery needs an exclusive claim and a reconciled pending/native-restore state, bounded retries, a terminal failed/blocked state, and explicit manual retry. Do not implement both owners racing to launch.

5. Keep manual exact-session recovery available for unsupported/ambiguous cases. A future resume action must target the existing intended pane; calling today's fresh-launch action is not an acceptable substitute.

### Invariants

- **INV-1:** Given one verified pane/native session binding, recovery preserves its agent kind and exact native ID. Missing or contradictory identity fails closed without choosing another conversation.

- **INV-2:** Given duplicate startup events, a live agent, pending native restore or handoff, no second agent or task submission is launched. Unknown ownership prevents automatic recovery.

- **INV-3:** Given a traced session, recovery verifies current routing/auth/proxy readiness before claiming tracing restored. Native conversation recovery alone cannot satisfy this claim.

- **INV-4:** Given stored recovery metadata, it contains no conversation content or secrets; invalid records and command arguments never reach process launch.

### Acceptance criteria and test plan

All future automated tests use temporary HOME/config/state roots, invented IDs, fake provider executables and a fake Herdr command/socket. No live server, real transcript or default product port is required.

| Observable pass/fail case | Check | Invariants |
| --- | --- | --- |
| Claude, Codex and Grok each receive the exact provider-specific resume argv; no latest/picker/fork or prompt argument | Pure argv tests and fake executable capture; include Codex configuration ordering | INV-1, INV-4 |
| Native ID changes during clear/fork; old mapping cannot be resumed automatically | Synthetic lifecycle event and persisted-record tests | INV-1 |
| Missing, inferred/raw, stale, duplicate, wrong-kind or child-session IDs cause zero launches and a diagnostic | Table-driven identity validation, including two panes with one cwd | INV-1, INV-4 |
| Startup delivered twice, during handoff, or while native resume is pending causes at most one launch | Concurrent claim/reconciliation tests; live-agent and busy-shell cases | INV-2 |
| Timeout after launch does not retry launch; auth/trust dialog stays blocked | Fake CLI returns ambiguous timeout and detected-process evidence | INV-2 |
| Restored conversation uses current proxy routing and fresh auth while keeping native ID | Synthetic Claude headers, Grok proxy env, Codex OAuth/API-key argv fixtures; no secrets in serialized state | INV-1, INV-3, INV-4 |
| Missing cwd/binary/native storage or unavailable proxy produces an honest failed/blocked result | Fake filesystem and spawn/proxy adapters; verify no silent new session | INV-1, INV-3 |
| A future owner-authorized isolated restart restores both identity and tracing | Dedicated disposable Herdr session with fake agents; verify eligibility, client-attach timing and environment/argv persistence | INV-1–4 |

The last check is a later opt-in integration experiment, not performed here. Before a product implementation is accepted, its supported Herdr/agent versions must be pinned, these checks must pass, environment documentation updated if knobs change, and one Unreleased changelog line added. This research changes no behavior, so CHANGELOG.md is unchanged.

## WAITING FOR APPROVAL

- **Recovery owner:** Choose Herdr-owned native recovery with ccxray readiness/routing support (recommended), plugin-owned recovery with native auto-resume explicitly excluded for those panes, or manual resume only. This research does not choose or enable a product policy.

- **Failure policy:** Decide whether unavailable ccxray tracing blocks resume or permits an explicitly labelled direct resume. Decide opt-in scope and whether only interactive restoration is intended; conversation recovery must not imply replaying unfinished actions.

- **Live verification / installation:** Checking the affected integration versions/configuration, installing hooks, or testing a real restart would inspect or mutate protected user state. All were skipped as instructed. The synthetic isolated integration test above also needs authorization outside this research run.

- **Agentflow bookkeeping:** The canonical stream notebook is missing and automatic capture failed. No existing Ask was found in the workspace's absent `.agentflow/`; no notebook, lock or ownership was created or taken over. Restoring a canonical history requires a trusted source. Research continued independently; `.agentflow/` is ignored and excluded from commits.

## Verification in this run

No new or changed test files: focused changed-test count **0**, not applicable for this documentation-only deliverable. No product files changed. `.gitignore` adds `.agentflow/` as explicitly requested.

The required unit command ran under Node `v22.23.4`, with a fresh temporary HOME and the three required variables unset. Additional account/config selectors and Herdr connection variables were removed. The final invocation was:

```bash
env -u CCXRAY_AGENT_ID -u ANTHROPIC_BASE_URL -u OPENAI_BASE_URL \
  -u CODEX_HOME -u CLAUDE_CONFIG_DIR -u GROK_HOME -u CCXRAY_HOME \
  -u HERDR_SOCKET_PATH -u HERDR_BIN_PATH -u CCXRAY_EXPORT_DISABLE \
  HOME="$(mktemp -d)" NODE_OPTIONS=--require=/tmp/ccx674-test-guard.cjs \
  node scripts/run-tests.js unit
```

The temporary, uncommitted safety preload adds `--test-skip-pattern='hub fork and readiness'` to the runner's child test invocation, prevents product `server/index.js` forks, and rejects socket connect/listen attempts on ports 5577/5578 before calling the OS. It also skips that same suite for direct diagnostic execution. The repository's home and outbound-network guards remain loaded by the unit runner. This guarded run is necessary because [`test/hub.test.js:381`](../../test/hub.test.js#L381) actually forks a product hub, which this task expressly forbids. Both tests in `hub fork and readiness` were intentionally excluded; a direct diagnostic confirms the suite was marked SKIP. No forbidden hub launch was attempted.

**Final runner result: exit 1; 155 file-level results, 142 passed, 13 failed, 0 file-level skips.** The runner emitted file-level summaries, not individual assertion totals; these numbers must not be reported as 142 passing assertions. The intentionally skipped nested hub suite is not reflected in that outer skip counter. An earlier guarded run with `CCXRAY_EXPORT_DISABLE=1` produced the same 142/13 file-level result; removing that extra override did not fix the final run. No test passed merely by changing product code.

Direct diagnostic runs used the same temporary-home isolation and safety preload, with `node --require ./test/helpers/home-guard.js --require ./test/helpers/no-network.js test/<name>.test.js`. They exposed the following socket restrictions; unlike the final unit run, these diagnostics retained `CCXRAY_EXPORT_DISABLE=1` and were not launched with `--test`, so their export assertions are not comparable to the final runner. A Node-based attempt to spawn diagnostic children was itself refused with EPERM; shell-launched diagnostics provided the evidence below. No escalation or unsandboxed retry was requested.

| Failed file in the final runner | What could not be verified here |
| --- | --- |
| `test/auth-bootstrap.test.js` | HTTP bootstrap suite at line 306: `listen EPERM` on loopback; hook failure canceled dependent tests. |
| `test/body-limit.test.js` | HTTP server fixture at line 55: loopback `listen EPERM`; both tests canceled. |
| `test/export-diagnostics.test.js` | Tests at lines 314, 400, 406, 412 and 451 require loopback or fixture Unix sockets; each hit `listen EPERM`. |
| `test/grok-billing-fetch.test.js` | Server fixture at line 70: loopback `listen EPERM`; eight tests canceled. |
| `test/hub-owned-config-status.test.js` | Fixture Unix socket `listen EPERM`; six tests canceled. |
| `test/hub.test.js` | Socket client registration, socket health/discovery and TCP listener cases hit `listen EPERM`; the separate `hub fork and readiness` suite was intentionally skipped. Only fixture socket handlers were exercised, never a product hub. |
| `test/listen-hosts.test.js` | Default loopback binding, PROXY_HOST binding, port-conflict and listener lifecycle cases failed with `listen EPERM`; IPv6-dependent checks also skipped. |
| `test/openai-sse-title-gen-wiring.test.js` | Server fixture at line 47: loopback `listen EPERM`; the test canceled. |
| `test/security-headers.test.js` | All four HTTP response checks hit loopback `listen EPERM`. |
| `test/launcher-shims.test.js` | Three diagnostic assertion failures: removal-with-consent, removal failure propagation, and plain removal byte restoration. One failure's output explicitly reports loopback bind EPERM; the third's cause remains unresolved. |
| `test/export-cross-agent-dup.test.js` | Failed final file; direct diagnostics had exporter suppression/absent cursor assertions. The different diagnostic environment cannot establish the final runner's cause. |
| `test/export-sync-test-guard.test.js` | Failed final file; direct execution additionally lacks the `NODE_TEST_CONTEXT` supplied by `--test`. Final-run cause remains unresolved. |
| `test/export-sync.test.js` | Failed final file; diagnostic export assertions were affected by its disable override. Final-run cause remains unresolved. |

These are incomplete environment-constrained checks, not a clean unit pass or evidence of a resume implementation. No claim is made that all 13 failures are explained by loopback restrictions. Existing failures were left untouched to preserve research-only scope.

`git diff --check` passed, and a read-only script validated all 26 local citation targets and line bounds. Source citations, saved report contents and changed paths were reviewed. No behavior changed, so no Unreleased changelog line was added.

Local commit outcome: `git add .gitignore docs/research/674-herdr-resume.md` failed because the shared Git worktree directory is read-only. The required single attempt at `git commit -m "docs: research Herdr agent resume after server restart"` failed for the same reason (`index.lock`: read-only filesystem). No escalation, retry, push, merge or PR was attempted. **No new commit SHA exists.** The dispatcher can stage and commit the two pending files: `.gitignore` and `docs/research/674-herdr-resume.md`.
