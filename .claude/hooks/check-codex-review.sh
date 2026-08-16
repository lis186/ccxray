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

# Threat model: guards the repo's own trusted agent against ACCIDENTAL ungated
# merges. Deliberate evasion (gh pr \"merge\", m=merge; gh pr \$m, base64 wrappers…)
# is out of scope — the agent is not an adversary (same stance as ops
# scrub-output.sh). Normalization: backslash-newline continuations are joined
# (codex R6) and whitespace runs squeezed so accidental line wrapping or a double
# space doesn't dodge the textual scan.
CMDS=$(printf '%s' "$CMD" | perl -0pe 's/\\\n//g' | tr '\t' ' ' | tr -s ' ')

# Fast path: the literal phrase appears nowhere
case "$CMDS" in
  *"gh pr merge"*) ;;
  *) exit 0 ;;
esac

block() {
  echo '{"decision":"block","reason":"'"$1"'"}'
  exit 2
}

# Shell quote state at the end of the given text: 0=outside, 1=in-single,
# 2=in-double. Models escapes and skips #-to-EOL comments while outside quotes
# (codex R6: raw parity miscounts "don't" and quotes inside comments).
quote_state() {
  printf '%s' "$1" | awk '
    { line = $0
      for (i = 1; i <= length(line); i++) {
        c = substr(line, i, 1)
        if (s == 0) {
          # comment starts at line start or after a token boundary (codex R7)
          if (c == "#" && (i == 1 || substr(line, i-1, 1) ~ /[ \t;&|()]/)) break
          if (c == "\x27") {
            # ANSI-C $\x27…\x27 quote: backslash escapes inside (codex R7)
            if (i > 1 && substr(line, i-1, 1) == "$") s = 3; else s = 1
          }
          else if (c == "\"") s = 2
          else if (c == "\\") i++
        } else if (s == 1) {
          if (c == "\x27") s = 0
        } else if (s == 3) {
          if (c == "\\") i++
          else if (c == "\x27") s = 0
        } else {
          if (c == "\"") s = 0
          else if (c == "\\") i++
        }
      }
    }
    END { print (s + 0 == 0) ? 0 : s }'
}

# Iterate EVERY textual `gh pr merge` occurrence — a preceding occurrence must not
# shadow a later real invocation (codex R2). Only occurrences at a COMMAND START
# are parsed: start of line, or after ; & | ( — `||` and newlines included (codex
# R4). A space-preceded prose mention (commit -m text, echo of docs) is skipped —
# prose in messages routinely names this command and must not trip the gate.
REST=$CMDS
CONSUMED=""
while [ "${REST#*gh pr merge}" != "$REST" ]; do
  PREFIX=${REST%%gh\ pr\ merge*}
  TAIL=${REST#*gh pr merge}
  REST=$TAIL
  FULLPREFIX="$CONSUMED$PREFIX"
  CONSUMED="$FULLPREFIX""gh pr merge"

  # Inside an unclosed quote = prose in a string (commit -m text quoting a merge
  # command), never a command start — skip. Shell-aware state on the FULL prefix.
  if [ "$(quote_state "$FULLPREFIX")" != "0" ]; then
    continue
  fi

  LASTLINE=${FULLPREFIX##*$'\n'}
  # Command start = line start, after ; & | ( {, or after env-assignment /
  # env / command prefixes (GH_TOKEN=x gh pr merge … is an accidental shape).
  if [ -n "$LASTLINE" ] && ! printf '%s' "$LASTLINE" | grep -qE '(^[[:space:]]*|[;&|({][[:space:]]*)((env|command)[[:space:]]+|[A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*[[:space:]]+)*$'; then
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
  # separator ( ; | & — covers && and || as prefixes; codex R1/R4). A comment
  # starts only where # begins a word ( 11#feature is a branch selector, not a
  # comment — codex R5; it then falls to the token allowlist and fails closed).
  SEG=$(printf '%s' "$FIRST_LINE" | sed -E 's/[;&|].*$//; s/(^|[[:space:]])#.*$//')

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

  # The gate is "a second reviewer ran to completion and the PR says so", not "codex
  # specifically". codex is the default; grok is accepted because the codex CLI goes
  # unavailable on its own account quota, and a gate that cannot be satisfied for a
  # week gets routed around rather than obeyed (2026-08-17).
  #
  # The grok alternative is the COMPLETION MARKER ONLY — `grok gate clean`, the
  # phrase the review loop terminates with. Not a bare `grok review`, which as an
  # unanchored substring also matches "TODO: grok review after CI", "please grok
  # review this" and "grok reviewer signed off": a body that names the reviewer
  # while saying the review has NOT happened would pass. (The legacy `codex review`
  # alternative carries that same looseness; it is left alone because existing PR
  # bodies depend on it, and tightening it belongs in its own change.)
  #
  # Same threat model as the rest of this script: a guard against ACCIDENTAL
  # unreviewed merges by the repo's own trusted agent, not against evasion. It stays
  # a textual check because the alternative — verifying a review actually happened —
  # is not something a merge-time hook can do.
  if ! echo "$BODY" | grep -qiE 'codex gate clean|codex review|codex-exempt|grok gate clean'; then
    block "PR #$PR_NUM body missing second-review evidence — run /codex-loop (or the grok equivalent) and record which reviewer ran"
  fi
done

exit 0
