# Countdown UI Capability

## ADDED Requirements

### Requirement: Cache TTL Countdown 顯示於 active session card

Session card 底部顯示 cache 到期倒數，僅對 active session 啟用動態更新。

#### Scenario: 一般 active session 顯示倒數

- **Given** session 最後一輪 response 在 30 秒前完成
- **And** 計費方案為 Pro（TTL 5 分鐘）
- **When** dashboard 渲染該 session card
- **Then** 底部顯示 `cache 4:30 ⏱`
- **And** card 有 `data-active="1"` 屬性

#### Scenario: Cache 進入最後 60 秒

- **Given** cache 剩餘 45 秒
- **When** ticker 執行
- **Then** 文字顯示 `cache 0:45 ⏱`
- **And** 套用 `.cache-close` CSS class（紅色 + 閃爍）

#### Scenario: Cache 已過期

- **Given** session 最後一輪在 TTL 之前
- **When** dashboard 渲染
- **Then** 顯示 `cache expired` 靜態文字
- **And** card 失去 `data-active` 屬性
- **And** ticker 不再更新此 card

#### Scenario: Dormant session 收到新 turn

- **Given** session 閒置超過 TTL
- **When** 新 turn 進來
- **Then** 顯示 `cache rebuilding`（首輪 response 前）
- **And** 觀察首輪 response 的 `cache_creation / total_input`
- **If** 比例 > 50% → 確認冷啟動，下一輪起恢復 countdown
- **If** 比例 < 50% → 視為 cache 其實還在，立即顯示 countdown

### Requirement: Ticker 分層節流

單一 app-level `setInterval(1000)` 驅動所有 active session 的 countdown，依 remaining 時間分層決定更新頻率。

#### Scenario: TTL > 5 分鐘每 10 秒才改文字

- **Given** cache 剩餘 12 分鐘
- **When** ticker 連續執行 10 次（10 秒）
- **Then** DOM textContent 只被改 1 次（從 `12m` 到 `11m`）

#### Scenario: TTL 1–5 分鐘每秒更新

- **Given** cache 剩餘 3:15
- **When** ticker 執行 1 次
- **Then** 文字更新為 `3:14`

### Requirement: Auto-compact 視覺參考線

Ctx bar 永遠在 83.5% 位置顯示垂直線，ctx 超過該線時線色切紅作為警示。

#### Scenario: Ctx 未達門檻

- **Given** session `latestMainCtxPct = 72`
- **When** dashboard 渲染 ctx bar
- **Then** ctx bar 填滿 72% 寬度
- **And** 在 83.5% 位置有 1px dim-colored 垂直線
- **And** `title="auto-compact triggers at ~83.5%"`

#### Scenario: Ctx 超過門檻

- **Given** session `latestMainCtxPct = 87`
- **When** dashboard 渲染
- **Then** ctx bar 有 `.over-compact` class
- **And** 83.5% 垂直線切紅
- **And** 使用者視覺可立即辨識「已進入 auto-compact 區間」

### Requirement: Plan 設定由環境變數驅動

`CCXRAY_PLAN` 決定 `CACHE_TTL_MS` 常數，影響 countdown 起始值。

#### Scenario: 預設方案為保守

- **Given** 啟動時無 `CCXRAY_PLAN` env var
- **When** server 啟動
- **Then** `PLAN_LABEL = 'API key'`
- **And** `CACHE_TTL_MS = 300_000`（5 分鐘）

#### Scenario: Max 方案

- **Given** `CCXRAY_PLAN=max` 啟動
- **When** server 啟動
- **Then** `PLAN_LABEL = 'Max'`
- **And** `CACHE_TTL_MS = 3_600_000`（1 小時）
- **And** topbar 顯示 `Plan: Max · TTL 1h`

#### Scenario: 未知值 fallback

- **Given** `CCXRAY_PLAN=enterprise`（未定義值）
- **When** server 啟動
- **Then** 視為預設 `API key`，TTL 5 分鐘

### Requirement: Auto-detect plan via cache TTL signal

Server 自動從 response usage 的 `cache_creation.ephemeral_5m/1h_input_tokens` 推論使用者方案，作為 `CCXRAY_PLAN` env 未設時的 fallback。

#### Scenario: 最近 cache writes 全為 1h → Max

- **Given** 最近 20 筆有 cache write 的 response，`ephemeral_1h_input_tokens > 0` 占 ≥ 1 筆
- **When** `getEffectivePlan()` 被呼叫
- **Then** 回傳 `{ plan: 'max5x', source: 'auto', confidence: 'high' }`
- **And** 預設歸為 5x（非 20x，除非使用者 env override 或 rate limit headers 證實）

