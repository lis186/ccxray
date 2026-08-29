# Hub-owned export/config status — design, for adversarial review

- Status: **draft rev 4, not signed off. Not implemented.**
- Rev 4 (2026-08-29): the shared export level is the `CCXRAY_HOME`, not the machine. Rev 3
  asserted the sharing as an unconditional property; it was measured and is false across
  homes (§2.3, third correction). Renames the level, adds `home` to the identity tuple,
  adds matrix rows 13c and 14. Owner measured the seven-process evidence; the process
  liveness, home distinctness, and cursor presence in that table were re-verified
  independently here rather than relayed.
- Review: two adversarial rounds, two independent reviewers each (2026-08-28). Round 1
  returned NEED-EXPERIMENT-FIRST; round 2 returned DON'T SHIP and "not ready to
  implement", with five majors between them, all complementary rather than conflicting.
  Round 2's corrections are folded in and marked. One reviewer correction was itself
  wrong and is recorded as such in §9 — a review finding is an input, not a verdict.
- Date: 2026-08-28
- Scope: give the hub one authoritative answer to "is this `CCXRAY_HOME` exporting, and is
  this exporter's config sane", and make every surface read that answer instead of
  guessing locally. (Rev 3 scoped this to "this machine"; see §2.3's third correction for
  the measurement that narrowed it.)
- Not in scope: PR #592's contents. This is deliberately a separate unit — see §6.

## 1. The defect, stated as a mechanism

Two diagnostics currently exist and neither reaches the person who needs it under
`ccxray <agent>`, which is the common launch path:

| Diagnostic | Where it is produced | Why it does not arrive |
|---|---|---|
| `CCXRAY_EXPORT_CONFIG_DIRS` is set, so export refuses | `server/export-sync.js`, `console.log` | `server/index.js:151` mutes `console.log` in agent AND hub mode, so it reaches nothing at all inside a hub |
| A non-absolute import scan root was rejected | `server/importer.js`, `console.error` | not muted, but `server/hub.js:239` spawns the hub with `stdio: ['ignore', fd, fd]` — both streams go to `hub.log`, which nobody reads |

The current mitigation prints both from the foreground client
(`server/index.js:1058-1066`). That fixed delivery and left the source wrong:

```
server/hub.js:234    const env = { ...process.env };   // frozen at fork
```

A detached hub is long-lived — one observed running three days — so its environment is a
snapshot from whenever it was forked. The client prints its OWN `process.env`. The two
diverge in both directions:

- operator fixes a bad value and relaunches → client is clean and silent, hub still
  carries the bad value and is still broken;
- hub was forked before the operator set a bad value → client warns, hub is fine.

So the warning answers "does this shell have a problem" while the reader believes it
answers "does the running exporter have a problem". **A visible warning about the wrong
subject is worse than no warning: it is mistaken for having checked.**

This was raised as a finding three times — twice against the tombstone, once against the
root warning — and patched twice on the client side. It is not a delivery bug.

## 2. Decision

**The hub computes its own state, in its own process, from its own environment, and
every surface reports what the hub said.** Where there is no hub, the process reporting
is the process doing the work, so reading local env is correct there and stays.

### 2.1 The payload

Added to `getHubStatus()` (`server/hub.js:563`) and to the `register` reply
(`server/hub.js:341`, currently `{ok, firstClient}`):

```js
exportState: 'enabled' | 'refused' | 'unconfigured' | 'suppressed',
exportReason: 'config-dirs-retired' | 'explicitly-disabled' | 'test-run' | null,
configWarnings: Array<{ code: string, args: Record<string, unknown> }>,
```

- `enabled` — a bucket is configured and nothing local blocks a flush. **Not `active`**:
  the word claimed more than the value can attest. Nothing here can know that credentials
  are valid or the bucket is reachable, so a hub with dead ADC would have reported
  `active` forever — a new confident-wrong answer replacing the one being removed
  (reviewer A). If last-flush outcome is wanted later it is a separate field, not a
  reinterpretation of this one.
- `refused` — a retired//invalid control is set; `exportReason` names which.
- `unconfigured` — no `CCXRAY_EXPORT_GCS_BUCKET`. Not a fault; the common case.
- `suppressed` — export is off for a reason the operator chose or the harness imposed.
  Kept, because a smoke or test run reporting `unconfigured` would be a lie. But the
  REASON is split and neutral (`explicitly-disabled` / `test-run`): both reviewers
  objected to surfacing `NODE_TEST_CONTEXT` by name, and they were right — an internal
  harness variable is not a thing to explain to an operator.

