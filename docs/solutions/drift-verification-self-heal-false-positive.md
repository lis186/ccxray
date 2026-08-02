# drift 驗證的 self-heal 假陽性

- 發現：2026-08-02，#348 / PR #409
- 適用：drift/reconcile/cache-rebuild 等「修復路徑會回寫、治癒自身觸發條件」的驗證

## 現象

`restoreFromLogs` 的 drift 修復路徑：

```
createReconcileTally 偵測 sessions.json 與 index.ndjson 不一致
  → rebuildFromMetasAsync 重建
  → 成功後 flush 寫回治好的 sessions.json
```

第一輪驗證在 `--max-old-space-size=400` 下跑 drift → exit 0，dev agent 回報
「drift 路徑在 400MB 限制下存活」。Orchestrator 重驗時對照組也 exit 0 且 log
**無 `drift detected` 行** — 根本沒觸發 drift。原因：上一輪的 flush 已把修好的
`sessions.json` 寫回同一個 `CCXRAY_HOME`，第二輪讀到一致的檔案對，走的是普通
restore 空路徑。

同一陷阱踩了兩次：dev agent 回報一次、orchestrator 在 pre-P1 對照組又踩一次。

## 為什麼 exit code 不具證據力

drift 修復路徑 exit 0 = 修復成功。普通 restore（無 drift）也 exit 0。沒有
觸發條件時兩者不可區分。一個「通過」的測試必須先證明被測路徑有被走到。

## 可操作規則

**1. 每輪驗證前重新弄壞輸入。**

drift 類驗證的 fixture 必須在每輪開始前恢復成不一致狀態：

```bash
# 保存乾淨的壞檔備份（只做一次）
cp logs/sessions.json sessions.json.bak-broken

# 每輪驗證前
cp sessions.json.bak-broken logs/sessions.json
touch logs/sessions.json   # 使 sessions.json 比 index.ndjson 新
```

注意 mtime 前置條件：`loadSessionIndex` 的 staleness 檢查比較
`sessions.json` 與 `index.ndjson` 的 mtime——若 index 較新，直接拒載
sessions.json 走 stale rebuild 路徑，永遠不會印 `drift detected`。drift
觸發的前提是 sessions.json **能被載入**（mtime ≥ index），但**內容**與
index 不一致。所以 touch 的對象是 sessions.json（讓它較新、能載入），不是
index.ndjson。

**2. 驗證 log 必含觸發行。**

exit 0 不是 drift 修復路徑的證據。Log 必須包含 `drift detected`（或等效的
觸發訊息）才算有效樣本。無此行的 exit code 只能證明「普通 restore 沒掛」。

被驗證的指令必須會終止——長駐 server 會讓 pipeline 永遠跑不到
grep。用會自然退出的 driver，或觀察到終態後明確停掉 server。

```bash
set -e -o pipefail  # -e: server crash 後不繼續走到 grep（否則 crash+drift 行都印了 → grep 成功 → exit 0 假陽性）
CCXRAY_HOME=<fixture> RESTORE_DAYS=14 node scripts/bench/bench-348-restore.js 2>&1 | tee run.log
grep -q 'drift detected' run.log || { echo "INVALID: drift not triggered" >&2; exit 1; }
```

**3. 通則：修復路徑會回寫治癒自身觸發條件的系統都適用。**

以下模式都有同樣的陷阱：

| 系統 | 觸發條件 | 修復動作 | 回寫效果 |
|------|----------|----------|----------|
| drift reconcile | sessions.json 與 index 不一致 | rebuild + flush | 寫回一致的 sessions.json |
| cache rebuild | cache miss 或 stale | regenerate + write | 寫回有效 cache |
| schema migration | version mismatch | migrate + bump version | 寫回新 version |

對這類系統，驗證框架必須：
- 在每輪開始前**獨立於被測系統**地重建觸發條件
- 在 log 中確認觸發訊息存在
- 不信任 exit code 作為「被測路徑有效」的唯一指標

## 相關

- `docs/verification-principles.md`（fail-on-old 規範的上游文件）
- `docs/solutions/negative-claim-evidence-standard.md`（「測不到東西的測試」第二類 §2-1/§G：負向對照要跑不是要想）
- #348 / PR #409（streaming index restore）
