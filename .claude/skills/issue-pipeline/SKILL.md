---
name: issue-pipeline
description: >
  Orchestrate the ccxray GitHub issue backlog in dependency order with subagents —
  re-verify, develop in worktrees, verify with diff-check evidence, gate, PR.
  Use when asked to 處理 issue、跑 issue pipeline、continue the backlog、process batch N.
---

# Issue Pipeline

完整 runbook 以 **`docs/issue-pipeline-runbook.md`** 為準（已進版控）——先完整讀取它，照章執行。本檔只是本機入口捷徑，不放內容：兩份若有出入，一律以 docs 那份為準（`.claude/skills/` 被 repo .gitignore 排除，屬既定政策，所以內容不能只放這裡）。

執行摘要：你是 orchestrator，不親自寫碼。GitHub 是唯一真相（開場重讀 issue/PR/git 實況）。批內序列派工：Explore 重驗 → worktree 開發 subagent → fresh 驗證 subagent（`docs/verification-principles.md` + `scripts/diff-check.sh`）→ orchestrator 親自重跑 exit code → gates（隔離 npm test、隔離 smoke、codex 二審）→ PR 附證據。兩次失敗即 blocked。絕不碰 5577 與真實 `~/.ccxray`，絕不直接動 main。結尾輸出：待 merge／blocked／待決策三欄。**自主推進：只在破壞性/不可逆操作、真正範圍變更、或只有 owner 能給的資訊/決策時暫停；其餘可逆且範圍內的步驟直接做完再報告，不要中途問「要不要…？」。**
