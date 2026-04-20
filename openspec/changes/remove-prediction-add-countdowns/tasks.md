# Tasks

## Phase 1 — Cleanup（刪除誤導 UI）

- [x] 1.1 從 `public/miller-columns.js` 刪除 `predictRemainingTurns`（lines 654-687）
- [x] 1.2 從 `public/miller-columns.js` 刪除 `renderPredictionRow`（lines 726-731）與其呼叫處
- [x] 1.3 grep 全 repo 確認無殘留 `turns left` / `predictRemainingTurns` 引用（僅 docs 中提及，是刻意保留的歷史紀錄）
- [x] 1.4 `CHANGELOG.md` Unreleased section 標示 **Breaking**
- [x] 1.5 程式碼 syntax check 通過 + 237 tests pass（QA 留待 Phase 2+ 合併後做一次 dashboard 實測）

## Phase 2 — Visual Hedges（平行）

- [ ] 2.1 新增 helper `warnIconSvg()` → inline SVG triangle + `!`
- [ ] 2.2 將所有 `⚠` Unicode 字元換成 `warnIconSvg()`（grep `⚠` 全 repo）
- [ ] 2.3 檢查所有絕對 token 閾值是否已 maxContext 百分比化（grep `20000`、`10000` 等硬數字於 context 相關邏輯）
- [ ] 2.4 `public/miller-columns.js` 的 predictor 中 `isSubagent` filter 處留一行註解（已由 Phase 1 刪掉，改到新 feature 的等價 filter 處）

## Phase 3 — Plan Config & Auto-Detection

### 3.0 新增 `server/plans.js` 中央 config

- [x] 3.0.1 新檔 `server/plans.js`，export `PLAN_CONFIG`（pro / max5x / max20x / api-key）
- [x] 3.0.2 定義 shape: `{ tokens5h, monthlyUSD, cacheTtlMs, label }`
- [x] 3.0.3 Export helper `getPlanConfig(planId)` with fallback to api-key + `isKnownPlan(id)`
- [x] 3.0.4 Unit test：10 tests pass（shape / TTL / pricing / fallback / known）

### 3.1 新增 `server/plan-detector.js` 自動偵測

- [x] 3.1.1 新檔 `server/plan-detector.js`
- [x] 3.1.2 `detectPlan(recentUsages)` 純函式：20-turn sliding window over cache writes
- [x] 3.1.3 `getEffectivePlan({ envValue, recentUsages })` 聚合（env > auto > default）
- [x] 3.1.4 Unit test：11 tests pass（insufficient / all 5m / any 1h / mixed / malformed / sliding window / env override / case-insensitive）
- [x] 3.1.5 真實資料驗證：對 464 筆 usage → 正確 detect 為 `max5x` (high confidence)
- [ ] 3.1.6 Server 啟動時 wire 進 store（留到 Phase 3.3 endpoint 時做）
- [ ] 3.1.7 每 100 new entries 重跑 + SSE broadcast（留到 Phase 3.3）

### 3.2 Rate limit headers 捕獲強化（future 5x vs 20x 偵測）

- [x] 3.2.1 `server/ratelimit-log.js` 新模組，exports `appendSample` + `collectRatelimitHeaders`
- [x] 3.2.2 `server/forward.js` 捕獲時 append 到 `~/.ccxray/ratelimit-samples.jsonl`（dedup 於連續相同 headers）
- [x] 3.2.3 `test/ratelimit-log.test.js` 5 個 unit test（pass）
- [x] 3.2.4 `scripts/analyze-ratelimit-samples.mjs` — distribution 分析 + calibration hint
- [ ] 3.2.5 累積 ≥ 50 樣本後執行 script 實測 Max 5x 的 tokensLimit
- [ ] 3.2.6 校準 `PLAN_CONFIG` 的 `tokens5h` 數值（PR separate，實測後合入）

### 3.3 後端 endpoint

