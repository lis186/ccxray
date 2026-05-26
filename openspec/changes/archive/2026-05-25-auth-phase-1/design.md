## Context

ccxray 是 localhost HTTP proxy，Phase 1 前完全無認證。設計文件在 `reason/260525-0055-ccxray-auth-design/candidate-AB.md`（歷史記錄）+ `errata.md`（實際實作偏差）。Phase 1 的核心約束是 **warn-only，零破壞** — 所有新 gate 都只 log 不擋。

## Goals / Non-Goals

**Goals:**
- 建立 HKDF key hierarchy（root → K_upstream / K_session / K_bootstrap）
- 把 request 分 upstream vs dashboard 兩個 domain
- Cookie-based browser session（HttpOnly, SameSite=Strict, HMAC-signed）
- Bootstrap flow：`ccxray open` → fragment-based token → cookie
- Launcher 注入 `X-Ccxray-Auth` header 到 spawned agents
- WS upgrade 分類 + warn-only gate
- 確保 ccxray-internal headers 不洩漏到 upstream

**Non-Goals:**
- 擋任何既有流量（Phase 2 做）
- Unix socket hub IPC（Phase 2 做）
- Ephemeral mode default-deny（Phase 2 做）
- Windows Named Pipes（Phase 2+ 做）

## Decisions

### 決策 1：Fragment-based bootstrap 而非 query-string
**理由**：`#k=` fragment 不會送到 server、不出現在 access log、不在 Referer 中、不被瀏覽器書籤同步。比 `?token=` 在所有面向都更安全。（errata §1.1 修正了原設計中 `document.cookie.includes` 與 HttpOnly 的矛盾，改用 `/_auth/status` endpoint probe。）

### 決策 2：Codex API-key 用 model_providers.ccxray 而非 request_headers
**理由**：Codex CLI 不支援 `request_headers` config key（spike 驗證回 `unknown configuration field`）。`model_providers.<name>.http_headers` 是正確路徑。（errata §1.3 記錄了完整 spike。）

### 決策 3：ChatGPT-OAuth Codex 走舊路徑
**理由**：強制 `model_provider="ccxray"` 會讓 Codex 把 ChatGPT OAuth JWT 附到自訂 provider，破壞 OAuth flow。Skip model_provider override，讓 Codex 用原生 `openai_base_url` 連接。（errata §1.3 threat model 分析。）

### 決策 4：classifyUpstreamAuth 三分類
**理由**：WS upgrade 需要區分三種狀態：(1) 帶了 X-Ccxray-Auth = authed，(2) ChatGPT-OAuth markers = 合法但無法帶 header = chatgpt-oauth（不 warn），(3) 什麼都沒有 = warn。JWT-shaped 判定：`Bearer` prefix + 三段 dot-separated + header 段 >10 chars。

### 決策 5：getUpstreamToken() 集中在 providers.js 頂層
**理由**：每次 createLaunch 呼叫時 lazy derive，try-catch 包裝，失敗只 warn 不 abort。Phase 1 的「不壞」保證靠這個 fallback。

## Risks / Trade-offs

- **X-Ccxray-Auth 在 Phase 1 是 dead header**：injected but never checked by auth gates。By-design — Phase 2 加辨識。Codex review gate 指出此問題，確認為 false positive。
- **`ANTHROPIC_CUSTOM_HEADERS` 是外部依賴**：如果 Claude Code 移除此 env，injection 靜默失敗。Phase 1 中影響為零（warn-only）。
- **authMiddleware 與 _isDashboardAuthenticated 邏輯重複**：Phase 2 consolidate。

## Migration Plan

Phase 1 沒有 migration — 所有舊路徑繼續工作。Deprecation headers (`X-Ccxray-Deprecation`) 通知使用者哪些認證方式將在 Phase 2 被移除。

PR #36 merged to main (commit `5931bfa`)。Branch `feat/auth-phase-1` 已刪。