`configWarnings` carries non-fatal config complaints (today: rejected non-absolute scan
roots) as `{code, args}`, rendered to prose at each surface. Reviewer A argued strings
suffice at this size; reviewer B argued for codes, and B wins on a point A itself
supplied — `exportReason` is already a code, so strings would leave the schema half
machine-readable and half prose. `ccxray status` prints a `Machine:` JSON line that
exists precisely to be parsed, and prose there becomes an unstable dependency.

### 2.2 Who computes what

`export-sync.js` and `importer.js` each expose a **pure** function returning values, not
logging: `configDirsRefusal()` and `relativeRootComplaints(env)` already exist in that
shape. The change is which process calls them — the hub, not the client.

### 2.3 The three surfaces

| Surface | Source | Rationale |
|---|---|---|
| hub-client attach (`index.js:1058`) | the `register` reply | the client is not the exporter; it must stop reading its own env |
| `ccxray status` (`index.js:968-1017`) | `getHubStatus()` over the socket | already the "what is running" command; add a human line and a `Machine:` field |
| standalone, and `--port N <agent>` | local env | correct as-is: no hub exists, so this process IS the exporter |

The third row is why this is not a blanket "never read local env" rule.

**Correction (reviewer A).** An earlier revision claimed exactly one configuration is
wrong. That is false, and the false part was an unverified architectural assumption of
mine — the same class of error this document exists to fix. `startExportSync()` is called
unconditionally by `startServer()` (`server/index.js:1217`), so EVERY server process is
an exporter, and a machine can run a hub alongside any number of `--port N` servers, each
frozen with its own environment. Measured on the author's machine while writing this:
**seven server processes live at once.** They serialize per flush through `export.lock`
(`export-sync.js:935-940`) but they are all exporting, and `ccxray status` reports the
hub only.

**Second correction (reviewer A, round 2).** Rev 2 answered this by going per-process:
"every exporter reports its own state". That is also wrong, in the opposite direction.
Export is not process-level: exporters serialize through one `export.lock` and advance one
shared `export-cursor.json` (`export-sync.js:936-941`). So a hub honestly reporting
`refused` while a clean `--port N` server flushes normally means summaries ARE reaching
GCS — and an operator reading that per-process answer escalates or restarts against a
pipeline that is working. Rev 1 claimed to know more than it could; rev 2 claimed to know
less. Both got the LEVEL of the report wrong.

**Third correction (rev 4, 2026-08-29 — measured, not reasoned).** Rev 3 named that
shared level **machine**, and asserted the sharing as an unconditional property. It is
not. Both paths are derived from the caller's own environment:

```
export-sync.js:934   const home = resolveCcxrayHome();              // no argument
export-sync.js:935   const lockPath   = path.join(home, 'export.lock');
export-sync.js:936   const cursorPath = path.join(home, 'export-cursor.json');
paths.js:16          resolveCcxrayHome(env = process.env) => env.CCXRAY_HOME || ~/.ccxray
```

`CCXRAY_HOME` is exactly the kind of variable §1 is about: frozen into a detached hub at
fork, carried independently by each `--port N` server, and re-resolved from scratch by
whatever shell runs `ccxray status`. So the sharing holds **within one `CCXRAY_HOME` and
not across them**.

Measured on the author's machine, 2026-08-29, `ps eww` over the live server processes —
seven processes, seven distinct homes:

| pid | `CCXRAY_HOME` | bucket set | `export-cursor.json` present |
|---|---|---|---|
| 1376 / 1385 / 1393 / 1404 | four distinct `…/T/ccxray-ws-test-*` | yes | no |
| 19218 | `…/T/ccxray-herdr-plugin-*` | no | no |
| 61573 | `…/T/ccxray-index-fields-rebuild-*` | no | no |
| 89700 | unset → `~/.ccxray` | yes | **yes** (2033 B, mtime 2026-08-28 19:05) |

Two things follow, and the second was not anticipated:

1. These are **seven independent export domains**, not one contended one. The four
   ws-test processes do not serialize against each other or against the real home; they
   have separate locks and separate cursors. A report that called any of them "the
   machine" would be claiming authority over six domains it cannot see.
