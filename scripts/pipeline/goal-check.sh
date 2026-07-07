#!/usr/bin/env bash
# 收尾 goal check：驗一張 issue 是否落在四個合法終態之一。
# 「本輪處理過的 issue ∈ 合法終態」不成立 → 不准收尾。
#
# 四終態（任一成立即通過）:
#   T1 有證據 open PR   — 有連結該 issue 的 open PR（證據品質由 codex/人審，這裡驗連結存在）
#   T2 blocked          — pipeline:blocked label + ≥1 comment（已試路徑）
#   T3 needs-owner 結構化 — pipeline:needs-owner + 受信任作者 comment 含 {reason, requiredOwnerAction, runId}
#   T4 診斷完成          — pipeline:needs-owner + 受信任作者 comment 連結 docs/solutions/<檔> 且該檔存在
#      （agmsg 通知非 GitHub 可觀測，goal-check 一律不驗——見 runbook「收尾 goal check」段）
#
# 受信任作者 = authorAssociation ∈ OWNER/MEMBER/COLLABORATOR（擋 untrusted 偽造終態）。
#
# 用法:
#   goal-check.sh <issue>
#   goal-check.sh --input <file>     # {issue:{number,labels,comments}, prs:[...]}
# env: PIPELINE_SOLUTIONS_DIR（預設 <repo>/docs/solutions）
#
# Exit: 0 = 在合法終態（印哪一個）  1 = 不在任何合法終態（印缺口）  3 = 用法/設定錯誤
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/../.." && pwd)"
# shellcheck source=_common.sh
source "$here/_common.sh"

solutions_dir="${PIPELINE_SOLUTIONS_DIR:-$repo_root/docs/solutions}"
input=""; issue=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --input) input="${2:-}"; [[ -n "$input" ]] || pipeline_die "--input 缺檔名"; shift 2 ;;
    -*) pipeline_die "未知選項: $1" ;;
    *) issue="$1"; shift ;;
  esac
done
command -v jq >/dev/null 2>&1 || pipeline_die "缺指令: jq"

if [[ -n "$input" ]]; then
  [[ -f "$input" ]] || pipeline_die "--input 檔不存在: $input"
  data="$(cat "$input")"
  jq -e '.issue' >/dev/null 2>&1 <<<"$data" || pipeline_die "--input JSON 需含 .issue"
else
  [[ "$issue" =~ ^[0-9]+$ ]] || pipeline_die "缺 issue-number（或用 --input）"
  pipeline_need "$PIPELINE_GH"
  iv="$(pipeline_run_to "$PIPELINE_TIMEOUT" "$PIPELINE_GH" issue view "$issue" --json number,labels,comments)" \
    || pipeline_die "gh issue view $issue 失敗"
  prs="$(pipeline_run_to "$PIPELINE_TIMEOUT" "$PIPELINE_GH" pr list --state open --limit 200 --json number,headRefName,body)" \
    || pipeline_die "gh pr list 失敗"
  data="$(jq -n --argjson i "$iv" --argjson p "$prs" '{issue:$i, prs:$p}')"
fi

num="$(jq -r '.issue.number' <<<"$data")"
mapfile -t labels < <(jq -r '.issue.labels[].name' <<<"$data" 2>/dev/null || true)
has_label() { printf '%s\n' "${labels[@]:-}" | grep -qxF "$1"; }

# 連結該 issue 的 open PR？（branch fix/NNN- 或 body close/fix/resolve #NNN）
linked_pr=""
prcount="$(jq '.prs | length' <<<"$data" 2>/dev/null || echo 0)"
for ((j=0; j<prcount; j++)); do
  branch="$(jq -r ".prs[$j].headRefName // \"\"" <<<"$data")"
  pbody="$(jq -r ".prs[$j].body // \"\"" <<<"$data")"
  prnum="$(jq -r ".prs[$j].number" <<<"$data")"
  refs="$( { echo "$branch" | grep -oE 'fix/[0-9]+' | grep -oE '[0-9]+' || true
             printf '%s' "$pbody" | grep -oiE '(close[sd]?|fix(es|ed)?|resolve[sd]?)[[:space:]]+#[0-9]+' | grep -oE '[0-9]+' || true; } | sort -u )"
  for r in $refs; do [[ "$r" == "$num" ]] && linked_pr="$prnum"; done
