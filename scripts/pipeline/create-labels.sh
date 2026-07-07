#!/usr/bin/env bash
# 建立 pipeline:* 狀態/屬性 labels（冪等：先查再建，已存在跳過、不覆寫）。
# 狀態 label 互斥：ready / in-progress / blocked / needs-owner。
# 屬性 label（非狀態）：batch-0/2/3/4；critical-path 已人工建立，本 script 不碰。
# 用法: create-labels.sh [--dry-run]
# Exit: 0 = 全部就位（新建或既存）  1 = 有 label 建立失敗  3 = 用法/設定錯誤
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "$here/_common.sh"

dry=0
case "${1:-}" in
  --dry-run) dry=1 ;;
  "") ;;
  *) pipeline_die "用法: create-labels.sh [--dry-run]" ;;
esac

pipeline_need "$PIPELINE_GH"

# name|color|description（color 不含 #）
labels=(
  "pipeline:ready|0E8A16|狀態：已 triage、可派工。僅 owner 標定，pipeline 不代標"
  "pipeline:in-progress|FBCA04|狀態：本輪處理中（lease 持有）。狀態 label 互斥"
  "pipeline:blocked|D93F0B|狀態：相依未滿足或兩次失敗；附已試路徑 comment"
  "pipeline:needs-owner|5319E7|狀態：需 owner 裁決／簽核／補 body；illegal combo 正規化終點"
  "pipeline:batch-0|BFDADC|屬性（非狀態）：安全快修批"
  "pipeline:batch-2|BFDADC|屬性（非狀態）：quick win 批"
  "pipeline:batch-3|BFDADC|屬性（非狀態）：結構重構批"
  "pipeline:batch-4|BFDADC|屬性（非狀態）：中期安全批"
)

existing="$(pipeline_run_to "$PIPELINE_TIMEOUT" "$PIPELINE_GH" label list --limit 200 --json name --jq '.[].name')" \
  || pipeline_die "gh label list 失敗（未認證或無網路？）"

rc=0
while IFS='|' read -r name color desc; do
  if grep -qxF "$name" <<<"$existing"; then
    echo "= exists: $name"
    continue
  fi
  if [[ $dry -eq 1 ]]; then
    echo "+ would create: $name (#$color)"
    continue
  fi
  if pipeline_run_to "$PIPELINE_TIMEOUT" "$PIPELINE_GH" \
      label create "$name" --color "$color" --description "$desc" >/dev/null 2>&1; then
    echo "+ created: $name"
  else
    echo "✗ failed: $name" >&2
    rc=1
  fi
done < <(printf '%s\n' "${labels[@]}")

exit $rc
