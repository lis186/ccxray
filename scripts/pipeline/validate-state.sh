#!/usr/bin/env bash
# Read-only state normalizer + dependency resolver（Phase 0.5）。
# 把三個狀態源——pipeline:* label、issue body 首行相依宣告、PR 實況——
# 收斂成單一狀態，並對現有 open issues 產 migration dry-run 表。
#
#   ★ 絕不 mutate 任何 label／issue／PR。純讀。ready 永遠不代標（見 proposed 規則）。
#
# 狀態 enum: untriaged | ready | in_progress | blocked | needs_owner | pr_open | done
#   （done = 已關 issue，不在 open 清單，故本 script 只輸出前六種）
# 完整 spec（illegal combos、正規化、proposed 規則）見
#   docs/issue-pipeline-runbook.md「狀態機 spec」段。
#
# 用法:
#   validate-state.sh                     # 讀 live gh（open issues + open PRs）
#   validate-state.sh --input <file>      # 讀 {issues:[...],prs:[...]} JSON（測試/重現）
#   validate-state.sh --format tsv        # 機器可讀（預設 md 表）
#
# Exit: 0 = 產出成功（無論各 issue 狀態）  1 = 偵測到 illegal combo（供 CI/收尾把關）
#       3 = 用法/設定錯誤
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "$here/_common.sh"

fmt=md
input=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --input) input="${2:-}"; [[ -n "$input" ]] || pipeline_die "--input 缺檔名"; shift 2 ;;
    --format) fmt="${2:-}"; shift 2 ;;
    *) pipeline_die "未知選項: $1" ;;
  esac
done
[[ "$fmt" == md || "$fmt" == tsv ]] || pipeline_die "--format 只能 md 或 tsv"
command -v jq >/dev/null 2>&1 || pipeline_die "缺指令: jq"

# ── 取資料：live gh 或 --input 快照 ──
if [[ -n "$input" ]]; then
  [[ -f "$input" ]] || pipeline_die "--input 檔不存在: $input"
  data="$(cat "$input")"
  jq -e '.issues and .prs' >/dev/null 2>&1 <<<"$data" || pipeline_die "--input JSON 需含 .issues 與 .prs"
else
  pipeline_need "$PIPELINE_GH"
  issues="$(pipeline_run_to "$PIPELINE_TIMEOUT" "$PIPELINE_GH" issue list --state open --limit 200 --json number,labels,body)" \
    || pipeline_die "gh issue list 失敗"
  prs="$(pipeline_run_to "$PIPELINE_TIMEOUT" "$PIPELINE_GH" pr list --state open --limit 200 --json number,body,headRefName)" \
    || pipeline_die "gh pr list 失敗"
  data="$(jq -n --argjson i "$issues" --argjson p "$prs" '{issues:$i, prs:$p}')"
fi

# open issue 集合（判斷 blocker 是否 unmet：仍在 open 集合 = 未 merge/close = unmet）
open_set="$(jq -r '.issues[].number' <<<"$data")"

# 有 open PR 連結的 issue 集合：branch fix/NNN- 或 PR body 內 close/fix/resolve #NNN
pr_linked=""
prcount="$(jq '.prs | length' <<<"$data")"
for ((j=0; j<prcount; j++)); do
  branch="$(jq -r ".prs[$j].headRefName // \"\"" <<<"$data")"
  pbody="$(jq -r ".prs[$j].body // \"\"" <<<"$data")"
  prnum="$(jq -r ".prs[$j].number" <<<"$data")"
  refs="$(
    { echo "$branch" | grep -oE 'fix/[0-9]+' | grep -oE '[0-9]+' || true
      printf '%s' "$pbody" | grep -oiE '(close[sd]?|fix(es|ed)?|resolve[sd]?)[[:space:]]+#[0-9]+' | grep -oE '[0-9]+' || true
    } | sort -u
  )"
  for r in $refs; do pr_linked+="$r=$prnum"$'\n'; done
done
# 回傳連結某 issue 的 PR 號（空 = 無）
pr_for() { grep -E "^$1=" <<<"$pr_linked" | head -1 | cut -d= -f2 || true; }

# 從 body 首 20 行擷取 Blocked-by 的 issue 號（「無」→ 空）
blockers_of() { printf '%s\n' "$1" | head -n 20 | grep -iE '^[[:space:]]*Blocked-by:' | head -1 | grep -oE '#[0-9]+' | tr -d '#' || true; }

rows=()          # tab-separated: num|current|parsed|illegal|pr|blockers|lint|proposed|action
any_illegal=0
icount="$(jq '.issues | length' <<<"$data")"