2. A home can have **no cursor at all**. The suppressed test homes never complete a flush
   (`flushExport` returns at `export-sync.js:923` before any cursor write), so the file is
   never created. The home-level read therefore has **three** outcomes — fresh, stale, and
   never-flushed — and `never` must not be rendered as `stale`: for an `unconfigured` or
   `suppressed` home it is the correct and expected state, while for an `enabled` home it
   is the strongest signal available that nothing is reaching GCS.

The correct unit is therefore the `CCXRAY_HOME`, and the level is named for it:

| Level | Question it answers | Source |
|---|---|---|
| home | is **this `CCXRAY_HOME`** exporting at all? | `export-cursor.json` under that home — present/absent, mtime, last id. A persisted fact, independent of which process wrote it, and readable without asking any process |
| process | does THIS exporter have a config problem? | `exportState` + `configWarnings`, carried with an identity tuple |

`ccxray status` prints both and never lets one stand for the other, **and the home line
names the home path it read**. Naming it is not cosmetic: without the path, a status run
from a shell carrying a test `CCXRAY_HOME` would report that home's (absent) cursor in
the exact tone the operator reads as "this machine is not exporting" — the wrong-subject
defect of §1, reintroduced by the fix's own new level. A reader who sees
`home ~/.ccxray` knows which question was answered.

Within one home the rev 3 argument survives intact: a `--port N` exporter nobody asked
about still does not appear in the process list, but it cannot make that home's line
wrong, because it advances that home's cursor. That is the part rev 2 could not offer.
Across homes there is no shared fact and none is invented — which is the same restraint
§4 already applies to non-hub multi-process setups.

**What a cursor advance does and does not attest**, in the same spirit as `enabled` not
being `active` (§2.1). The cursor is written on the first run (`export-sync.js:1002-1010`),
on floor repair (`:1013-1023`), and when the tail HAS moved but produced no aggregate
(`:1031-1041`) — and NOT written at all when the tail is unchanged, because `:1027`
returns first. So a fresh mtime proves *the exporter ran and consumed new index entries*
— not that an object reached GCS — and a stale mtime proves nothing whatsoever, because
an idle home legitimately never writes. That is the strongest fact
available without asking the network, and it is worth exactly what it says. The home line
must not be phrased as "data is reaching the bucket"; `first run — no backfill` is
carried as `partial` in the cursor and belongs in the rendered line rather than being
smoothed into "fresh".

In practice the operator's real home is the one that matters: `~/.ccxray` is the only
domain that ships to the company bucket, and every other home in the measurement above is
an isolated test or smoke run. "Is this home exporting" is answerable; "is this machine
exporting" was not.

**Identity tuple (reviewer B; `home` added in rev 4).** Every process-level report carries
`{kind: 'hub' | 'standalone' | 'agent-port' | 'client', pid, port, home}`. "Names its exporter" was
not a specification, and `ccxray status`'s `Machine:` JSON omits `pid` today
(`server/index.js:1017-1019`) while the human line above it has one — so a machine
consumer cannot distinguish two exporters at all.

**A fourth kind, and why three was a lie (rev 4, found implementing Unit 2).** `kind` is
`'hub' | 'standalone' | 'agent-port' | 'client'`. The first three enumerate EXPORTERS; the
fourth exists because the hub-client process is not one, and the three-value set forced it
to claim it was.

The signal combination that reaches the client path is exactly
`!hubMode && !explicitPort && agentNamed && platform !== 'win32'` — that is the negation of
`server/index.js`'s `if (hubMode || explicitPort || !agentMode) { await startServer(); }`,
plus the Windows branch below it. A three-value mapping has nowhere to put it and lands it
on `hub`. But `startExportSync()` is called inside `startServer()` (`index.js:1223`), which
that process never reaches, so it exports nothing — while `assembleExportReport` would fill
`pid` from `process.pid` and `home` from its own env. The result is a hub identity
FABRICATED FROM CLIENT DATA: this document's defect, reproduced inside the mechanism built
to remove it.

Naming the kind is necessary but not sufficient, because a client's `exportState` would
still be computed from the client's environment — the §2.3 prohibition, one field over. So
for `kind: 'client'` the report carries `exportState: null`, `exportReason: null`, and an
empty `configWarnings`: this process is not an exporter and has nothing to say about one.
That composes with §2.4, which already requires a reader to treat absent state as "cannot
tell" and stay silent rather than fall back to local env.

