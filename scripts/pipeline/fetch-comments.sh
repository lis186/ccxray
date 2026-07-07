#!/usr/bin/env bash
# 取 issue/PR comments，只輸出受信任作者（OWNER/MEMBER/COLLABORATOR）的留言。
# untrusted 留言直接丟棄，不進 agent context——public repo 的 prompt injection 面
# 在「餵 context 之前」就關掉，而非交給 agent 自行判斷。
#
# 用法:
#   fetch-comments.sh <number>            # 預設 issue
#   fetch-comments.sh --pr <number>       # 改取 PR
#   fetch-comments.sh --input <file>      # {comments:[{body,authorAssociation,author{login}}]}
#   fetch-comments.sh ... --json          # 輸出 JSON 陣列（預設可讀文字）
#
# Exit: 0 = 成功（含 0 則受信任留言）  3 = 用法/設定錯誤
# 丟棄統計印到 stderr（不污染 stdout 的受信任內容流）。
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "$here/_common.sh"

kind=issue; input=""; as_json=0; number=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --pr) kind=pr; shift ;;
    --input) input="${2:-}"; [[ -n "$input" ]] || pipeline_die "--input 缺檔名"; shift 2 ;;
    --json) as_json=1; shift ;;
    -*) pipeline_die "未知選項: $1" ;;
    *) number="$1"; shift ;;
  esac
done
command -v jq >/dev/null 2>&1 || pipeline_die "缺指令: jq"

if [[ -n "$input" ]]; then
  [[ -f "$input" ]] || pipeline_die "--input 檔不存在: $input"
  data="$(cat "$input")"
  jq -e '.comments' >/dev/null 2>&1 <<<"$data" || pipeline_die "--input JSON 需含 .comments"
else
  [[ "$number" =~ ^[0-9]+$ ]] || pipeline_die "缺 $kind number（或用 --input）"
  pipeline_need "$PIPELINE_GH"
  data="$(pipeline_run_to "$PIPELINE_TIMEOUT" "$PIPELINE_GH" "$kind" view "$number" --json comments)" \
    || pipeline_die "gh $kind view $number 失敗"
fi

# 受信任集合轉成 jq 陣列
trusted_json="$(printf '%s\n' $PIPELINE_TRUSTED_ASSOC | jq -R . | jq -s .)"
filtered="$(jq --argjson ok "$trusted_json" \
  '[.comments[] | select(.authorAssociation as $a | $ok | index($a))]' <<<"$data")"

total="$(jq '.comments | length' <<<"$data")"
kept="$(jq 'length' <<<"$filtered")"
dropped=$(( total - kept ))
echo "fetch-comments: kept=$kept dropped=$dropped (untrusted) of $total" >&2

if [[ "$as_json" -eq 1 ]]; then
  printf '%s\n' "$filtered"
  exit 0
fi

for ((k=0; k<kept; k++)); do
  login="$(jq -r ".[$k].author.login // \"?\"" <<<"$filtered")"
  assoc="$(jq -r ".[$k].authorAssociation // \"?\"" <<<"$filtered")"
  body="$(jq -r ".[$k].body // \"\"" <<<"$filtered")"
  echo "── comment by ${login} (${assoc}) ──"
  printf '%s\n\n' "$body"
done
exit 0
