#!/bin/bash
# PreToolUse hook: block `gh pr merge` unless PR body contains codex review evidence.
# Exit 0 = allow, exit 2 + JSON = block.

INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null)

# If jq fails or command doesn't contain gh pr merge, allow
if [ -z "$CMD" ] || ! echo "$CMD" | grep -qE '^gh pr merge|&& gh pr merge|; gh pr merge'; then
  exit 0
fi

# Extract PR number: first standalone integer argument after `gh pr merge`
# (handles both `merge 11 --repo X` and `merge --repo X 11`; a repo name like
# lis186/ccxray is not a standalone integer so it can't be mistaken for one)
MERGE_TAIL=${CMD#*gh pr merge}
PR_NUM=$(echo "$MERGE_TAIL" | grep -oE '(^|[[:space:]])[0-9]+([[:space:]]|$)' | grep -oE '[0-9]+' | head -1)
if [ -z "$PR_NUM" ]; then
  # No PR number (e.g. `gh pr merge` without args) — allow, gh will prompt
  exit 0
fi

# Cross-repo: a merge can target another repo via -R/--repo. Without forwarding it,
# the body check reads the cwd repo's same-numbered PR — a colliding number whose
# body happens to contain "codex review" would silently pass an unreviewed PR
# (ops docs/solutions/gate-script-vs-runbook-contradictions.md item 3).
REPO_ARG=""
if echo "$CMD" | grep -qE '(^|[[:space:]])(-R|--repo)([= ]|$)'; then
  REPO_ARG=$(echo "$CMD" | sed -nE 's/.*(^|[[:space:]])(-R|--repo)[= ]([^[:space:]]+).*/\3/p' | head -1)
  if [ -z "$REPO_ARG" ]; then
    # -R/--repo present but unparseable — fail closed rather than validate the cwd repo
    echo '{"decision":"block","reason":"gh pr merge carries -R/--repo but the hook could not parse the target repo — refusing to validate against the cwd repo PR #'"$PR_NUM"'"}'
    exit 2
  fi
fi

# Check PR body (in the target repo when one was given)
if [ -n "$REPO_ARG" ]; then
  BODY=$(gh pr view "$PR_NUM" --repo "$REPO_ARG" --json body --jq '.body' 2>/dev/null || echo "")
else
  BODY=$(gh pr view "$PR_NUM" --json body --jq '.body' 2>/dev/null || echo "")
fi

if echo "$BODY" | grep -qiE 'codex gate clean|codex review|codex-exempt'; then
  exit 0
fi

echo '{"decision":"block","reason":"PR #'"$PR_NUM"' body missing codex review evidence — run /codex-loop first"}'
exit 2