**`port` is the reporting process's OWN listening port, never a lockfile read (rev 4,
found by the Unit 2 gate).** `currentHubPort()` is `hubListenPort || readHubLock()?.port`,
and `hubListenPort` is set only in real hub mode — so in any non-hub exporter the fallback
reads the HUB's lockfile and the tuple reports a port belonging to a different process.
Measured: with a hub lockfile naming port 59999, an `agent-port` report came back
`{kind:'agent-port', pid:<its own>, port:59999, home:<from the passed env>}` — three fields
resolved against three different sources, naming a process that does not exist. Since the
tuple exists precisely because "a machine consumer cannot distinguish two exporters at
all", a tuple that can name the wrong one defeats its own purpose. The port must come from
the same place the process got its own listener, and a process with no listener (a
`client`) reports `null`.

`home` is the exporter's resolved `CCXRAY_HOME` (`resolveCcxrayHome(env)` in that
process), and it is load-bearing rather than descriptive. The home-level cursor read is
the one part of this design that does not go over the socket — it reads a file — so
without the hub telling the reader WHICH home it exports into, `ccxray status` would
resolve the path from its own shell's env and report a different domain's cursor under
the hub's name. That is §1's defect with a file substituted for an env var. The rule:
**the home line is read from the home the reporting process names, never from the
reader's own env.** Where no process can be reached (§8's "exporter state unavailable"),
status may read its own home but must print the path, so the reader can see which
question was answered.

### 2.4 Wire compatibility

The `register` reply gains fields. Old client × new hub: unknown fields ignored, no
warning shown, behaves as today. New client × old hub: fields absent — the client must
treat `undefined` as "this hub cannot tell me" and stay silent rather than fall back to
its own env, because falling back is precisely the defect being removed. Both directions
must be tested, not reasoned about: hub version skew is real on a machine where several
worktrees run their own servers.

## 2.5 Crash recovery re-forks a different hub, and nobody re-reads the reply

Found independently by both reviewers, and verified: `hub.js:713` re-forks a hub **from a
surviving client's checkout and environment**, so the replacement can differ from the
original in both code and config. The client's re-registration
(`server/index.js:1144`) is `hub.registerClient(...).catch(() => {})` — the reply is
discarded, and the attach-time message the operator already saw is never revised.

This reproduces the defect the document exists to close, one level in: the reported state
becomes a statement about a hub that no longer exists. It is therefore not an edge case to
note, it is a requirement:

- rendering the hub's state is ONE shared function, called at first attach and again on
  every recovery re-register;
- **the render receives the identity tuple and the lifecycle** (`attached` vs
  `recovered`), not just the state (reviewer B). Sharing a function is not sufficient if
  it cannot say WHICH hub it is describing or that the hub changed under the operator;
- the recovery path must stop discarding the reply — **including on rejection**. The
  current `.catch(() => {})` (`server/index.js:1144`) swallows failures as well as
  replies, so a failed re-register would leave the first banner standing as if still
  true. A failed recovery must render `state unavailable after recovery`, which is a
  worse answer than a good one and a much better answer than a stale one;
- a status that is re-rendered must say it changed, not silently print a second banner.

**Delivery caveat, and it is the document's own standard turned on itself (reviewer A).**
Recovery fires mid-session, while the agent's TUI owns the terminal — unlike first attach,
which prints before the agent spawns. So a re-rendered banner lands in the same smear as
the existing "Hub process died" message and may not be read. §1 says production is not
delivery; that applies here too. This design does not solve mid-session delivery, and
says so rather than implying the re-render closes the loop: the durable answer is
`ccxray status`, which the operator can run when they notice something is wrong. The
re-render is best-effort notification, not the guarantee.

Reviewer A added the sharper form: if the render is not shared, a separate `status` round
trip the client can repeat is the safer carrier than the register reply. Shared render is
the cheaper of the two and is what §2.1 assumes; if implementation finds the recovery path
cannot cleanly reach it, fall back to the separate call rather than duplicating the render.

### 2.6 The home-level line: what it compares, and when it may compare at all

Decided 2026-08-29 by an adversarial pair — Fable and gpt-5.6-sol at high effort, each
answering the same question independently. They disagreed, each was right about a
different half, and neither proposal is what ships.

