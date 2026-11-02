# Usage contract verification

Code commit: `84fbee97cde9e385752e3340e6a60569b8647af0`. Branch: `feat/742-usage-contract`. Risk: L2.

Existing work was saved in `50cf6530`, main was merged in `f929f9cf`, the
contract and scenario tests were completed in `cb90e641`, and compatibility
wording was clarified in `84fbee97`. The remote main commit was verified as
`9b76d46`; both it and the #741 squash `f668bf8` are ancestors of this branch.
See [integration evidence](integration.txt). No push, PR, service change or
production data access was performed.

## Scenario mapping

| Scenario | Test name | File |
| --- | --- | --- |
| 1 | Scenario 1: schemaVersion pins the complete stable field set | test/usage-contract.test.js |
| 2 | Scenario 2: source coverage distinguishes missing observations from zero usage | test/usage-contract.test.js |
| 3 | Scenario 3: documented schema and compatibility rules match version 1 | test/usage-contract.test.js |
| 4 | Scenario 4: requires and runs offline without timers, writes, sockets or price fetches; HOME stays byte-identical | test/usage-contract-purity.test.js |
| 5 | Scenario 5: main integration preserves grouping and resolves all four review follow-ups | test/usage-contract.test.js |

Scenario 5 exercises the four behavior regressions; merge ancestry is checked
separately with Git. Scenario 1 pins the stable root, Summary, turn, window,
source, token and cost-fold fields to version 1. Supplementary analytics retain
their documented report shapes. Coverage remains `unknown` for historical
recording completeness; source observations are `observed` or `not-observed`,
never an invented zero for an absent provider/source.

## Commands and results

All tests were run serially with a fresh HOME and synthetic data. Unit fixtures
receive isolated CCXRAY_HOME from the standard HOME guard. The default unit
suite includes socket fixtures that cannot run in this sandbox, so its exact
available-subset command was:

```sh
T=$(mktemp -d); HOME=$T node scripts/run-tests.js unit --exclude auth-bootstrap.test.js,body-limit.test.js,export-diagnostics.test.js,grok-billing-fetch.test.js,hub.test.js,listen-hosts.test.js,openai-sse-title-gen-wiring.test.js,security-headers.test.js,export-cross-agent-dup.test.js,export-sync-test-guard.test.js,export-sync.test.js,hub-owned-config-status.test.js,launcher-shims.test.js
```

Final result: **146 test files passed, 0 failed**. The Node process-isolated
reporter counts files in this environment, not individual assertions; no larger
assertion count is inferred. [Full unit output](unit-final.txt).

Detailed focused runs (each in its own fresh HOME) used:

```sh
T=$(mktemp -d); HOME=$T node --require ./test/helpers/home-guard.js --require ./test/helpers/no-network.js --experimental-test-isolation=none --test --test-concurrency=1 test/usage-contract.test.js
T=$(mktemp -d); HOME=$T node --require ./test/helpers/home-guard.js --require ./test/helpers/no-network.js --experimental-test-isolation=none --test --test-concurrency=1 test/usage-contract-purity.test.js
T=$(mktemp -d); HOME=$T node --require ./test/helpers/home-guard.js --require ./test/helpers/no-network.js --experimental-test-isolation=none --test --test-concurrency=1 test/usage-group.test.js
```

Counts: contract **10 pass / 0 fail**, purity **1 / 0**, grouping **14 / 0**.
Their logs record the code commit on which they were produced. The subsequent
change only clarified two documentation lines. Every numbered scenario was
also rerun against `84fbee97cde9e385752e3340e6a60569b8647af0` by the mutation verifier, with **1 pass / 0 fail**
after each restoration.

Reproduce all eight deliberately broken/restored pairs with:

```sh
python3 docs/pr-assets/i742/verify.py
```

It archives HEAD into a disposable tree, uses new HOME/CCXRAY_HOME/LOGS_DIR and
GIT_CONFIG_GLOBAL for every invocation, records exact patches and TAP output,
and restores each changed file in a finally block. It never changes the source
checkout. Eight red runs: **0 pass / 1 fail**, exit 1 each. Eight restored runs:
**1 pass / 0 fail**, exit 0 each. See [machine-readable results](break-proof.json).
Mutations remove schemaVersion, invent a source observation, document the wrong
version, write during query, discard a merged response, admit an undated row,
invent zero reasoning, and reject an empty group. Every mutation has a patch,
red transcript and green transcript in this directory.

The [CLI fixture evidence](cli-fixture.json) records the full command/output and
before/after file hashes: actual `node server/index.js usage --json` with dummy
rows returns version 1, unknown historical coverage, both sources observed,
one merged turn and one excluded marker. An unmatched selector returns zero
selected calls with both sources `not-observed`. HOME remains byte-identical.

## Four PR #769 follow-ups

Source: [PR follow-up list](https://github.com/lis186/ccxray/pull/769), plus the
[inline attribution finding](https://github.com/lis186/ccxray/pull/769#discussion_r4434387752).
The requested GitHub CLI commands could not connect; connected GitHub tools
retrieved the current PR body, discussion, reviews and inline review thread.
The body lists four follow-ups; the single inline finding repeats the first.

| Suggestion | Handling and verification |
| --- | --- |
| Non-grouped attribution filters ran before merge | JSON shares the merged/source-selected read model; legacy text deduplicates before agent/branch filters. Grouping tests and scenario 5 check complementary agent/branch metadata. |
| An upper bound alone admitted undated rows | Both JSON and bounded text use finite timestamp selection. Existing grouping regression plus scenario 5 and its undated mutation verify exclusion. |
| Import-only Codex reasoning appeared as zero | Missing reasoning evidence is null with reasoningKnownTurns=0; explicit zero remains zero. Ledger fixture, grouping tests and scenario 5 verify it. |
| Empty grouped queries exited 1 | Empty/no-match/missing-index JSON and grouped results succeed with empty groups. Contract empty-result tests and scenario 5 verify it. |

All four were in scope and handled. Main's counting-map hardening and launcher
changes were retained; no other #741 feature copy was introduced.

## Sandbox limitations

The 13 files explicitly excluded above are **not run in sandbox** in the final
unit invocation because they open sockets directly or through export/setup
helpers. Initial diagnostics exposed five failing files from indirect socket
users before exclusions were complete; they were not counted as passing. The
launcher diagnostic showed 59 passing / 3 failing checks caused by a denied
export-lock bind during setup removal. No further socket retry was made after
the cause was identified.

An additional legacy `usage.test.js` diagnostic is preserved in
[legacy-subprocess-diagnostic.txt](legacy-subprocess-diagnostic.txt): **22 pass /
45 fail**. Nested synchronous CLI spawning is denied with EPERM; dependent
assertions consequently receive empty output. These child-process checks are
**not run in sandbox** as successful validations. This does not affect the
socket-free unit subset or the actual CLI fixture launched from the evidence
harness. The detailed diagnostic process returned 0 despite TAP failures, so
its TAP fail count, not that exit status, is reported. No third attempt was made.

The full default unit command, socket-dependent heavy/browser suites and real
browser smoke remain unverified here. No UI changed, and no UI screenshot was
claimed. No real session replay was performed: this task permits dummy data only.

## WAITING FOR APPROVAL

None. No approval-dependent operation was attempted.

## STOPPED

None. Work completed within the time and retry limits. Environment-limited
checks are listed above rather than represented as successful runs.
