# Issue Pipeline Runbook

你是 orchestrator：**不親自寫碼**。派工、核實、裁決、記錄。開發與驗證交給 subagent。目標是把人的介入收斂到三點：merge、被點名的決策題、blocked 清單。

## 真相來源：GitHub，不是 session 記憶

- 每批開始先 `gh issue list --state open` + `gh pr list` 重讀實況；**同時 `git log --oneline -5` + `git status` 重驗 git 狀態**（session 快照與記憶都會過時；本機有自動 sync 會推 main，分支可能已被 rebase/merge）。
- 下方批次表是 2026-07-06 制定的快照。**與 GitHub 實況衝突時以 GitHub 為準，並更新本檔**（改表提交進 PR 或獨立 docs commit）。
- 每張 issue 完成或 blocked，當下就留 issue comment——進度不留在對話裡。

## 批次順序（批內序列執行，不平行——同檔互撞）

**Batch 0 — 安全快修（獨立小張）**：#163（ws CVE + CI audit gate；WS smoke 需真實 codex 流量，做不到就標註邊界升級給人）→ #164 → #150 → #151 → #165（⚠️ merge 影響已發佈產物，PR 必附 `npm pack --dry-run` 清單）→ #169 第一步（client 補 autoMemory，先寫一致性測試看它紅）。

**Batch 2 — quick win**（Batch 1 收 wf-color 分支已於 2026-07-06 完成）：#156（吸收 #150 的 escapeHtml 搬家，若其已先修則只搬）→ #166 → #167 → #168 → #170。

**Batch 3 — 結構重構（嚴格串行、每批 ≤5 檔、人審每階段）**：#158 → #159 → #160 →（量測 index.js 殘餘後在 #161 留數據，建議關閉或動工）。#157 獨立軌：**動工前升級給人**排 #112/#115/#116/#117 相依。

**Batch 4 — 中期安全**：#152 → #153（⚠️ 長 SSE 誤殺風險，驗收含長串流實測）→ #154 → #155 → #169 結構解（A/B 是 owner 決策題）。

**不派工**：feature backlog（#30/#64/#76/#78）、品味題（#144 殘餘決策、#169 A/B、#157 設計）——列入升級清單等 owner。

## 每張 issue 的標準流程

1. **重驗**：Explore subagent 重驗 issue 內 file:line 證據（都是快照，repo 變動快）。證據失效 → 更新 issue body 再動工；問題已不存在 → 留證據關閉。
2. **隔離**：獨立 git worktree ＋ branch `fix/NNN-slug`。**絕不在 main 上直接改**（本機自動 sync 會立刻推出去）。
3. **開發 subagent**：issue body 即規格。硬規則寫進派工 prompt：不順手重構、不碰無關檔案；遇 A/B 設計題**停下標 blocked-on-owner，不猜**。
4. **驗證（fresh subagent，不共開發者 context）**：載入 `verifying-improvements` skill，按 `docs/verification-principles.md` 的「改動類型→驗證方式」表執行：
   - bug 類（#150/#151/#164/#169）：`diff-check.sh` old-fail/new-pass
   - 重構類（#156/#158/#159/#160）：rg 結構指標＋確認沒有 fail-on-old 測試混入
   - 效能類（#166/#167）：同條件 before/after ≥5 次中位數
5. **Orchestrator 親自重跑**：只採信自己重跑的 exit code 與數字，不採信任何 subagent 的文字轉述。
6. **Gates**（全過才開 PR）：`CCXRAY_HOME=$(mktemp -d) npm test` 全綠 → 隔離 smoke（`CCXRAY_HOME=/tmp/ccxray-smoke-$$ ccxray --port 5602 --no-browser`；UI 改動用 browser-harness/CDP）→ codex review gate（codex CLI 二審 clean）。
7. **PR**：附證據（diff-check 輸出、基準數字、rg 計數、pack 清單），link issue，明說驗了什麼、**沒**驗什麼。
8. **失敗預算**：同一 issue 兩次修不動 → 留下已試路徑與驗證輸出的 comment、標 blocked → 跳下一張。不硬試第三次。

## 環境安全（硬規則）

- 絕不碰 port 5577、絕不讀寫真實 `~/.ccxray`（使用者的活 hub 正在監控）。
- 只在 feature branch 工作；不 commit/push main。
- 刪檔/覆寫前先 `git status` 看該路徑的追蹤狀態——session 快照不可信。

## 升級給人的固定格式

批次結束輸出三欄：**待 merge 的 PR**（各附證據層級：爬到可信度階梯第幾層）／**blocked 清單**（含已試路徑）／**待決策題**（一句話講清 A/B 與你的建議）。