#### Scenario: 最近 cache writes 全為 5m → Pro

- **Given** 最近 20 筆 cache write 全 `ephemeral_5m_input_tokens > 0` 且 `ephemeral_1h = 0`
- **When** `getEffectivePlan()`
- **Then** `{ plan: 'pro', source: 'auto', confidence: 'high' }`

#### Scenario: 資料不足

- **Given** 最近只有 3 筆 cache write
- **When** `getEffectivePlan()`
- **Then** `{ plan: 'api-key', source: 'default', confidence: 'insufficient' }`
- **And** UI 顯示「Plan: API key (default) · auto-detecting...」

#### Scenario: Env var 覆寫自動偵測

- **Given** `CCXRAY_PLAN=max20x` 已設
- **When** `getEffectivePlan()`
- **Then** `{ plan: 'max20x', source: 'env', confidence: 'high' }`
- **And** 偵測結果只用於 log，不影響效果

### Requirement: Plan-aware quota panel

Usage panel（cost budget、quota ticker）使用當前 plan 的 `tokens5h` 與 `monthlyUSD` 常數，取代硬編值。Live rate limit headers 仍為優先資料來源。

#### Scenario: Max 5x 使用者看到正確 ROI

- **Given** detected plan 為 `max5x`（monthlyUSD = 100）
- **And** 當月 cost 為 $120
- **When** quota ticker 計算 ROI
- **Then** 顯示 `ROI 1.2x`（= 120 / 100）

#### Scenario: Max 20x 使用者看到正確 ROI

- **Given** detected plan 為 `max20x`（monthlyUSD = 200）
- **And** 當月 cost 為 $120
- **When** quota ticker 計算 ROI
- **Then** 顯示 `ROI 0.6x`

#### Scenario: API key 使用者隱藏 ROI badge

- **Given** plan 為 `api-key`（monthlyUSD = 0）
- **When** quota ticker 渲染
- **Then** ROI badge 不顯示（避免除零）

#### Scenario: Live rate limit 優先於 plan fallback

- **Given** plan config 說 `max5x.tokens5h = 220_000`
- **And** 當前 window 有 live `anthropic-ratelimit-tokens-limit = 280_000`
- **When** cost API 計算 `tokenLimit`
- **Then** 使用 280_000（live）
- **And** response `source: 'live'`

### Requirement: Cache expiration notification（plan-gated）

Cache 即將到期時提供 notification，依方案決定預設啟用狀態與 lead time。

#### Scenario: Max plan 預設收到 5-min lead 通知

- **Given** plan = `max5x` 或 `max20x`
- **And** `CCXRAY_CACHE_NOTIFY` 未設
- **And** 使用者已授權 notification permission
- **And** 某 session 的 cache 剩餘 5 分鐘
- **When** countdown ticker 執行
- **Then** fire 一次 browser notification，內容含 session id + 操作建議

#### Scenario: Pro plan 預設不收通知

- **Given** plan = `pro`
- **And** `CCXRAY_CACHE_NOTIFY` 未設
- **When** cache 剩餘 60s
- **Then** 不 fire notification
- **But** tab title flash + card border animation 仍作用

#### Scenario: 同 cache cycle 不重複通知

- **Given** 某 session 已觸發一次通知（cache 剩 5min）
- **And** 使用者 4 分鐘內未新發 turn
- **When** ticker 繼續執行到剩 30s
- **Then** 不再 fire（同 cycle）

#### Scenario: 使用者送新 turn → cycle 重置

- **Given** notification 已 fire 過一次
- **When** 使用者送新 turn，`lastReceivedAt` 更新
- **Then** dedupe key 改變，下一輪 cache cycle 獨立追蹤

#### Scenario: Permission denied → 靜默 fallback

- **Given** 使用者拒絕 browser notification permission
- **When** 預期觸發通知
- **Then** 不 throw error
- **And** passive indicator（tab title flash + border animation）仍運作
- **And** console 記錄一次 warning（不重複）

### Requirement: Shared auto-compact landmark across visual hierarchy

The auto-compact threshold (currently ~83.5% per Claude Code) must be
visually represented as the same tick position on every level of the
context visual hierarchy (L1 session card, L2 turn card, L3 turn detail
/ minimap). A single CSS custom property `--compact-threshold` sourced
from `/_api/settings.autoCompactPct` propagates the value to all ticks;
changing the server-side constant updates every tick simultaneously.

#### Scenario: L1 session card shows tick at 83.5%

