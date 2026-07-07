# Issue 撰寫規範

> 2026-07-07 制定（codex 對抗審查後定稿）。適用所有進 issue-pipeline 的 issue。
> Pipeline 端的執行規範見 `docs/issue-pipeline-runbook.md`；自動化藍圖見 `docs/issue-pipeline-automation-plan.md`。

## Hard gates（pre-flight lint 檢查項，缺任一 → `pipeline:needs-owner`）

### 1. 首行相依宣告（機器可讀）

Issue body 開頭必須有（無相依也要明寫「無」）：

```
Blocked-by: #NNN, #MMM（或「無」）
Blocks: #NNN（或「無」）
Related: #NNN（可省略）
```

**Hard gate 僅 `Blocked-by:`**——它是 dependency resolver 的唯一輸入，缺它 pre-flight lint 即判 `pipeline:needs-owner`。`Blocks:` 為 **advisory**（建議填、pre-flight 提示但不擋）：它是同一條相依邊的反向宣告、可從其他 issue 的 `Blocked-by:` 反推，雙向宣告也無從機械驗一致性。`Related:` 可省略。此與 `docs/issue-pipeline-runbook.md` step 0 及 `scripts/pipeline/issue-lint.sh` 的實際 gate 行為一致。

### 2. 驗收 schema

驗收段必須包含：

- **目標指標**：可計數／可腳本化（「可計數」不等於有語義——行數、函式數這類弱指標不算）
- **guard 指標**：凡是迭代優化型驗收（autoresearch 迴圈尤其），每個 guard 必須**寫明它防哪一種作弊／退化模式**，且與目標指標是不同觀察面（不得是同源數字的重複計數）
- **fixture provenance**：註明用合成或真實資料；合成 fixture 需說明如何從真實資料取樣（見 CLAUDE.md fixture-from-real-data 慣例）
- perf 類：before/after 中位數 ≥5 次、記錄背景負載，依 `docs/verification-principles.md`；bug 類：fail-on-old / pass-on-new 差異證據

### 3. Risk checklist → 強制拆診斷型（不採自評信心分數作為 gate）

以下任一命中，issue 必須拆成「診斷型 + 修復型」兩張，或標 `pipeline:needs-owner` 等 owner 裁決：

- [ ] 修法跨 3 個以上模組，或需要架構級選擇（如移 worker thread）
- [ ] 沒有可重現的 fixture／repro
- [ ] 驗收需要先建新的量測 harness
- [ ] 改動落在 critical path（見 §5）
- [ ] 驗收無法做 old-fail/new-pass 差異證據

**診斷型 issue**：pipeline 終點 = 根因證據 + 設計 md（含修法選項與 tradeoff）+ `pipeline:needs-owner` + agmsg 通知。**不產 PR**。
**簽核原語**：owner 在該 thread 留 `APPROVE-DESIGN <runId>` 精確標記後，才生成修復型 issue；pipeline 必須排除自己 runId 產生的 comment。

### 4. 把握分數（校準記錄用，非 gate）

開 issue 時標「達成把握 ~N%」。此數字**不作為**拆分依據（防自評 95% 繞過——拆分依 §3 checklist），只用於事後對照實際輪次／rework，校準預估品質。

### 5. Critical path 標記

改動可能觸及 **SSE 擷取／forward／hub** 等維生路徑（維持監測系統存活）時掛 `critical-path` label，效果：

- 永久排除 auto-merge（無論畢業制狀態）
- 強制 browser-harness smoke
- **label 只是提示**：auto-merge gate 以 changed-files classifier（實際 diff 路徑）為準，漏標不會放行

## 型別速查

| 型別 | 終點 | 例 |
|---|---|---|
| 修復型 | 有證據的 PR | #166（Map 索引） |
| 診斷型 | 設計 md + needs-owner | #122（root cause 未定） |
| Tracking | 全部子項終態 + aggregate gate | #182（批次目標可設 owner exception：`ACCEPT-EXCEPTION <理由>`） |
