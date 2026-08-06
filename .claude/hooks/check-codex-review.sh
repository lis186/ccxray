#!/bin/bash
# PreToolUse hook: block `gh pr merge` unless the target PR's body contains codex
# review evidence. Exit 0 = allow, exit 2 + JSON = block.
#
# Design: this is a guard against ACCIDENTAL unreviewed merges by the repo's own
# trusted agent. Bash cannot fully parse shell, so instead of chasing parser holes
# (quotes, escapes, comments, substitutions — codex R2/R3/R4) the gate accepts ONE
# verifiable grammar and fails CLOSED on everything else:
#
#   gh pr merge <number | github pull URL>
#       [--repo owner/repo | -R owner/repo | --repo=x | -Rx]
#       [--squash|--merge|--rebase|-s|-m|-r] [--delete-branch|-d] [--admin] [--auto]
#
# Anything outside that shape (branch selectors, current-branch merge, value-taking
# flags like --subject, $VARs, quotes, escapes) → block with instructions.

INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null)

# Fast path: the literal phrase appears nowhere
case "$CMD" in
  *"gh pr merge"*) ;;
  *) exit 0 ;;
esac

block() {
  echo '{"decision":"block","reason":"'"$1"'"}'
  exit 2
}

# Iterate EVERY textual `gh pr merge` occurrence — a preceding occurrence must not
# shadow a later real invocation (codex R2). Only occurrences at a COMMAND START
# are parsed: start of line, or after ; & | ( — `||` and newlines included (codex
# R4). A space-preceded prose mention (commit -m text, echo of docs) is skipped —
# prose in messages routinely names this command and must not trip the gate.
REST=$CMD
while [ "${REST#*gh pr merge}" != "$REST" ]; do
  PREFIX=${REST%%gh\ pr\ merge*}
  TAIL=${REST#*gh pr merge}
  REST=$TAIL
  LASTLINE=${PREFIX##*$'\n'}
  if [ -n "$LASTLINE" ] && ! printf '%s' "$LASTLINE" | grep -qE '^[[:space:]]*$|[;&|(][[:space:]]*$'; then
    continue
  fi

  # Shell dynamics the gate cannot resolve → fail closed (codex R2/R3): quotes and
  # escapes defeat any separator logic; $ and backticks mean the merged PR is not
  # knowable statically. Checked on the raw tail BEFORE cutting, so an escaped or
  # quoted separator cannot fake an early end of the invocation.
  FIRST_LINE=$(printf '%s' "$TAIL" | sed -n '1p')
  case "$FIRST_LINE" in
    *"'"* | *'"'* | *'\'* | *'`'* | *'$'* )
      block "gh pr merge with quoted, escaped, or dynamic (\$/backtick) arguments cannot be parsed safely by the codex-review hook — run gh pr merge as a standalone command with a literal PR number"
      ;;
  esac

  # This invocation's own arguments: first line only, cut at the first command
  # separator or comment start ( ; | & # — covers && and || as prefixes; codex R1/R4)
  SEG=$(printf '%s' "$FIRST_LINE" | sed -E 's/[;&|#].*$//')

  # Token-level allowlist parse
  PR_NUM=""; REPO_ARG=""; EXPECT_REPO_VAL=0; BAD=""
  for tok in $SEG; do
    if [ "$EXPECT_REPO_VAL" = 1 ]; then
      REPO_ARG=$tok; EXPECT_REPO_VAL=0; continue
    fi
    case "$tok" in
      --repo|-R) EXPECT_REPO_VAL=1 ;;
      --repo=?*) REPO_ARG=${tok#--repo=} ;;
      -R?*) REPO_ARG=${tok#-R} ;;
      --squash|--merge|--rebase|-s|-m|-r|--delete-branch|-d|--admin|--auto) ;;
      https://github.com/*/pull/*)
        if [ -n "$PR_NUM" ]; then BAD=$tok; break; fi
        PR_NUM=$(printf '%s' "$tok" | grep -oE '/pull/[0-9]+' | grep -oE '[0-9]+' | head -1)
        URL_REPO=$(printf '%s' "$tok" | sed -nE 's#https://github.com/([^/]+/[^/]+)/pull/.*#\1#p')
        [ -n "$URL_REPO" ] && REPO_ARG=$URL_REPO
        [ -z "$PR_NUM" ] && { BAD=$tok; break; } ;;
      *)
        if printf '%s' "$tok" | grep -qE '^[0-9]+$' && [ -z "$PR_NUM" ]; then
          PR_NUM=$tok
        else
          BAD=$tok; break
        fi ;;
    esac
  done

  if [ -n "$BAD" ]; then
    # Branch selectors, value-taking flags (--subject/--body/...), or anything else
    # the gate cannot verify — including a second selector (codex R4).
    block "codex-review hook cannot verify this merge form (unrecognized argument: $BAD) — use: gh pr merge <number|pull URL> [--repo owner/repo] [--squash|--merge|--rebase] [--delete-branch]"
  fi
  if [ "$EXPECT_REPO_VAL" = 1 ]; then
    block "gh pr merge carries -R/--repo without a value — could not parse the target repo, refusing to validate against the cwd repo"
  fi
  if [ -z "$PR_NUM" ]; then
    # No literal selector. Non-interactively gh merges the CURRENT BRANCH's PR —
    # an ungated bypass if allowed (codex R4). Require an explicit number/URL.
    block "gh pr merge without a literal PR number merges the current branch's PR ungated — pass an explicit PR number or pull URL"
  fi

  # Check the PR body in the repo the merge actually targets (without forwarding
  # -R/--repo, a same-numbered cwd PR containing 'codex review' would silently
  # pass an unreviewed foreign PR — ops gate-script-vs-runbook-contradictions §3).
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
