#!/bin/bash
# PreToolUse hook: block `gh pr merge` unless PR body contains codex review evidence.
# Exit 0 = allow, exit 2 + JSON = block.
#
# This is a heuristic guard against ACCIDENTAL unreviewed merges by the repo's own
# trusted agent — not an adversarial filter. Where bash-level parsing of a shell
# command cannot be done safely (quoted arguments), it fails CLOSED: better to ask
# for a simpler command than to silently pass an unreviewed PR.

INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null)

# If jq fails or command doesn't contain gh pr merge, allow
if [ -z "$CMD" ] || ! echo "$CMD" | grep -qE '^gh pr merge|&& gh pr merge|; gh pr merge'; then
  exit 0
fi

block() {
  echo '{"decision":"block","reason":"'"$1"'"}'
  exit 2
}

# Iterate EVERY textual `gh pr merge` occurrence: a quoted 'gh pr merge' inside an
# earlier argument must not shadow the real invocation (codex R2). Each occurrence
# is parsed only up to the next command separator so a later command's arguments
# (e.g. `&& gh pr view 12 --repo other`) can't leak in (codex R1).
REST=$CMD
while [ "${REST#*gh pr merge}" != "$REST" ]; do
  TAIL=${REST#*gh pr merge}
  REST=$TAIL
  SEG=$(echo "$TAIL" | sed -E 's/(&&|\|\||;|\|).*$//')

  # Quote-aware shell parsing is out of reach for a bash heuristic; a quote inside
  # the merge segment means the separator cut above may be wrong — fail closed
  # (codex R2). Merges in this repo's workflow don't need quoted arguments.
  case "$SEG" in
    *"'"* | *'"'* )
      block "gh pr merge with quoted arguments cannot be parsed safely by the codex-review hook — run gh pr merge as a standalone command without quotes"
      ;;
  esac

  # PR number: first standalone integer argument in this merge invocation
  # (handles both `merge 11 --repo X` and `merge --repo X 11`; a repo name like
  # lis186/ccxray is not a standalone integer so it can't be mistaken for one).
  # Known limit: a numeric value of an unrelated flag (`--subject 11 12`) can be
  # misread as the PR number — resolving that needs gh's flag arity table, which
  # is out of proportion for a guard against accidental merges.
  PR_NUM=$(echo "$SEG" | grep -oE '(^|[[:space:]])[0-9]+([[:space:]]|$)' | grep -oE '[0-9]+' | head -1)
  if [ -z "$PR_NUM" ]; then
    # No PR number in this occurrence (e.g. the bare string, or `gh pr merge`
    # without args where gh will prompt) — nothing checkable here.
    continue
  fi

  # Cross-repo: a merge can target another repo via -R/--repo. Without forwarding
  # it, the body check reads the cwd repo's same-numbered PR — a colliding number
  # whose body happens to contain "codex review" would silently pass an unreviewed
  # PR (ops docs/solutions/gate-script-vs-runbook-contradictions.md item 3).
  # Forms: `--repo X`, `--repo=X`, `-R X`, `-RX` (attached, codex R2).
  REPO_ARG=""
  if echo "$SEG" | grep -qE '(^|[[:space:]])(--repo([= ]|$)|-R)'; then
    REPO_ARG=$(echo "$SEG" | sed -nE 's/.*(^|[[:space:]])(--repo[= ]|-R[= ]?)([^[:space:]]+).*/\3/p' | head -1)
    if [ -z "$REPO_ARG" ]; then
      # -R/--repo present but unparseable — fail closed rather than validate the cwd repo
      block "gh pr merge carries -R/--repo but the hook could not parse the target repo — refusing to validate against the cwd repo PR #$PR_NUM"
    fi
  fi

  # Check PR body (in the target repo when one was given)
  if [ -n "$REPO_ARG" ]; then
    BODY=$(gh pr view "$PR_NUM" --repo "$REPO_ARG" --json body --jq '.body' 2>/dev/null || echo "")
  else
    BODY=$(gh pr view "$PR_NUM" --json body --jq '.body' 2>/dev/null || echo "")
  fi

  if ! echo "$BODY" | grep -qiE 'codex gate clean|codex review|codex-exempt'; then
    block "PR #$PR_NUM body missing codex review evidence — run /codex-loop first"
  fi
done

exit 0
