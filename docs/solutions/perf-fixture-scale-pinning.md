# 效能對照的 fixture 規模釘死

- 發現：2026-08-02，#348 / PR #409
- 適用：效能 before/after 對照、OOM 重現、任何讀取 fixture 的 benchmark

## 現象

PR #409 驗證 `--max-old-space-size=400` 下 drift 存活時，共用 fixture
`/tmp/ccxray-bench-348` 先被 dev agent 從 550k 行 502MB 重生成為 300k 行
274MB（重現 codex 情境），之後 orchestrator 為最終基準又重生成回 550k。
Orchestrator 隨後在 300k 校準的預期下（drift @400MB 在 300k 規模可過）對
已是 550k 的 fixture 跑 drift @400MB → exit 134（OOM kill）→ 誤判為「程式
回歸」（悲觀方向的假回歸——實際是 fixture 變大了）。

啟動三方對照（舊碼 @550k vs. 新碼 @550k vs. 新碼 @300k）重驗後才定位是
規模差異而非程式回歸，白跑一整輪。

## 為什麼會出問題

效能對照的因果鏈：**fixture 規模 → 記憶體峰值 → pass/fail 判定**。中途換
fixture 等於換了自變量但沒更新因變量的預期——OOM 被歸因為程式回歸而非
規模放大，結果不可比但看起來可比。

## 可操作規則

**1. 對照的 fixture 規模與內容寫進證據表。**

每輪對照結果必須附：

```
fixture: /tmp/ccxray-bench-348-drift
lines:   550,123
bytes:   502,481,920
sha256:  <hash>（可選，需要位元級一致時）
```

**2. 每輪對照前驗證 fixture 與宣稱一致。**

```bash
wc -l < /tmp/ccxray-bench-348-drift/logs/index.ndjson
ls -l /tmp/ccxray-bench-348-drift/logs/index.ndjson
```

數字與證據表不符 → 停下，不跑。

**3. 多情境需要不同規模時用獨立目錄。**

```
/tmp/ccxray-bench-348-drift    # 550k, for OOM regression
/tmp/ccxray-bench-348-codex    # 300k, for codex scenario repro
```

絕不重生成共用目錄。兩個 fixture 各自有自己的行數/bytes 紀錄。

**4. 不信任 `/tmp` 的時間穩定性。**

`/tmp` 是共享空間——其他 agent、cron、手動操作都可能碰到同一個路徑。效能
fixture 的路徑應含足夠的辨識資訊（issue 號 + 情境後綴），且在跑之前驗證
而非假設。

## 與既有原則的關係

這是 `docs/solutions/negative-claim-evidence-standard.md` §2-2（注入值與被測值
撞號）的 fixture 版本：當 fixture 的實際規模與預期不符時，你無法區分「程式
回歸了」和「測試條件變嚴苛了」——方向可以是樂觀（規模縮小假通過）或悲觀
（規模放大假回歸），本次踩的是悲觀方向。

也呼應 memory `feedback_static_snapshot_for_comparison.md`（比對兩 server 必須
cp 靜態 index.ndjson；symlink 造成 200+ false diff）——同一個原則：**對照的
輸入必須是靜態快照，不是活的引用**。

## 相關

- #348 / PR #409（streaming index restore）
- `docs/solutions/negative-claim-evidence-standard.md`（驗證陷阱的通則）