- [x] 3.3.1 `server/routes/api.js` 新 endpoint `/_api/settings`
- [x] 3.3.2 回傳 `{ plan, label, source, confidence, cacheTtlMs, tokens5h, monthlyUSD, autoCompactPct }`
- [x] 3.3.3 Unit test：5 tests pass（max5x / pro / api-key fallback / env override / autoCompactPct constant）
- [ ] 3.3.4 SSE `settings_changed` broadcast（延後到 Phase 3.4 前端串接時做）

### 3.4 前端串接

- [ ] 3.4.1 `public/app.js` 啟動 fetch `/_api/settings` 並快取全域
- [ ] 3.4.2 SSE `settings_changed` → 重 fetch settings
- [ ] 3.4.3 Topbar 顯示 `Plan: {label} · TTL {5m|1h}`（含 source tag，如 `(auto)` `(env)`）
- [ ] 3.4.4 首次 detect 未完成時顯示 `auto-detecting...`

### 3.5 Cost/Quota panel 連動（取代硬編常數）

- [ ] 3.5.1 `server/cost-budget.js` 改讀 `plans.getPlanConfig(currentPlan)`
  - `TOKEN_LIMIT` → `planConfig.tokens5h`（api-key → 0 代表無）
  - `SUBSCRIPTION_USD` → `planConfig.monthlyUSD`
- [ ] 3.5.2 `public/quota-ticker.js` 改從 settings 讀：
  - `roi = currentCost / settings.monthlyUSD`
  - `capacity = settings.tokens5h / 300`
  - 若 `monthlyUSD === 0` → 隱藏 ROI badge
- [ ] 3.5.3 `public/cost-budget-ui.js` Zone 1 fallback 改讀 settings
- [ ] 3.5.4 Live rate limit 仍優先（`source: 'live'`）；settings 僅 fallback

### 3.6 Docs

- [ ] 3.6.1 README 新增 `CCXRAY_PLAN=pro|max5x|max20x|api-key` 環境變數說明
- [ ] 3.6.2 CLAUDE.md 記錄 detection 機制（未來 debug 用）
- [ ] 3.6.3 頂層 `docs/plans-and-cache-ttl.md` 寫一頁解釋偵測邏輯與覆寫方式

## Phase 4 — Auto-compact 參考線

- [ ] 4.1 `public/style.css` 新增 `.ctx-bar::after`（83.5% 位置垂直線）
- [ ] 4.2 `.ctx-bar.over-compact::after` 紅色變體
- [ ] 4.3 Ctx bar render 處根據 `ctxPct > AUTO_COMPACT_PCT * 100` 切 `.over-compact` class
- [ ] 4.4 Tooltip `title="auto-compact triggers at ~83.5%"`
- [ ] 4.5 手動 QA：找一個 ctx 85%+ 的 session，確認線變紅

## Phase 5 — Cache TTL Countdown（核心新功能）

- [ ] 5.1 新檔 `public/countdown-ticker.js`：
  - 單一 app-level `setInterval(1000, updateCountdowns)`
  - `updateCountdowns()` 掃 `[data-active="1"]` 的 `.session-item`
  - 分層節流（見 design.md D3）
- [ ] 5.2 `public/entry-rendering.js` `renderSessionItem` 加入 `.cache-countdown` 元素與 `data-last-at`、`data-cache-ttl-ms` 屬性
- [ ] 5.3 `renderSessionItem` 判定 active：`(now - lastReceivedAt) < cacheTtlMs` → `data-active="1"`
- [ ] 5.4 Dormant 恢復：
  - 若新 turn 進來時 `now - prevLastAt > cacheTtlMs` → 顯示 `cache rebuilding`
  - 觀察該 turn response 的 `cache_creation / (cache_creation + cache_read + input)` 比例
  - 若 > 50% → 確認冷啟動，從下一 turn 開始 countdown
