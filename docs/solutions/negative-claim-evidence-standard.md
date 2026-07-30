# 負向主張的證據標準，與「測不到東西的測試」

- 日期：2026-07-30
- 來源：#377 / PR #378 的四輪 codex 二審 + 兩輪 Fable 評審
- 適用：任何要斷言「X 不會發生 / X 不存在 / 這個 guard 成立」的場合，以及任何寫驗收條件的場合

## 為什麼記這一篇

#377 起於一個看似單純的顯示 bug（weather 的 context% 分母錯了）。修完之後，codex 二審連續四輪各報一條 P2，每輪都把問題往上游推一層：

```
weather 用最後一個 turn 的 raw maxContext
  → R1: partial-scope 的四個呼叫端沒注入正確 window
    → R2: client 重算用被裁切的 allEntries，覆寫 server 算對的結果
      → R3: mergeColdSessions 根本沒把 server 的 fold 送進 hot session
        → R4: (a) server/client 分類分歧可能撐大窗口  (b) 撐大後沒重算
```

中間三層修好時，測試全綠、gate 全過。**每一層的「看起來對」都是真的，只是它回答的問題比我以為的窄。**

這一篇記錄兩類反覆出現的失效，以及可操作的檢查。

## 第一類：負向主張證據不足

### 三個實例

**1-1 「server fold 已 gate 在 `!isSubagent`，所以 #211 over-latch guard 仍成立」**（我寫在 `mergeColdSessions` 的註解裡）

錯。server 端的 `entry.isSubagent` 是 `store.isAnthropicSubagent()` 的啟發式，而 client 用的是完整分類管線（agentKey → overlap spans → coreHash routing → seq tracker）。ADR 0005 全文講的就是這兩者會分歧。我引用了一個真實存在的 gate，來背書一個它並不保證的性質。

**1-2 「reconcile 會治癒 live-merge 的 enrichment 缺口」**（寫進 ADR 0013 的 amendment 初稿）

錯。`reconcileMetas` 只比較 session 數與 responseId-dedup 後的 entry 數；enrichment 不改任何計數，所以偵測不到。`loadSessionIndex` 的 mtime 檢查也不覆蓋（`sessions.json` 通常後寫、較新）。真相是「只有顯式 rebuild 會治癒」。這句話從研究報告→派工單→ADR 文件傳了三手，三個環節都有機會攔下，只有最後一個攔到——而它攔到是因為派工單要求「遇到矛盾停下回報」而不是「照寫」。

**1-3 「單機單實例結構性不會命中 merge」**（Fable 用來論證某筆債不必追蹤）

錯。它引 ADR 0012 的「within one process each response is logged exactly once」（SSE/非 SSE 互斥、retry gated on `!headersSent`）——那句話證明的是**寫入路徑**不會重複寫。但 merge 的輸入還有**重放路徑**：`restore.js` 把磁碟上的 line 重新變成 entry 再走一次同一個 helper，而 restore 跑在 post-listen，與 live 流量天然併發。該 merge 呼叫點正上方的註解**明文寫著這件事**。

### 共同形狀

三個都是**引用一個真實存在的機制（註解／ADR／既有 guard），來背書一個它並不涵蓋的主張**。引文本身沒錯，錯在它的語境邊界被忽略：

- 1-1 的 gate 保證「server 認定的 subagent 被排除」，不保證「client 認定的 subagent 被排除」
- 1-2 的 reconcile 保證「計數漂移會觸發重建」，不保證「欄位 enrichment 會觸發重建」
- 1-3 的 ADR 保證「寫入路徑不重複寫」，不保證「沒有其他路徑餵進同一個 helper」

這比寫錯邏輯更難自己發現，因為**讀自己的註解時它讀起來完全合理**——你記得的是引文的結論，不是它的前提。

### 可操作的檢查

**A. 負向主張要窮舉呼叫點，不是引權威文件。**

要斷言「不會有 X 走到這個分支」，先 `grep -n "<helper>" server/ public/` 列出**全部**呼叫點，逐點問「這裡的輸入從哪來、能不能與另一點併發」。1-3 只要跑這一步，restore 那個呼叫點五分鐘就會推翻結論。

CLAUDE.md 已有「grep absence is not proof of absence／負向主張要更強證據」這條規則，但它在 1-3 沒有觸發——因為**引用了 ADR（看起來比 grep 更權威）就覺得免跑窮舉**。補一句：引文的權威性不能替代呼叫點窮舉。

