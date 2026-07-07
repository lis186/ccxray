#!/usr/bin/env bash
# 發 GitHub comment / PR body 前的 scrubber。只允許 bounded excerpt / hash /
# exit code / metric 表；攔截疑似完整 request/response/log dump、home 路徑、密鑰。
# 本機 log 可能含 prompt、路徑、token——這道閘在「發出去之前」以 script 執行。
#
# 用法（作為 pipe 閘）:
#   printf '%s' "$draft" | scrub-output.sh | gh issue comment N --body-file -
#   scrub-output.sh --input draft.md
#
# 行為: clean → 原文輸出到 stdout、exit 0；命中 → 違規印到 stderr、
#        **不輸出原文**、exit 1（pipe 到 gh 時 body 為空 → 貼不出去）。
#
# 威脅模型：這是防「pipeline agent **意外**貼出 log/request/token」的啟發式閘，
#   不是對抗式過濾器（agent 是 owner 自己的可信 agent，非敵手）。意外貼上通常是
#   連續、原樣的——R1/R3 針對此。刻意把祕鑰逐字換行拆開之類的規避不在守備範圍。
#
# 可調 env: SCRUB_MAX_FENCE_LINES（單一 fenced 區塊上限，預設 15）
#           SCRUB_MAX_FENCE_TOTAL（所有 fenced 區塊總行數上限，預設 30）
# Exit: 0 = clean  1 = 命中違規（不放行）  3 = 用法/設定錯誤
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "$here/_common.sh"

max_fence="${SCRUB_MAX_FENCE_LINES:-15}"
max_total="${SCRUB_MAX_FENCE_TOTAL:-30}"
input=""
case "${1:-}" in
  --input) input="${2:-}"; [[ -n "$input" ]] || pipeline_die "--input 缺檔名" ;;
  "" ) ;;
  -* ) pipeline_die "未知選項: $1" ;;
  * ) pipeline_die "未知參數: $1（用 stdin 或 --input <file>）" ;;
esac

if [[ -n "$input" ]]; then
  [[ -f "$input" ]] || pipeline_die "--input 檔不存在: $input"
  text="$(cat "$input")"
else
  text="$(cat)"
fi

violations=()

# R1 過長 fenced 區塊：同時看「單一區塊最大行數」與「所有區塊總行數」——
#   後者擋「多段各自 <max 的小 fence 拼成一大坨 dump」的繞過。
read -r maxlen totlen < <(awk '
  /^[[:space:]]*```/ { if (inf) { if (cnt>mx) mx=cnt; tot+=cnt; inf=0 } else { inf=1; cnt=0 }; next }
  inf { cnt++ }
  END { printf "%d %d\n", mx+0, tot+0 }
' <<<"$text")
if [[ "$maxlen" -gt "$max_fence" ]]; then
  violations+=("R1a 單一 fenced 區塊過長（${maxlen} 行 > ${max_fence}）：改貼 bounded excerpt / hash / exit code")
fi
if [[ "$totlen" -gt "$max_total" ]]; then
  violations+=("R1b fenced 總行數過大（${totlen} 行 > ${max_total}）：多段小 fence 拼 dump 仍不放行")
fi

# R2 home 路徑洩漏（含使用者名）
if grep -nE '/(Users|home)/[^/[:space:]]+/' <<<"$text" >/dev/null; then
  lines="$(grep -nE '/(Users|home)/[^/[:space:]]+/' <<<"$text" | cut -d: -f1 | tr '\n' ',' | sed 's/,$//')"
  violations+=("R2 檔案系統路徑含使用者名（行 ${lines}）：改用 repo 相對路徑")
fi

# R3 密鑰／token 形狀 + 長高熵字串（token/log 常見）。sk- 門檻放寬到 8，
#   連換行切成兩段的祕鑰前段也會中；長 base64/hex run 覆蓋多數 token dump。
secret_re='sk-[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|Bearer[[:space:]]+[A-Za-z0-9._-]{16,}|x-api-key|authorization:[[:space:]]*[A-Za-z0-9]|[A-Za-z0-9+/]{40,}={0,2}|[0-9a-fA-F]{40,}'
if grep -nEi "$secret_re" <<<"$text" >/dev/null; then
  lines="$(grep -nEi "$secret_re" <<<"$text" | cut -d: -f1 | tr '\n' ',' | sed 's/,$//')"
  violations+=("R3 疑似密鑰/授權標頭/長高熵字串（行 ${lines}）：一律不得貼")
fi

# R4 完整 request/response JSON（Anthropic/OpenAI 訊息結構訊號）
if grep -nE '"(messages|input|tools|system)"[[:space:]]*:[[:space:]]*\[' <<<"$text" >/dev/null \
   && grep -nE '"(role|content|tool_use|tool_result)"' <<<"$text" >/dev/null; then
  violations+=("R4 疑似完整 request/response JSON（messages/role/content 結構）：改貼 hash + 摘要欄位")
fi

if [[ ${#violations[@]} -gt 0 ]]; then
  { echo "✗ scrub-output 攔截 ${#violations[@]} 項，未放行:"; printf '  - %s\n' "${violations[@]}"; } >&2
  exit 1
fi

# clean：pass-through
printf '%s\n' "$text"
exit 0