- [ ] 5.5 SSE 重連時觸發一次全 session refresh（避免 ticker 用 stale state）
- [ ] 5.6 `public/style.css` 新增 `.cache-countdown`、`.cache-far`、`.cache-near`、`.cache-close`、`.cache-expired` 樣式
- [ ] 5.7 手動 QA：
  - 啟動新 session → 底部顯示 cache countdown
  - 等 cache 到期 → 切 `expired` 狀態
  - 過期後發新 turn → 先 `rebuilding` 再 countdown
  - Pro 預設 5m：countdown 起點 4:59
  - 設 `CCXRAY_PLAN=max` 重啟：起點 59m

## Phase 5.5 — Cache Notification（與 Phase 5 平行，Max plan 預設 on）

### 5.5.1 Passive layer（所有方案，零 permission）

- [x] 5.5.1.1 Tab title flash：`document.title` 在 `⚠ ccxray` 與 `ccxray` 間切換，當任一 active session cache < 60s
- [x] 5.5.1.2 `.cache-close` CSS `cachePulse` 動畫 (Phase 5 已提供)
- [x] 5.5.1.3 離開「緊迫」狀態時還原 title 至 `ccxray`

### 5.5.2 Active layer（Max 預設 on / Pro opt-in）

- [x] 5.5.2.1 `public/cache-notify.js` 新檔
- [x] 5.5.2.2 讀 `settings.plan` 決定 default（max5x/max20x → enabled，其他 → disabled）
- [x] 5.5.2.3 Lead time：max=5min、pro/api-key=60s
- [x] 5.5.2.4 Permission request：使用者 toggle 時才觸發（不在 startup）
- [x] 5.5.2.5 Dedupe：`_notifiedCycles Map<sessionId, lastReceivedAt>`，同 cycle 不重複
- [x] 5.5.2.6 Topbar 🔔/🔕 button 顯示當前狀態 + tooltip
- [ ] 5.5.2.7 `CCXRAY_CACHE_NOTIFY=on|off` env 覆寫（延後，localStorage 先夠用）
- [x] 5.5.2.8 Permission denied → `qt-notify.denied` class, tooltip 提示，無 Layer 2 fire

## Phase 6 — Cross-Level Visual Harmonization

Extends the 83.5% auto-compact landmark added at L1 (Phase 4) to L2 turn
cards and L3 turn detail, so the context hierarchy reads as one series.
Also applies a recent-gate on L1 colors to prevent sea-of-red on historical
sessions. See design D10–D12.

### 6.1 CSS variable for shared threshold

- [x] 6.1.1 `public/settings.js` 設 `:root --compact-threshold` from settings.autoCompactPct
- [x] 6.1.2 Fallback：`:root { --compact-threshold: 83.5%; }` 於 style.css 預設
- [x] 6.1.3 Phase 4 的 `.si-ctx-bar::after` 改用 `var(--compact-threshold)`

### 6.2 L2 turn card: tick on turn-ctx-bar

- [x] 6.2.1 `.turn-ctx-bar` 設 position: relative
- [x] 6.2.2 `.turn-ctx-bar::after` 位於 `var(--compact-threshold)`
- [x] 6.2.3 Tick `top:-1px bottom:-1px width:1px` on parent（超出 3px bar，overflow visible）
- [x] 6.2.4 `title="auto-compact at ~83.5%"` 加在 `.turn-ctx-bar`
- [x] 6.2.5 註解 `entry-rendering.js` 的 thresholds：`// per-turn anomaly detection; see D11 — do not unify with L1/L3`

### 6.3 L3 turn detail: tick on minimap

- [x] 6.3.1 `.minimap::after` 純 CSS 實作，無需改 `renderMinimapHtml` JavaScript
- [x] 6.3.2 Tick 位於 `top: var(--compact-threshold)` (minimap fills top-down：blocks→empty)
- [x] 6.3.3 Minimap element 加 `title="auto-compact at ~X%"`

### 6.4 L1 recent-gate

