#!/usr/bin/env bash
# 驗證 owner 簽核標記（APPROVE-DESIGN / ACCEPT-EXCEPTION）。
#
# 防偽造（public repo）：簽核僅在 comment authorAssociation == OWNER 時有效——
#   任何帳號都能留言，validator 驗「作者關聯」而非只驗文字。
# 防誤判：標記必須在**行首精確出現**（`^MARKER <token>`）；內文／backtick 中
#   提及（如文件說明 `APPROVE-DESIGN <runId>`）不算簽核。
# 防自簽：--exclude-run <runId> 會略過 body 含該 runId 的 comment
#   （pipeline 不得把自己該輪產生的 comment 當成 owner 簽核）。
#
# 用法:
#   approve-check.sh <issue> --marker <MARKER> [--exclude-run <runId>]
#   approve-check.sh --input <file> --marker <MARKER> [--exclude-run <runId>]
#     --input {comments:[{body,authorAssociation}]}
#   MARKER ∈ {APPROVE-DESIGN, ACCEPT-EXCEPTION}
#
# Exit: 0 = 有有效 OWNER 簽核（印作者 + token）  1 = 無  3 = 用法/設定錯誤
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "$here/_common.sh"

issue=""; input=""; marker=""; exclude=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --input) input="${2:-}"; [[ -n "$input" ]] || pipeline_die "--input 缺檔名"; shift 2 ;;
    --marker) marker="${2:-}"; shift 2 ;;
    --exclude-run) exclude="${2:-}"; shift 2 ;;
    -*) pipeline_die "未知選項: $1" ;;
    *) issue="$1"; shift ;;
  esac
done
[[ "$marker" == "APPROVE-DESIGN" || "$marker" == "ACCEPT-EXCEPTION" ]] \
  || pipeline_die "--marker 必須是 APPROVE-DESIGN 或 ACCEPT-EXCEPTION"
command -v jq >/dev/null 2>&1 || pipeline_die "缺指令: jq"

if [[ -n "$input" ]]; then
  [[ -f "$input" ]] || pipeline_die "--input 檔不存在: $input"
  data="$(cat "$input")"
  jq -e '.comments' >/dev/null 2>&1 <<<"$data" || pipeline_die "--input JSON 需含 .comments"
else
  [[ "$issue" =~ ^[0-9]+$ ]] || pipeline_die "缺 issue-number（或用 --input）"
  pipeline_need "$PIPELINE_GH"
  data="$(pipeline_run_to "$PIPELINE_TIMEOUT" "$PIPELINE_GH" issue view "$issue" --json comments)" \
    || pipeline_die "gh issue view $issue 失敗"
fi

n="$(jq '.comments | length' <<<"$data")"
for ((k=0; k<n; k++)); do
  assoc="$(jq -r ".comments[$k].authorAssociation // \"\"" <<<"$data")"
  pipeline_assoc_in "$assoc" "$PIPELINE_SIGNOFF_ASSOC" || continue
  body="$(jq -r ".comments[$k].body // \"\"" <<<"$data")"
  # 排除自簽：body 含被排除的 runId
  if [[ -n "$exclude" ]] && grep -qF "$exclude" <<<"$body"; then continue; fi
  # 去除 fenced code block——``` 內的示例標記（如文件裡的 `APPROVE-DESIGN <runId>`）不算簽核
  scan="$(awk '/^[[:space:]]*```/{f=!f; next} !f{print}' <<<"$body")"
  # 行首精確標記 + 後接非空 token
  line="$(printf '%s\n' "$scan" | grep -E "^[[:space:]]*${marker}[[:space:]]+[^[:space:]]" | head -1 || true)"
  if [[ -n "$line" ]]; then
    token="$(sed -E "s/^[[:space:]]*${marker}[[:space:]]+//" <<<"$line" | awk '{print $1}')"
    echo "✓ 簽核成立：$marker by $assoc  token=$token"
    exit 0
  fi
done

echo "✗ 無有效 $marker 簽核（需 authorAssociation==OWNER 且行首精確標記）"
exit 1
