# Next-session prompt (paste as first message)

繼續 ccxray Codex parity 工作。

**前情**：
- A1-A3 write-path abstraction ✅ PR #37 (50 commits, 708 tests)
- N3 noise filter ✅ PR #38 (isNoiseRequest 覆蓋所有 ChatGPT platform paths + /v1/models)
- Auth loopback trust ✅ PR #39 (isLoopbackBypass 預設信任 loopback)
- N2 credential scanning ✅ PR #40 (recursive scanObjectForCredentials，20 test cases)
- N1 session collapse ✅ verified non-issue (2026-06-04)：3 concurrent codex exec 正確分離
- P3 maxContext ✅ verified non-issue (2026-06-04)：SSE-HTTP / WS 都走 buildEntryFields → inferMaxContext
- B3 N3 啟動雜訊 ✅ already fixed by PR #38 (2026-06-04 re-verified：codex exec 只產生 1 entry，MCP RPC 是 codex-internal 不走 proxy)
- 分支都已 merge 到 main 並刪除

**Ledger 剩餘真 gap（依優先）**：
1. **B1 stopReason** — Codex 顯示 `?`（live+restore），需從 response.completed/status 取
2. **B2 title** — 靜態 "Codex WebSocket session"，可改用 input summary
3. **B4 cache TTL 顯示** — topbar 對 Codex 顯示 Claude 式 "API key · TTL 5m (detecting…)"
4. **P1 成本頁** — 歷史掃 ~/.codex/sessions
5. **P5 rate-limit** — Codex rate-limit 偵測

**建議本次目標**：B1 stopReason + B2 title（都在 wire-parsers/openai.js buildEntryFields 裡改）

**硬規則**：
- smoke 用隔離 CCXRAY_HOME + 獨立 port，絕不用 :5577
- 非 trivial 走 codex review gate
- 編輯 server/ 前確認 :5577 hub 非 --watch

完整 gap ledger 在 `reason/260603-codex-parity-ledger/ledger.md`。