- [x] 6.4.1 `recent = sess.lastReceivedAt && (Date.now() - sess.lastReceivedAt) < 60*60*1000`
- [x] 6.4.2 `ctxAlertHtml` `!recent` → `.ctx-alert-historical` class (dim grey)
- [x] 6.4.3 `.si-ctx-bar.historical` variant (dim ::before + dimmed ::after)
- [x] 6.4.4 Cache countdown 由 Phase 5 的 `info.active` 檢查自動處理

### 6.5 L1/L3 color threshold 調整（L2 不動）

- [x] 6.5.1 `ctxAlertHtml` 改為 ≥83.5% red / ≥75% yellow，與 recent gate 結合
- [x] 6.5.2 Alert 只在 ≥75% 顯示（historical 同理）— 保留「noteworthy only」semantic
- [x] 6.5.3 **未動** `entry-rendering.js` 的 `>95`/`>85`；加 D11 reference 註解

### 6.6 驗收

- [ ] 6.6.1 Live session at 85% ctx → L1 alert red、L1 bar over-compact、L2 tick 可見、L3 tick 可見
- [ ] 6.6.2 Historical session at 90% ctx → L1 dim (not red)、cache countdown 不顯示
- [ ] 6.6.3 Turn with ctx 55% → L2 `ctx:55%` dim 色、bar 有 tick 但未跨過
- [ ] 6.6.4 Turn with ctx 92% → L2 `ctx-warning` yellow（不動）
- [ ] 6.6.5 Agent-browser 自動化：grep `--compact-threshold` in `getComputedStyle(:root)` = `'83.5%'`
- [ ] 6.6.6 假設 Anthropic 改 0.835 → 0.80：改 `server/routes/api.js` 常數 + 重啟 server → 三層 tick 全部同時移動到 80%

## Phase 7 — Silent Regression Detection（bonus, P2）

- [ ] 7.1 `public/entry-rendering.js` 新增可疑事件偵測：
  - 條件：相鄰 turn `interval > 300s` + `cache_read < 1000` + `cache_creation > 10000`
  - 排除：req body 包含 `/compact` `/clear` `/model` 等 slash command 特徵
- [ ] 7.2 同 session 累計計數器（`session.silentRegressionHits++`）
- [ ] 7.3 達 3 次 → topbar banner：`⚠ Cache TTL looks shorter than expected — possible silent regression`
- [ ] 7.4 Banner 可 dismiss；dismiss 狀態存 localStorage + 24h cooldown
- [ ] 7.5 手動 QA 難（需真實 regression）；改寫 unit test：模擬三個可疑 entry sequence → 期待 banner 出現

## Phase 8 — Final Polish

- [ ] 8.1 `CHANGELOG.md` v1.7.0 完整 release note（移除 + 新增 + breaking note）
- [ ] 8.2 README 截圖更新
- [ ] 8.3 Cross-browser 測試：Safari / Chrome / Firefox / VS Code webview 各跑一次，確認 SVG ⚠ icon 正確、countdown 對齊不壞
- [ ] 8.4 版本 bump：`package.json` 到 1.7.0
- [ ] 8.5 發 release PR，關聯 `fix-turns-left-prediction` change（superseded）

## Validation Checklist

驗收時逐項確認：

- [ ] V1 原 bug 的 317f419d 類 session 不再顯示 `≈367 turns left`（欄位消失）
- [ ] V2 Cache countdown 在 active session 底部顯示並準確倒數
- [ ] V3 Pro 預設 5m，`CCXRAY_PLAN=max` 切 1h（重啟 server 生效）
- [ ] V4 Ctx bar 在 83.5% 位置有視覺線，ctx > 83.5% 變紅
- [ ] V5 Dormant session 恢復時不騙人（不顯示 `1:00:00` 在已過期的 cache 上）
- [ ] V6 移除 turns-left 後無 JS 錯誤、無 CSS layout 破圖
- [ ] V7 Silent regression banner 可觸發（單元測試）、可 dismiss（手動）