**B. ADR 是決策快照，不是現行碼的行為規格。**

ADR 0012 主文的互斥性論證寫於 restore 批次 merge 落地**之前**；它自己的 Implementation notes 甚至提到了 restore 用 batch post-pass。主文與 implementation notes 有時序差，讀主文論證時要對齊。

判斷「X 不會發生」的證據標準：**呼叫點窮舉（grep 全部 call site）+ 至少一條 runtime 路徑追蹤**。ADR 引文只能當輔助。

**C. 引用既有 guard 前，先驗兩側定義是否一致。**

1-1 的形狀是「A 側有 gate、B 側讀它」，但 A 的 gate 用 A 的定義。凡是跨 server/client、跨 batch/live、跨寫入/讀取的 guard 引用，都要問「兩邊的判準是同一份程式碼嗎」。若不是，guard 只在單側成立。

**D. 檢查自己輸出的內部矛盾。**

同一份報告裡同時寫「fold 是 monotone max/OR」與「fold=400K 但 ctxPct=0 的實害樣本」——兩者矛盾（缺值不可能把 max fold 拉低），但沒被互檢。這是唯一不需要額外資訊就能抓到的錯誤類別：**拿自己寫的約束回頭讀自己寫的結論**。

**E. 「oracle 本身要先驗。」**

把 `rebuildFromMetas` 的輸出當成驗收基準寫進票裡，卻沒對這個基準跑過同樣的懷疑——它的 weather 段沒有 responseId 去重，副本會灌高 factor。**任何被當成「正確答案」的東西，都要先當成「待驗的東西」查一遍。**

## 第二類：測試本身測不到東西

一天內三次，全部是綠燈但斷言無效。

### 三個實例

**2-1 `git stash` 對已 commit 的檔案是 no-op。** 要做 fail-on-old（舊碼必須紅），先 commit 了才 stash，stash 什麼也沒動，測試「通過」是假的。正確做法是 `git checkout HEAD~1 -- <file>`（注意 `HEAD~1` 要真的是要對照的那個 commit），或用 `scripts/diff-check.sh`。

**2-2 注入值與被測值撞號。** 一條「證明 `opts.sessionWindow` 覆寫生效」的測試注入 `200000`，而被測 turn 自己的 `maxContext` 恰好也是 `200000`——舊碼（讀 turn 自己的值）算出同樣結果，一樣綠。注入的值必須與**所有** fallback 來源都不同。

**2-3 測試繞過真實路徑。** 一條「證明 hot session 會拿到 server fold」的測試，直接在 session 物件上寫 `beta1m`/`maxContext` 欄位，繞過了真正負責搬運的 `mergeColdSessions`。那條路徑完全壞掉時測試仍然綠。**測試必須驅動真實入口，不是自己擺好終局狀態。**

### 可操作的檢查

**F. 每寫一條斷言，問一次：如果我要驗的東西根本不存在、或實作是假的，這條會紅嗎？**

三個實例都會被這一問攔下。這比任何 gate 都有效，因為 gate 只數綠燈。

**G. 負向對照要跑，不是要想。**

把修正**停用**（註解掉、`git checkout HEAD~1 -- <file>`）再跑一次，確認目標斷言真的變紅，並把該輸出留進 PR。不採信「應該會紅」。

**H. Guard 要掛在與目標指標不同源的觀察面上。**

目標指標驗「修好了」，guard 驗「沒有用作弊方式修好」。若兩者讀同一個輸出，作弊實作會同時騙過兩者。例：目標指標讀 weather 的 ctxPct，guard 就去讀 `computeCtxUsed` 的回傳、或讀 session 的計數欄位。

**I. 差距要遠大於量測粒度。** 一條驗「分子含不含 output」的測試若 fixture 的 output 只有 800 tokens（0.4pp），假實作驗不出來；放大到 20000（10pp）才有鑑別力。

## 一句話版本

> **負向主張要窮舉呼叫點，不要引權威文件；驗收斷言要先證明它會紅，不要相信它綠。**

## 相關

- ADR 0005（server/client 分類分歧的既有契約）
- ADR 0012（read-time merge；主文論證與 implementation notes 有時序差）
- ADR 0013 的 `## Amended by #377`（1-2 的最終誠實版本）
- `docs/verification-principles.md`（fail-on-old 的既有規範）
- `docs/solutions/gate-manifest-vs-scrub-collision.md`（同批的另一條規則衝突）
- #381 #383–#388（本批開出的追蹤票；#388 即 1-3 的產物）
