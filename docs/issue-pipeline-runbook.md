# Issue Pipeline Runbook

你是 orchestrator：**不親自寫碼**。派工、核實、裁決、記錄。開發與驗證交給 subagent。目標是把人的介入收斂到三點：merge、被點名的決策題、blocked 清單。

## 自主推進原則

只在工作真正需要人介入時暫停：**破壞性或不可逆的操作**、**真正的範圍變更**、**只有 owner 能提供的資訊或決策**。其餘一律繼續推進，完成後才報告——不要為可逆、範圍內、有合理預設的步驟停下來問「要不要…？」。

判斷準則：
- **停**：merge（見 base branch protection 一節）、刪 remote branch、關 issue、改 issue body、跨 issue 的範圍擴張、A/B 設計題（#157/#169-A/B 之類）、兩次失敗的 blocked。
- **不停、直接做**：開分支/worktree、commit、開 PR、跑測試與 smoke、重驗證據、修 review findings、留 issue/PR comment、批內序列推進下一張。
- 不確定屬於哪類時，看「錯了能不能廉價回滾」——能就做、做完報告；不能就停。

## 真相來源：GitHub，不是 session 記憶

- 每批開始先 `gh issue list --state open` + `gh pr list` 重讀實況；**同時 `git log --oneline -5` + `git status` 重驗 git 狀態**（session 快照與記憶都會過時；本機有自動 sync 會推 main，分支可能已被 rebase/merge）。
- 下方批次表是 2026-07-06 制定的快照。**與 GitHub 實況衝突時以 GitHub 為準，並更新本檔**（改表提交進 PR 或獨立 docs commit）。
- 每張 issue 完成或 blocked，當下就留 issue comment——進度不留在對話裡。

## 批次順序（批內序列執行，不平行——同檔互撞）

**相依分支規則**：有前置相依的 issue（例：#156 依 #150 的 escapeHtml 搬家）必須等前置 PR **merge 進 main 後**、從最新 main 開分支才動工；**絕不 stack PR**（不以另一個未 merge 的 branch 為 base）。等待前置 merge 期間，可以先做同批內無相依的下一張。

**Batch 0 — 安全快修（獨立小張）**：#163（ws CVE + CI audit gate；WS smoke 需真實 codex 流量，做不到就標註邊界升級給人）→ #164 → #150 → #151 → #165（⚠️ merge 影響已發佈產物，PR 必附 `npm pack --dry-run` 清單）→ #169 第一步（client 補 autoMemory，先寫一致性測試看它紅）。

**Batch 2 — quick win**（Batch 1 收 wf-color 分支已於 2026-07-06 完成）：#156（吸收 #150 的 escapeHtml 搬家，若其已先修則只搬）→ #166 → #167 → #168 → #170。

**Batch 3 — 結構重構（嚴格串行、每批 ≤5 檔、人審每階段）**：#158 → #159 → #160 →（量測 index.js 殘餘後在 #161 留數據，建議關閉或動工）。#157 獨立軌：**動工前升級給人**排 #112/#115/#116/#117 相依。

**Batch 4 — 中期安全**：#152 → #153（⚠️ 長 SSE 誤殺風險，驗收含長串流實測）→ #154 → #155 → #169 結構解（A/B 是 owner 決策題）。

**不派工**：feature backlog（#30/#64/#76/#78）、品味題（#144 殘餘決策、#169 A/B、#157 設計）——列入升級清單等 owner。

## 每張 issue 的標準流程

1. **重驗**：Explore subagent 重驗 issue 內 file:line 證據（都是快照，repo 變動快）。證據失效 → **留 corrective comment**（新舊 file:line 對照）再動工，issue body 非經 owner 同意不改；問題已不存在 → 留證據 comment 並升級給 owner 決定關閉。
2. **隔離**：獨立 git worktree ＋ branch `fix/NNN-slug`。**絕不在 main 上直接改**（本機自動 sync 會立刻推出去）。
3. **開發 subagent**：issue body 即規格。硬規則寫進派工 prompt：不順手重構、不碰無關檔案；遇 A/B 設計題**停下標 blocked-on-owner，不猜**。
4. **驗證（fresh subagent，不共開發者 context）**：按 `docs/verification-principles.md` 的「改動類型→驗證方式」表執行（本機若有 `verifying-improvements` skill 可載入輔助，沒有不影響——所需工具都在 repo 內）：
   - bug 類（#150/#151/#164/#169）：`scripts/diff-check.sh <base-ref> <test-file...> -- <test-cmd...>` 產出 old-fail/new-pass 證明（exit 0=成立、1=新碼沒過、2=測試分辨不出新舊、3=用法/設定錯誤——不具證據語意，修正呼叫後重跑）；腳本不可用時照 `docs/verification-principles.md` 末段的 worktree fallback 手動執行
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