done

# 受信任作者 comment 逐則掃描 T3/T4 訊號
ccount="$(jq '.issue.comments | length' <<<"$data" 2>/dev/null || echo 0)"
trusted_comments=0
struct_block=0
blocked_evidence=0
sol_ref=""; sol_exists=0
for ((k=0; k<ccount; k++)); do
  assoc="$(jq -r ".issue.comments[$k].authorAssociation // \"\"" <<<"$data")"
  pipeline_assoc_in "$assoc" "$PIPELINE_TRUSTED_ASSOC" || continue
  trusted_comments=$((trusted_comments+1))
  cbody="$(jq -r ".issue.comments[$k].body // \"\"" <<<"$data")"
  # T3 結構化 block：同一 comment 同時含 reason / requiredOwnerAction / runId
  if grep -qiE 'reason' <<<"$cbody" \
     && grep -qiE 'required[ _-]?owner[ _-]?action|requiredOwnerAction' <<<"$cbody" \
     && grep -qiE 'run[ _-]?id' <<<"$cbody"; then
    struct_block=1
  fi
  # T2 blocked 證據：留言須含「已試路徑/原因」訊號，光有 comment（如 "ack"）不算
  if grep -qiE '已試|試過|嘗試|試了|tried|attempt|blocked|卡在|卡住|失敗|fail|error|reason|因為|因此' <<<"$cbody"; then
    blocked_evidence=1
  fi
  # T4 solutions 連結
  ref="$(grep -oE 'docs/solutions/[A-Za-z0-9._/-]+' <<<"$cbody" | head -1 || true)"
  if [[ -n "$ref" ]]; then
    sol_ref="$ref"
    rest="${ref#docs/solutions/}"
    [[ -f "$solutions_dir/$rest" ]] && sol_exists=1
  fi
done

# ── 判定 ──
hits=()
[[ -n "$linked_pr" ]] && hits+=("T1:evidence-PR(#$linked_pr)")
if has_label "pipeline:blocked" && [[ "$blocked_evidence" -eq 1 ]]; then hits+=("T2:blocked"); fi
if has_label "pipeline:needs-owner" && [[ "$struct_block" -eq 1 ]]; then hits+=("T3:needs-owner-structured"); fi
if has_label "pipeline:needs-owner" && [[ -n "$sol_ref" && "$sol_exists" -eq 1 ]]; then hits+=("T4:diagnostic($sol_ref)"); fi

if [[ ${#hits[@]} -gt 0 ]]; then
  echo "✓ #$num 合法終態：$(IFS=', '; echo "${hits[*]}")"
  exit 0
fi

# 未達終態：列缺口
echo "✗ #$num 未達任何合法終態"
echo "  labels: $( [[ ${#labels[@]} -gt 0 ]] && (IFS=,; echo "${labels[*]}") || echo '-' )"
echo "  linked open PR: $( [[ -n "$linked_pr" ]] && echo "#$linked_pr" || echo '無' )（T1）"
echo "  blocked+comment: $( has_label pipeline:blocked && echo "label✓ evidence=${blocked_evidence} tc=${trusted_comments}" || echo 'label✗' )（T2）"
echo "  needs-owner+結構化: $( has_label pipeline:needs-owner && echo "label✓ struct=$struct_block" || echo 'label✗' )（T3）"
echo "  診斷 solutions 檔: ref=${sol_ref:-無} exists=${sol_exists}（T4；dir=${solutions_dir}）"
exit 1
