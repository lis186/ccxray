# Contributing to ccxray

Thanks for the interest. Bug reports and wire-protocol findings are especially
welcome — this project lives or dies on whether it reads the wire correctly.

## License of contributions (read this first)

ccxray is licensed under **PolyForm Noncommercial 1.0.0** (see [LICENSE](LICENSE)).
It was MIT-licensed until 2026-07-21; versions `1.9.3` and earlier on npm remain
MIT and always will be.

By opening a pull request you agree that:

1. Your contribution is licensed under **PolyForm Noncommercial 1.0.0**, and
2. You grant the maintainer the right to **relicense your contribution under
   different terms in the future, including commercial licenses**.

Point 2 exists so the project can offer commercial licenses without having to
track down every past contributor. If you are not willing to grant it, please
say so in the PR — a patch is still welcome, it just needs a different
conversation first.

### Sign your commits (DCO)

Every commit must carry a `Signed-off-by` line certifying you wrote the code or
have the right to submit it under the terms above — the
[Developer Certificate of Origin](https://developercertificate.org/):

```bash
git commit -s -m "your message"
```

To add it to commits you already made:

```bash
git rebase --signoff origin/main
```

## Before you open a PR

```bash
npm ci
CCXRAY_HOME=$(mktemp -d) npm test
```

Always run tests against an isolated `CCXRAY_HOME`. A test that reads your real
`~/.ccxray` will pass on your machine and fail in CI — see
[docs/testing.md](docs/testing.md) for the isolation rules.

## What makes a PR easy to accept

Show your work. A PR body that states what you verified — and what you did
*not* — gets reviewed faster than one that claims everything works.

- **Bug fix**: evidence the fix actually fixes it. The strongest form is
  fail-on-old / pass-on-new: your new test fails when the fix is reverted.
- **Refactor**: the existing suite stays green, plus whatever structural
  measure motivated the change.
- **Wire-protocol change**: a fixture captured from real traffic
  (`test/fixtures/wire-parsers/`), with secrets scrubbed.
- **New provider or upstream**: routing test + one end-to-end test against a
  mock upstream. Live verification against the real service is welcome but not
  required — say which you did.

[docs/verification-principles.md](docs/verification-principles.md) describes the
ladder of evidence this project uses (written in Traditional Chinese). You do not
need to read it to contribute — the four bullets above are the short version.

### Scope

Keep a PR to one concern. Unrelated cleanups in the same diff make it hard to
tell which change caused a regression — if you spot something adjacent that
needs fixing, mention it rather than folding it in.

## CI on fork pull requests

GitHub does not run workflows on pull requests from forks until a maintainer
approves them, so your PR may sit with no checks for a while. That is a
permission gate, not a judgment about your patch. Feel free to ping if it stalls.

## Reporting bugs

Include the raw output — proxy log lines, console errors, the wire request or
response if the bug is protocol-related. Scrub API keys and any prompt content
you would not want public. A report with real data gets diagnosed; a report
without it gets a round of questions first.
