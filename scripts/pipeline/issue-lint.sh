#!/usr/bin/env bash
# 依 docs/issue-authoring.md hard gates 檢查 issue body（pre-flight lint）。
#
# 執行邊界（executable-first）：只 hard-fail 機械可判且不會誤殺的項目——
#   語義品質（guard 防哪種作弊、fixture 取樣、成對指標）屬「說明層 10%」，
#   由 codex 二審與人審把關，這裡只印 advisory 不動 exit code。
#   （見 docs/issue-pipeline-runbook.md 狀態機 spec 的 lint 段。）
#
# Hard gates（缺任一 → exit 1）:
#   G1  首行相依宣告 `Blocked-by:`（dependency resolver 的輸入，載重項）
#   G2  可驗收訊號（驗收段/目標指標/差異證據 markers 至少一項）
# Advisory（印出、不影響 exit code）:
#   A1  缺 `Blocks:` 反向宣告（issue-authoring.md 要求，但可反推 → 不 hard）
#   A2  risk checklist 有勾選（`- [x]`）→ 應拆診斷型或 needs-owner
#
# 用法:
#   issue-lint.sh <issue-number>          # 以 gh 取 body
#   issue-lint.sh --input <file>          # 從檔讀 body（測試/重用）
#   issue-lint.sh --input -               # 從 stdin 讀 body
#
# Exit: 0 = 通過 hard gates   1 = hard gate 失敗   3 = 用法/設定錯誤
# 末行必為機器可讀摘要:  RESULT|pass|            或  RESULT|fail|<reason;reason>
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "$here/_common.sh"

body=""
case "${1:-}" in
  --input)
    src="${2:-}"; [[ -n "$src" ]] || pipeline_die "--input 缺檔名（或 '-' 表 stdin）"
    if [[ "$src" == "-" ]]; then body="$(cat)"; else
      [[ -f "$src" ]] || pipeline_die "--input 檔不存在: $src"
      body="$(cat "$src")"
    fi ;;
  "" ) pipeline_die "用法: issue-lint.sh <issue-number> | --input <file|->" ;;
  -* ) pipeline_die "未知選項: $1" ;;
  * )
    [[ "$1" =~ ^[0-9]+$ ]] || pipeline_die "issue-number 必須是數字: $1"
    pipeline_need "$PIPELINE_GH"
    body="$(pipeline_run_to "$PIPELINE_TIMEOUT" "$PIPELINE_GH" issue view "$1" --json body --jq '.body')" \
      || pipeline_die "gh issue view $1 失敗" ;;
esac

# 首 20 行視為「開頭」——相依宣告必須在此區塊，避免匹配到內文深處的散字。
head_block="$(printf '%s\n' "$body" | head -n 20)"

reasons=()
echo "── issue-lint ──"

# G1: Blocked-by 宣告（行首、大小寫不敏感、允許前導空白）
if printf '%s\n' "$head_block" | grep -qiE '^[[:space:]]*Blocked-by:[[:space:]]*[^[:space:]]'; then
  echo "✓ G1 首行相依宣告 Blocked-by:"
else
  echo "✗ G1 缺首行 Blocked-by: 宣告（無相依也要明寫「無」）"
  reasons+=("missing-blocked-by")
fi

# G2: 可驗收訊號（寬鬆 OR，避免誤殺不同措辭的合法驗收）
accept_re='驗收|目標指標|guard|fixture|before/after|中位數|P95|fail-on-old|old-fail|new-pass|pass-on-new|差異證據|可腳本化'
if printf '%s\n' "$body" | grep -qiE "$accept_re"; then
  echo "✓ G2 偵測到可驗收訊號"
else
  echo "✗ G2 無可驗收訊號（目標指標／差異證據／驗收段）"
  reasons+=("no-acceptance-signal")
fi

# A1: Blocks 反向宣告（advisory）
if printf '%s\n' "$head_block" | grep -qiE '^[[:space:]]*Blocks:[[:space:]]*[^[:space:]]'; then
  echo "✓ A1 Blocks: 反向宣告"
else
  echo "⚠ A1 缺 Blocks: 反向宣告（advisory；可反推，不 hard-fail）"
fi

# A2: risk checklist 勾選（advisory）
if printf '%s\n' "$body" | grep -qE '^[[:space:]]*-[[:space:]]*\[[xX]\]'; then
  echo "⚠ A2 risk checklist 有勾選 → 應拆診斷型或標 needs-owner（advisory）"
fi

if [[ ${#reasons[@]} -eq 0 ]]; then
  echo "RESULT|pass|"
  exit 0
else
  # join reasons with ';'
  joined="$(IFS=';'; echo "${reasons[*]}")"
  echo "RESULT|fail|$joined"
  exit 1
fi
