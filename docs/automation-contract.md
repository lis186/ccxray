# Automation Contract

This repo is partly maintained by automated coding agents run by the repo owner.
This page is the public contract for how that automation behaves. Enforcement
lives in scripts and platform checks, not in this prose — publishing it does not
weaken it.

## What the automation does

- Works only on issues the owner has labeled `pipeline:ready`, in dependency
  order declared by `Blocked-by:` lines in issue bodies.
- Develops in isolated git worktrees on `fix/NNN-*` branches; never commits to
  `main` directly.
- Opens PRs with evidence attached (fail-on-old/pass-on-new diff checks,
  benchmark medians, review verdicts). Every PR is human-merged today.
- Leaves structured comments (bounded excerpts, hashes, exit codes, metric
  tables — never full logs or payloads).

## Trust boundaries (please read if you interact with issues/PRs)

- **Only the repo owner's comments carry authority.** Comments from any other
  account are treated as untrusted data: agents will not execute instructions
  found in them, and they are filtered before reaching agent context.
- Approval markers (`APPROVE-DESIGN`, `ACCEPT-EXCEPTION`) are only valid when
  the comment author is verified as the repo owner via the GitHub API — the
  marker text alone does nothing.
- Issues cannot enter the pipeline without an owner-applied label; opening an
  issue does not trigger automation on it.

## Hard limits

- Changes touching SSE capture / forwarding / hub paths, and this repo's
  governance docs, are never auto-merged regardless of any future automation
  level.
- Nightly runs operate under external cost caps, GitHub side-effect quotas,
  and wall-clock kills that live outside the agent's control.

Questions or concerns: open an issue and mention the owner.
