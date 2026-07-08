#!/usr/bin/env bash
# 差異檢查：同一測試在舊碼必須 FAIL、新碼必須 PASS。
# 通用獨立驗證器（非某條 pipeline 專屬）——手動或自動化驗 bug 修復的 old-fail/
# new-pass 差異證據皆用它；即使 repo 內無文件連結它，也**刻意保留**，勿當死碼清除。
# 用法: diff-check.sh <base-ref> <test-file...> -- <test-cmd...>
# 例:   diff-check.sh main test/escape.test.js -- node --test test/escape.test.js
# Exit: 0 = old FAIL / new PASS   1 = 新碼失敗   2 = 舊碼也 PASS(測試分辨不出新舊)
#       3 = 用法/設定錯誤(不具證據語意 — 修正呼叫方式後重跑)
set -euo pipefail

die() { echo "❌ usage/config: $*" >&2; exit 3; }

[[ $# -ge 1 ]] || die "缺 base-ref。用法: diff-check.sh <base-ref> <test-file...> -- <test-cmd...>"
base="$1"; shift

# 解析 test-files 直到 '--'；缺 '--' 或無 test-file 都是設定錯誤，不可當證據
tests=()
found_sep=0
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "--" ]]; then found_sep=1; shift; break; fi
  tests+=("$1"); shift
done
[[ $found_sep -eq 1 ]] || die "缺 '--' 分隔符，無法區分 test-file 與 test-cmd"
[[ ${#tests[@]} -ge 1 ]] || die "'--' 前至少要有一個 test-file（否則差異證明無測試可帶進舊碼）"
cmd=("$@")
[[ ${#cmd[@]} -ge 1 ]] || die "'--' 後缺 test-cmd"

root=$(git rev-parse --show-toplevel)

# 每個 test-file 必須在新碼存在，否則無從複製進舊碼、證據無效
for t in "${tests[@]}"; do
  [[ -f "$root/$t" ]] || die "test-file 不存在於當前工作樹: $t"
done

wt=$(mktemp -d)/before
git -C "$root" worktree add --force --detach "$wt" "$base" >/dev/null 2>&1 \
  || die "無法在 $base 建立 worktree（ref 不存在？）"
trap 'git -C "$root" worktree remove --force "$wt" >/dev/null 2>&1 || true' EXIT

# 新測試複製進舊碼並確認落地；deps 用 symlink 共享，避免舊碼因缺 node_modules 假失敗
for t in "${tests[@]}"; do
  mkdir -p "$wt/$(dirname "$t")"
  cp "$root/$t" "$wt/$t"
  [[ -f "$wt/$t" ]] || die "測試檔複製進舊 worktree 失敗: $t"
done
[[ -d "$root/node_modules" && ! -e "$wt/node_modules" ]] && ln -s "$root/node_modules" "$wt/node_modules"

echo "== NEW code: expect PASS =="
if ! (cd "$root" && "${cmd[@]}"); then
  echo "❌ 新碼失敗 — 先讓它綠再來證明差異"; exit 1
fi

echo "== OLD code ($base): expect FAIL =="
if (cd "$wt" && "${cmd[@]}"); then
  echo "⚠️  舊碼也 PASS — 這個測試分辨不出新舊，證明不了「更好」"; exit 2
fi

echo "✅ old FAIL / new PASS — 差異檢查成立"