for ((i=0; i<icount; i++)); do
  num="$(jq -r ".issues[$i].number" <<<"$data")"
  body="$(jq -r ".issues[$i].body // \"\"" <<<"$data")"
  mapfile -t lbls < <(jq -r ".issues[$i].labels[].name" <<<"$data" 2>/dev/null || true)

  # 現有 pipeline:* label → 狀態集合
  status=(); pipe_labels=()
  for l in "${lbls[@]:-}"; do
    case "$l" in
      pipeline:ready)        status+=(ready);        pipe_labels+=("$l") ;;
      pipeline:in-progress)  status+=(in_progress);  pipe_labels+=("$l") ;;
      pipeline:blocked)      status+=(blocked);      pipe_labels+=("$l") ;;
      pipeline:needs-owner)  status+=(needs_owner);  pipe_labels+=("$l") ;;
      pipeline:batch-*|critical-path) pipe_labels+=("$l") ;;
    esac
  done
  current="-"; [[ ${#pipe_labels[@]} -gt 0 ]] && current="$(IFS=,; echo "${pipe_labels[*]}")"

  # parsedState
  illegal="-"
  case "${#status[@]}" in
    0) parsed=untriaged ;;
    1) parsed="${status[0]}" ;;
    *) parsed=needs_owner; illegal="multiple-status(${status[*]})" ;;
  esac

  # 事實
  prnum="$(pr_for "$num")"
  pr_open=0; [[ -n "$prnum" ]] && pr_open=1
  unmet=()
  for b in $(blockers_of "$body"); do
    grep -qxF "$b" <<<"$open_set" && unmet+=("$b")
  done
  # lint 只呼叫一次，捕捉輸出與 exit code
  lint_out="$("$here/issue-lint.sh" --input - <<<"$body" 2>/dev/null)" && lint=pass || lint=fail
  lint_reasons=""
  [[ "$lint" == fail ]] && lint_reasons="$(grep '^RESULT|fail|' <<<"$lint_out" | cut -d'|' -f3 || true)"

  # illegal combo（label 與事實對帳；已有 multiple-status 就不再覆蓋）
  if [[ "$illegal" == "-" ]]; then
    ilist=()
    if printf '%s\n' "${status[@]:-}" | grep -qx ready; then
      [[ $pr_open -eq 1 ]] && ilist+=("ready+open-PR(#$prnum)")
      [[ ${#unmet[@]} -gt 0 ]] && ilist+=("ready+unmet-blocker(#${unmet[*]})")
    fi
    # stale-blocked：標 blocked 但無 unmet blocker（blocker 已解，resolver 該放行）
    if printf '%s\n' "${status[@]:-}" | grep -qx blocked && [[ ${#unmet[@]} -eq 0 ]]; then
      ilist+=("stale-blocked(blocker-resolved)")
    fi
    [[ ${#ilist[@]} -gt 0 ]] && illegal="$(IFS=';'; echo "${ilist[*]}")"
  fi
  [[ "$illegal" != "-" ]] && any_illegal=1

  # blocker 欄： #a,#b
  blk="-"
  if [[ ${#unmet[@]} -gt 0 ]]; then
    blk=""; for u in "${unmet[@]}"; do blk+="#$u,"; done; blk="${blk%,}"
  fi
  pr_cell="-"; [[ $pr_open -eq 1 ]] && pr_cell="#$prnum"

  # ── proposedState（migration；Q2(a) 推事實態、ready 不代標）──
  #   優先序：illegal → needs_owner；否則 PR→pr_open；unmet→blocked；lint fail→needs_owner；else untriaged
  if [[ "$illegal" != "-" ]]; then
    proposed=needs_owner; action="reconcile labels：$illegal"
  elif [[ $pr_open -eq 1 ]]; then
    proposed=pr_open; action="review/merge 連結 PR #$prnum"
  elif [[ ${#unmet[@]} -gt 0 ]]; then
    proposed=blocked; action="無（resolver 於 blocker merge/close 後自動放行）"
  elif [[ "$lint" == fail ]]; then
    proposed=needs_owner; action="補 issue body：${lint_reasons:-lint fail}"
  else
    proposed=untriaged; action="triage：可派工則人工標 pipeline:ready（pipeline 不代標）"
  fi

  rows+=("$num	$current	$parsed	$illegal	$pr_cell	$blk	$lint	$proposed	$action")
done

# ── 輸出 ──
if [[ "$fmt" == tsv ]]; then
  printf 'num\tcurrent\tparsed\tillegal\tpr\tblockers\tlint\tproposed\taction\n'
  printf '%s\n' "${rows[@]}"
else
  echo "# Migration dry-run — state normalizer 提案表"
  echo
  echo "> 唯讀輸出，**未寫入任何 label**。\`proposed\` 為提案；\`pipeline:ready\` 一律人工標定，此表永不代標。"
  echo "> \`blocked\` 由 dependency resolver 每輪自動重算，非一次性翻轉。"
  echo
  echo "| # | 現有 pipeline label | parsed | illegal combo | PR | 未滿足相依 | lint | **proposed** | owner action |"
  echo "|---|---|---|---|---|---|---|---|---|"
  for r in "${rows[@]}"; do
    IFS=$'\t' read -r num current parsed illegal pr blk lint proposed action <<<"$r"
    echo "| #$num | $current | $parsed | $illegal | $pr | $blk | $lint | **$proposed** | $action |"
  done
  echo
  echo "## 提案狀態彙總"
  printf '%s\n' "${rows[@]}" | cut -f8 | sort | uniq -c | sort -rn | sed 's/^ */- /; s/\([0-9]\) /\1 × /'
  echo
  total="${#rows[@]}"
  echo "共 $total 張 open issue。illegal combo：$( [[ $any_illegal -eq 1 ]] && echo '有（見表）' || echo '無' )。"
fi

exit $(( any_illegal ))
