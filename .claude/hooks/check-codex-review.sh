#!/bin/bash
# PreToolUse hook: block `gh pr merge` unless PR body contains codex review evidence.
# Exit 0 = allow, exit 2 + JSON = block.

INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null)

# If jq fails or command doesn't contain gh pr merge, allow
if [ -z "$CMD" ] || ! echo "$CMD" | grep -qE '^gh pr merge|&& gh pr merge|; gh pr merge'; then
  exit 0
fi

# Extract PR number
PR_NUM=$(echo "$CMD" | grep -oE 'gh pr merge[[:space:]]+([0-9]+)' | grep -oE '[0-9]+' | head -1)
if [ -z "$PR_NUM" ]; then
  # No PR number (e.g. `gh pr merge` without args) — allow, gh will prompt
  exit 0
fi

# Check PR body
BODY=$(gh pr view "$PR_NUM" --json body --jq '.body' 2>/dev/null || echo "")

if echo "$BODY" | grep -qiE 'codex gate clean|codex review|codex-exempt'; then
  exit 0
fi

echo '{"decision":"block","reason":"PR #'"$PR_NUM"' body missing codex review evidence — run /codex-loop first"}'
exit 2