- **Given** `settings.autoCompactPct = 0.835`
- **When** a session card is rendered
- **Then** `.si-ctx-bar::after` left position = `var(--compact-threshold)` = `83.5%`
- **And** tooltip reads "auto-compact at ~83.5%"

#### Scenario: L2 turn card shows tick at 83.5%

- **Given** a turn card with context bar rendered
- **When** the page loads
- **Then** `.turn-ctx-bar-bg::after` left position = `var(--compact-threshold)` = `83.5%`
- **And** tick height ≥ 5px so it is visible against the 3px colored segments
- **And** tooltip reads "auto-compact at ~83.5%"

#### Scenario: L3 minimap shows tick at 83.5%

- **Given** a turn detail view is open with minimap rendered
- **When** minimap layout completes
- **Then** a visible tick element is positioned at 83.5% up the minimap's
  fill region (from bottom, since minimap fills upward)
- **And** tooltip reads "auto-compact at ~83.5%"

#### Scenario: Threshold change cascades via CSS variable

- **Given** `settings.autoCompactPct` is changed server-side from 0.835 to 0.80
- **When** dashboard reloads
- **Then** all three level ticks visually move to 80% simultaneously
- **And** no JavaScript fallbacks with hardcoded 83.5% remain

### Requirement: Level-specific color semantics

L1 session card and L3 turn detail share the same color threshold
(`≥83.5%` red, `≥75%` yellow, else dim) because both measure "session
is near auto-compact — should I act?". L2 turn card uses distinct
thresholds (`>95%` red, `>85%` yellow) because its use case is
per-turn anomaly detection, not decision-making.

#### Scenario: L1 at 84% on active session

- **Given** session `lastReceivedAt` within last hour (recent)
- **And** `latestMainCtxPct = 84`
- **When** session card renders
- **Then** ctx alert badge is red
- **And** ctx bar `.si-ctx-bar` has `.over-compact` class (red fill + red tick)

#### Scenario: L2 at 84% ctx shows no warning

- **Given** a turn card with `ctx:84%`
- **When** rendered
- **Then** `.turn-ctx-pct` has no warning class (dim default)
- **And** the cyan hit-rate label is unchanged
- **Rationale**: per-turn anomaly detection — 84% is normal late-session,
  not a per-turn anomaly

#### Scenario: L2 at 96% ctx shows critical

- **Given** a turn card with `ctx:96%`
- **When** rendered
- **Then** `.turn-ctx-pct` has `.ctx-critical` class (red)

#### Scenario: L3 at 84% on current turn shows red

- **Given** L3 detail for a turn with `usage.sum / maxContext = 84%`
- **When** rendered
- **Then** the big usage bar fill color is red
- **And** consistent with L1's red alert

### Requirement: Recent-gate prevents sea-of-red on historical sessions

L1's red/yellow colors only apply to recent sessions
(`lastReceivedAt` within the last hour). Older sessions render with a
dim-grey palette regardless of their terminal ctx%. The ctx bar remains
visible (informational), but alert badges and urgency colors are
suppressed to prevent the historical session list from becoming a wall
of red.

#### Scenario: Historical session at 95% renders dim

- **Given** session `lastReceivedAt` is 3 days ago
- **And** `latestMainCtxPct = 95`
- **When** card renders
- **Then** ctx alert badge does not use `.ctx-alert-red` class
- **And** alert renders with `.ctx-alert-historical` class (dim grey)
- **And** ctx bar still draws but without `.over-compact` red styling
- **And** cache countdown row is omitted (already handled by Phase 5 info.active)

#### Scenario: Boundary — exactly 1 hour ago

- **Given** session `lastReceivedAt` is 59 minutes 55 seconds ago
- **And** `latestMainCtxPct = 90`
- **When** rendered
- **Then** session is treated as recent, colors apply normally

#### Scenario: Session becomes historical while viewing

- **Given** session rendered as recent at minute 0
- **When** 61 minutes elapse with no new turns
- **Then** on next re-render (triggered by any session update event),
  session is reclassified as historical and colors dim

## REMOVED Requirements

### Requirement: `≈N turns left` 顯示於 session card

**Reason**: 實測 MAPE 87%，末端輕量 turn 場景高估 10x+，會誤導使用者做錯決策（繼續消耗 context 直到 auto-compact）。無修復路徑（任何 past-only estimator 在相位切換時都會錯）。

**Migration**: 使用者改看 ctx % + 83.5% 視覺參考線 + cache countdown。新機制不預測，只呈現事實與常數門檻。