**The mechanism is a comparison, not a threshold.** `cursor.lastId` is compared against
the index tail id. This is the same equality the flush itself evaluates (`:1027`), so
`lastId === tailId` states precisely "the next flush would no-op" — a positive claim mtime
cannot express. mtime survives only inside the `behind` branch, as a qualifier
distinguishing `pending` (younger than 2× `FLUSH_INTERVAL_MS`, the interval plus one
skipped-tick's slack for a flush that lost `export.lock`) from `overdue`, and `overdue` is
worded as a conditional with a re-check horizon, never as a verdict.

States: `cursor-unreadable` · `no-index` · `never-flushed` · `current` (with a `partial`
qualifier that must not be smoothed away) · `behind-pending` · `behind-overdue`. The
naive mtime threshold cried wolf on every idle home, unbounded; here idle homes are
`current` and structurally exempt, and the residual false positive is a just-resumed home
for at most one interval, self-healing.

**The precondition, which is the part neither model had whole.** The cursor lives at
`<home>/export-cursor.json`, but the index lives at `resolveLogsDir(env)` =
`LOGS_DIR || <home>/logs` (`server/paths.js:16-22`; the exporter reads it through
`config.LOGS_DIR`, `server/config.js:280` → `server/storage/local.js:29`). `LOGS_DIR` is
independent of `CCXRAY_HOME`, so a reader that resolves the index from its OWN
environment can compare a cursor against an index the exporter never read — §1's
wrong-subject defect, re-entering through the fix for it. The in-repo bounded-tail
precedent demonstrates the hazard rather than avoiding it:
`plugins/herdr/bin/lib/ccxray.js:247` resolves its path from `opts.env || process.env`.

So the identity tuple gains `logsDir` beside `home`, and **the comparison is attempted
only against a domain the reporting process named**, whose `home` matches the home being
reported on. With no reachable report naming both, the reader does not compare and does
not guess: it renders the non-determination state that already exists for this case
("never flushed; no exporter process reachable — cannot tell whether export is configured
for this home"), the §8 shape. This adds no state to the set; it adds a precondition to
one branch.

**Cost is not an objection.** Reading the tail the way the flush does is a full scan —
`export-sync.js:991-993` materializes every line and `readIndexLines` streams from the
start (`server/storage/local.js:108`) against an index measured at hundreds of MB. The
tail id needs only `open` + `fstat` + the last ~64 KB scanned backwards, size-independent;
the bounded-read pattern is already in-repo and blessed by ADR 0019. A torn final line is
tolerated the way `:998-1000` tolerates it: widen once, then render `index tail unreadable`
rather than guess.

**No cursor × process state.** `startExportSync` fires an immediate flush (`:1149`) and the
first run writes the cursor even on an empty index, so an `enabled` exporter creates it
within seconds of boot. `unconfigured` and `suppressed` crossed with never-flushed are
expected and healthy; `refused` is already its own alarm and never-flushed merely
corroborates it; **`enabled` × never-flushed is the real cross-layer alarm** — configured,
yet no flush has ever completed.

**Panel record.** sol: do not compare — grounds (a) the `LOGS_DIR` domain mismatch and
(b) cost. Fable: compare, with the state set above, refuting (b) with the bounded-tail
precedent. (b) is refuted and was never load-bearing: sol's full-scan figure describes the
EXISTING interface, which Fable had already rejected, and sol's own mitigation is Fable's
proposal verbatim.

(a) is real. Fable's first answer did not mention it; on an explicit re-ask it conceded (a)
as a defect in its own stated design ("read the tail from the home") and then showed the
concession does not reach the conclusion sol drew from it. **(a) indicts every design on
the table equally** — sol's replacement ("render an honest historical cursor line", and
alarm on no-cursor + enabled) also reads a cursor from a home somebody resolved, and
`LOGS_DIR` is frozen into a detached hub at fork exactly like `CCXRAY_HOME` (§1). So (a)
selects for NAMING the domain, not for dropping the comparison.

**Why dropping it loses, and this is the argument that settled it.** sol's alarm covers
only the no-cursor case, which per the crossing above fires when `flushExport` dies before
its FIRST write — seconds after first boot. The dominant mid-life failure is different:
credentials die after months of working, `await upload(...)` throws at
`export-sync.js:1107` BEFORE the cursor write at `:1112`, and the cursor is left PRESENT
with a frozen `lastId` while the tail advances. Under sol's design that home renders
identically to a healthy idle home, permanently — §2.1's own dead-ADC worry ("would have
reported `active` forever") reintroduced as permanent silence instead of a wrong word.
Under the shipped design it is state `behind-overdue`, hardened to "uploads are failing"
when a same-domain report says `enabled`. Verified against source here (`:1107` precedes
`:1112`).

The shipped answer takes Fable's mechanism under sol's constraint. Neither model proposed
it: sol found the hazard and over-generalised from it, Fable built the mechanism and
initially resolved the domain the reader's way.

**Residuals Fable named and this design accepts.** (i) With no reachable process the
fallback resolves both paths from the reader's env and can name the wrong domain — the
mitigation is printing both paths it read, the same accepted residual §2.3/§4 already
carries for `home`. (ii) Two exporters sharing one home with different `LOGS_DIR` values
share one cursor across two indexes; that is already incoherent inside the exporter
(`lastId` from index A is never found in index B → `cursorLineIdx = -1` → `startIdx = 0`
→ full re-aggregate, `export-sync.js:1047-1052`), a pre-existing hazard this line inherits
and cannot cause. Fable additionally caught an
inverted mechanism citation in §2.3 above, now corrected — the conclusion was unaffected
but the cited lines said the opposite of the code.


## 3. Test matrix — the part the last three rounds died on

Three codex rounds found thirteen findings; the recurring cause was a check that covered
the half the author had in mind. So the matrix is fixed before the code:

| # | Mode | Assertion |
|---|---|---|
| 1 | `ccxray` standalone | local env is the source; state reported |
| 2 | `ccxray --port N <agent>` | agent mode, no hub: local env, and the message survives `console.log` muting |
| 3 | `ccxray <agent>`, first | forks a hub, becomes a client, reports the hub's state |
| 4 | `ccxray <agent>`, second | attaches to the existing hub, reports THAT hub's state |
| 5 | `ccxray status` | same values as 3/4 report |
| 6 | **divergence** | hub forked with a bad value, client attaches with a clean env ⇒ the BAD state is shown |
| 7 | **reverse divergence** | hub forked clean, client has a bad value ⇒ NOTHING is shown |
| 8 | old client × new hub, new client × old hub | no crash; new client is silent against an old hub. **Same-major skew on first attach only.** `checkVersionCompat` (`hub.js:158-171`) runs at first attach (`index.js:1039-1043`) and exits fatally on a major mismatch — but reviewer A found the recovery re-register (`index.js:1144`) runs NO version check, and `forkHub` re-spawns from on-disk code that may have been upgraded under a live client. So cross-major replies ARE reachable, on row 9's path precisely. Test them there. Cover BOTH the socket and the HTTP register fallback (`discoverHub`), which reviewer A found returns `null` via the 410 tombstone rather than a reply |
| 9 | **hub crashes, re-forks from a client with a different env** | the re-rendered state describes the NEW hub (§2.5). On current code the reply is discarded, so nothing is re-rendered at all — this row is the differential evidence for §2.5 |
| 10 | hub + one `--port N` server, different envs | each names itself; `ccxray status` does not present the hub's state as the home's (§2.3) |
| 11 | two `--port N` servers, no hub | each reports itself; no cross-process authority is claimed |
| 12 | Windows / `ccxray` with no agent | hub mode is unavailable on Windows (`index.js:55-57`) so the agent path falls back to standalone — same delivery class as row 2, different reason |
| 13a | each `exportState` value renders | `unconfigured` (silent or stated?), `suppressed/explicitly-disabled`, `suppressed/test-run`, `refused`, `enabled` — reviewer A: the matrix covered modes x surfaces and no states, which is the other half of the very blind spot §1 diagnoses |
| 13b | home level vs process level disagree | hub `refused`, a `--port N` server flushing **in the same `CCXRAY_HOME`**: the home line must show a fresh cursor while the process line shows the refusal, and neither may be printed as the other (§2.3). The shared home is what makes the two levels disagree about one subject; in different homes they are separate domains and the row is vacuous — that is row 14, not this one |
| 14 | **two exporters, two `CCXRAY_HOME`s** | each reports its own home's cursor and neither is presented as the other's or as the machine's. The home line names the home path it read (§2.3). Assert the negative explicitly: a status run whose env points at home A must not report home B's cursor state, in either direction — including the case where A has never flushed and B has, which on a single-cursor reading would render as "exporting" for a home that is not |
| 13c | each home-level cursor outcome renders | `fresh`, `stale`, `never-flushed` — the third exists because a suppressed or unconfigured home never creates the file at all (§2.3, measured). `never` must render as itself, not as `stale`, and its meaning is read against the process state: expected under `unconfigured`/`suppressed`, and the strongest available "nothing is reaching GCS" signal under `enabled`. Same rule as 13a: a state set gets an iterating table, not one example |
| 13 | `ccxray status` with no discoverable lock | reviewer B: it probes `/_api/health`, which carries no export state and reports `hub:false` for a live hub. Either the probe learns the state or status must say it could not determine it — silence here is the same wrong-subject failure |

**Non-vacuity conditions** (both reviewers; a row that can pass without exercising its
subject is worse than no row). Row 14 must use two homes whose cursor states DIFFER — one
flushed, one never — or it passes on identical output either way; and it must assert the
negative (home A's status never reports home B) rather than only that each line exists.
Row 13b must put both exporters in the SAME home, or its disagreement is an artefact of
partitioning rather than of the two levels. Row 7 must still assert the hub's own state is shown, not
merely that no client-derived warning appears — under the two-level model "NOTHING is
shown" is stale. Row 9 must use explicitly DIVERGENT environments or it passes with
identical output either way. Row 11 must use distinct ports. Row 12 must separate the
Windows guard (`index.js:56-57`) from the Unix no-agent path (`index.js:1398-1405`) —
they reach standalone for different reasons. Every row needs an isolated `CCXRAY_HOME`,
`CCXRAY_EXPORT_DISABLE=1` where a server boots, and a readiness wait; "it really forks"
is not hermeticity.

**Rows 6/7 diverge on `configWarnings`, not on `exportState` — and that is forced, not
chosen (found building them, 2026-08-29).** Every spawned server must set
`CCXRAY_EXPORT_DISABLE=1` (`CCXRAY_HOME` does not isolate the GCS bucket, and
`test/export-sync-test-guard.test.js` fails the suite if a launcher omits it). But
`exportStatus` evaluates `exportSuppressionReason` FIRST, so that flag pins every spawned
process to `{suppressed, explicitly-disabled}` and no other `exportState` is reachable in
a spawned-process test. The two requirements are jointly unsatisfiable for `exportState`.

The divergence therefore rides a non-absolute `CCXRAY_IMPORT_HOMES`, which reaches
`configWarnings` — gated only on `kind` (`server/hub.js:601`), never on `exportState`. The
precedence paragraph in §2.1 anticipated exactly this without knowing it: "the fault
remains available through `configWarnings`."

Accepted residual: `exportState` divergence is not exercised by any spawned-process test.
Its five values stay covered by the in-process tables of Units 1-2, which prove the
producer is injectable but cannot prove whose environment the hub read. So the
hub-reads-its-own-env claim is established for `configWarnings` and inferred for
`exportState` — they are assembled by one function from one env object
(`assembleExportReport`), which is the reason the inference is sound, and which is a
weaker warrant than a test.

Rows 6 and 7 are the differential evidence for this change: on current code, 6 shows
nothing and 7 shows a warning — both exactly backwards. Rows 3, 4, 6, 7 require really
forking a hub; an in-process simulation cannot exercise env divergence at all, which is
the same trap that made an earlier ambient-discovery assertion inert (it read
`os.homedir()` regardless of the env object it was handed).

## 4. What this does NOT fix

- A hub whose environment went stale is still stale. This makes it VISIBLE; it does not
  re-read the env or restart anything. An operator who fixes a value must restart the
  hub, and the status line should say so.
- Non-hub multi-process setups (`ccxray --port N` twice) each report themselves. There is
  no cross-process authority there and this design does not invent one.
- **Nothing reports across `CCXRAY_HOME`s.** Seven live export domains were measured on
  one machine (§2.3); a surface can answer for the home it names and no other. An operator
  who wants "is anything on this box exporting" is asking a question this design
  deliberately does not answer, because answering it would mean enumerating homes from
  processes whose envs are exactly the thing that cannot be trusted. The actionable form
  is: run `ccxray status` in the shell whose home you care about, and read the printed
  path to confirm it is the one you meant.

## 5. Alternatives considered

- **Persist the state in `hub.json`.** Rejected: a file written at fork time goes stale
  exactly like the env it describes, and adds a second source to keep honest.
- **Keep the client-side check and document the divergence.** Rejected: this is the third
  time the same finding has come back, and two client-side approximations have already
  been shipped and bounced. Documenting a known-wrong subject is what a fourth round
  would find.
- **A dashboard panel.** Not rejected, deferred: it needs the same payload, so it can be
  built on this later. It is not a substitute — the person who mis-set a variable is
  looking at a terminal, not a browser.

## 6. Why this is its own PR

PR #592 already carries fifteen commits across two behavioural claims and has failed two
PR-level reviews. Both close-out proposals for #592 independently scoped this as a
separate unit.

**Correction: not because of protocol risk.** An earlier revision justified the split on
the wire change in §2.4. Both reviewers attacked that claim and neither could break the
tolerance: the hub's `register` handler whitelist-picks known fields
(`hub.js:337-341`, `clientIdentityFromMessage`) and the client reads only named fields,
so additive fields are compatible in both directions today. The split stands on review
hygiene alone — a PR that has already failed twice should not grow — which is a weaker
and more honest reason than the one I gave.

Order: #592 merges with its residual documented; this lands next and removes the residual
from both the tombstone and the root warning at once.

## 7. Open questions — answered by round 1

1. **Is `suppressed` a state?** Yes, both reviewers agreed — a test or smoke hub reporting
   `unconfigured` would be false. But the reason is now neutral and split
   (`explicitly-disabled` / `test-run`); neither reviewer would surface
   `NODE_TEST_CONTEXT` by name and neither should the operator have to know it.
2. **Strings or codes for warnings?** Codes with args, rendered at each surface. The
   reviewers split; B wins on a point A supplied (see §2.1).
3. **Register reply or a separate `status` call?** Register reply, PROVIDED the render is
   one shared function also reached by the crash-recovery re-register (§2.5). If
   implementation finds recovery cannot reach it cleanly, use the separate call — do not
   duplicate the render, which is how the two client-side approximations happened.
4. **Version gate?** Not needed for the socket path — verified by both, see §6. Still test
   the HTTP fallback corner and the invalid-pid no-reply hang (reviewer A found
   `hub.js:337-338` returns nothing at all, so a bad register hangs the client to timeout).

## 8. Decided in round 2

**`/_api/health` does NOT carry export state (reviewer B).** I had framed row 13 as "more
useful versus more honest" and missed the third axis: `configWarnings.args` contains the
operator's rejected filesystem paths, and `handleHubRoutes` serves `/_api/health`
unauthenticated (`server/hub.js:584`). Publishing config diagnostics there widens an
unauthenticated surface to fix a visibility problem. Instead `ccxray status` says
`hub detected (pid N, port P) — exporter state unavailable`. Admitting what it could not
determine IS the useful answer; the previous framing treated honesty as the cheaper
option rather than the correct one.

**`docs/wire-protocol-reference.md` does not cover this.** That document is scoped to
observable differences on the PROVIDER wire (Anthropic Messages, OpenAI Responses); the
hub socket is ccxray's own IPC and has no entry there. The exclusion is now stated so it
is not re-litigated, and the socket payload is specified in §2.1 of this document, which
is where a reader will look for it.

**Warning codes must be enumerated before implementation (reviewer B).**
`{code, args: Record<string, unknown>}` is a shape, not a contract. The initial set is
one entry — `relative-import-root` with `{variable, values: string[]}` — plus a stated
rule that an unknown code renders as its code and raw args rather than being dropped, so
an older surface degrades loudly against a newer producer.

## 9. A reviewer correction that was itself wrong

Reviewer A flagged three citation drifts. Two were real and are fixed
(`index.js:158` was a copied `hub.js` line number pointing at an unrelated comment;
the Windows guard is `:56-57`). The third — that the `console.log` mute is at `:157`,
not `:151` — is wrong: `:151` is `if (agentMode || hubMode) console.log = () => {};`
and `:157` is blank. The original citation was correct and stands.

Recorded because this document's whole subject is reports that describe the wrong thing.
A review finding is an input, not a verdict, and the cost of checking one citation is a
single `sed`.
