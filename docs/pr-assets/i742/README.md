# Usage contract verification — review round 1

Code/evidence production commit: `eb7c546f6ac3075650360d02969dab530e0e840e`.
Branch: `feat/742-usage-contract`. Risk: L2. Node: v26.12.1.
The subsequent evidence-only commit changes this directory only; source,
tests and contract documents are identical to the tested commit.

## Review resolution

M1 is fixed: aggregate exposes plain objects while counting with null prototypes;
selector fixtures now include dummy model/usage evidence; the empty JSON test
passes `--json`; both exact shape assertions include `sourceCoverage`. The
fixture changes deliberately follow v1 marker exclusion, which remains tested
separately. No assertions were removed to obtain green results.

M2 replaces the previous sandbox-era evidence with fresh results, including
all three heavy usage files. The old EPERM attribution was incomplete: the
reviewed commit has eight real failures in this environment. The independently
reported PipeWrap failure does not reproduce here. The archived baseline
records its tested SHA separately from the SHA on which evidence was produced.
Old full diagnostic logs have been removed rather than carried forward as
current results.

S1 and S2 are fixed in the usage reference and Breaking changelog. Scenario 3
now checks the reference's v1 field list too. S3 remains partially open:
proposal 3 needs a durable recording ledger; `coverage` remains `unknown`.
[Prepared PR wording and follow-up issue draft](pr-notes.md) explicitly keep
#742 open. Publishing those changes is deferred under the unattended limits.

Additional suggestions handled: safe prototype-like counter names have a
regression test; purity traps cover metadata writes and process creation;
text prints `reasoning unknown`. Serial unit execution is retained under the
owner's explicit serial-test requirement; the PR notes disclose the CI runtime
tradeoff. The process-creation trap moves the purity test to the heavy lane
under the runner's conservative classifier (see docs/testing.md).

## Scenario mapping

| Scenario | Test name | File |
| --- | --- | --- |
| 1 | Scenario 1: schemaVersion pins the complete stable field set | test/usage-contract.test.js |
| 2 | Scenario 2: source coverage distinguishes missing observations from zero usage | test/usage-contract.test.js |
| 3 | Scenario 3: documented schema and compatibility rules match version 1 | test/usage-contract.test.js |
| 4 | Scenario 4: requires and runs offline without timers, writes, sockets or price fetches; HOME stays byte-identical | test/usage-contract-purity.test.js |
| 5 | Scenario 5: main integration preserves grouping and resolves all four review follow-ups | test/usage-contract.test.js |

## Commands and counts

Every invocation is serial and uses a new temporary HOME with dummy data.
The test preload creates a temporary CCXRAY_HOME; inherited data roots are
removed by the evidence runner. No tests use a running hub or real logs.

```sh
T=$(mktemp -d); HOME=$T node --require ./test/helpers/home-guard.js --test --test-concurrency=1 test/usage.test.js test/usage-query.test.js test/usage-unpriced-imported.test.js
T=$(mktemp -d); HOME=$T node scripts/run-tests.js unit
```

| Run | Tests | Pass | Fail | Exit |
| --- | ---: | ---: | ---: | ---: |
| [heavy-final](heavy-final.txt) | 91 | 91 | 0 | 0 |
| [usage.test-final](usage.test-final.txt) | 67 | 67 | 0 | 0 |
| [usage-query.test-final](usage-query.test-final.txt) | 19 | 19 | 0 | 0 |
| [usage-unpriced-imported.test-final](usage-unpriced-imported.test-final.txt) | 5 | 5 | 0 | 0 |
| [unit-final](unit-final.txt) | unknown | unknown | unknown | -9 |
| [contract-final](contract-final.txt) | 10 | 10 | 0 | 0 |
| [purity-final](purity-final.txt) | 1 | 1 | 0 | 0 |
| [group-final](group-final.txt) | 14 | 14 | 0 | 0 |
| [heavy-before](heavy-before.txt) | 90 | 82 | 8 | 1 |

The full unit lane was attempted with no exclusions, but did not finish. The
first attempt timed out after 1200 seconds; a second bounded diagnostic at the
final code SHA timed out after 120 seconds (exit -9 after killing its own new
process group). Its last output is passing auth bootstrap assertions, before
the HTTP bootstrap suite completes. The next suite awaits a loopback listen in
its before hook; that is static context, not a confirmed runtime diagnosis.
There is no final unit summary, so pass/fail counts are unknown. No EPERM cause
is claimed. No further unit retry or excluded subset was substituted.
Counts for completed runs are individual Node tests, unlike the previous
sandbox file-count report. Each heavy file
was also run separately with the same preload/serial flags to expose its count.
Every command and the last output lines are recorded in the linked text files
and [results.json](results.json).

Focused commands (one file per invocation):

```sh
T=$(mktemp -d); HOME=$T node --require ./test/helpers/home-guard.js --require ./test/helpers/no-network.js --experimental-test-isolation=none --test --test-reporter=tap --test-concurrency=1 test/usage-contract.test.js
T=$(mktemp -d); HOME=$T node --require ./test/helpers/home-guard.js --require ./test/helpers/no-network.js --experimental-test-isolation=none --test --test-reporter=tap --test-concurrency=1 test/usage-contract-purity.test.js
T=$(mktemp -d); HOME=$T node --require ./test/helpers/home-guard.js --require ./test/helpers/no-network.js --experimental-test-isolation=none --test --test-reporter=tap --test-concurrency=1 test/usage-group.test.js
```

Regenerate reports and mutation proof:

```sh
EVIDENCE_UNIT_TIMEOUT=120 python3 docs/pr-assets/i742/run.py
python3 docs/pr-assets/i742/verify.py
```

The verifier archives the committed tree in a disposable directory, deliberately
breaks one behavior, runs its test red, restores the bytes in a finally block,
and reruns green. The eight original mutations are retained, plus reference
field omission, unsafe counting, leaked counter prototype and null text
reasoning: **12 red/green pairs**. Every red is exit 1 / 0 pass / 1 fail; every
green is exit 0 / 1 pass / 0 fail. Patches and compact TAP diagnostics accompany
[break-proof.json](break-proof.json). The working checkout is never mutated.

[CLI fixture evidence](cli-fixture.json) records merged and unmatched queries,
source observations, marker exclusion and identical before/after file hashes.
[Integration evidence](integration.txt) checks ancestry against the recorded
main and #741 commits using local Git objects. No remote refresh was performed;
no claim about the current remote main is made.

No UI changed; screenshots/browser smoke are not applicable to this CLI fix.
The full heavy and browser lanes were not requested or run. No real-session
replay was performed because only dummy data is authorized.

## WAITING FOR APPROVAL

Run the full unit lane in an environment where it can complete; the current
run stalls and process inspection is denied, so an escalated diagnostic is
deferred under the no-interactive-approval rule. The first timeout used the
prior harness, which killed its direct runner; descendant termination could
not be independently checked because process inspection is unavailable. The
revised harness kills only its own newly created test process group. No
existing service was signalled.

Create the drafted coverage-ledger follow-up issue and link it from the future
PR body, preserving #742's open proposal-3 scope. This would write to a remote
service, so the unattended/local-only limits require deferral. No PR was
opened or edited and no branch was pushed.

## STOPPED

Full unit validation stopped after two timed-out attempts (1200s and 120s).
Its final pass/fail counts remain unknown. All focused scenarios, heavy usage
files, mutation pairs and CLI checks completed. No third attempt was made.
Work stopped within the 45-minute limit; no push, PR, hub operation or real
data access was performed.
