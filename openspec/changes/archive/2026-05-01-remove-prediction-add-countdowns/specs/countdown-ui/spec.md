# Countdown UI Capability

## ADDED Requirements

### Requirement: Cache TTL Countdown 顯示於 active session card

Session card 底部顯示 cache 到期倒數，僅對 active session 啟用動態更新。

文字格式（shipped）：
- `s >= 60`：`cache Nm left`（N = `Math.ceil(s / 60)`）
- `s < 60`：`cache Ns left`
- `remaining <= 0`：`cache expired`（靜態，ticker 停止觸碰）

> **格式 drift（earlier draft → shipped）：** 早期草案使用 `cache M:SS ⏱` 格式（含 ⏱ emoji）。Shipped UI 改成純文字 `cache Nm left` / `cache Ns left`，理由：(1) 與其他 dim secondary text 視覺一致、不引入新符號競爭 pre-attentive channel；(2) ⏱ 在 `turn-card-v2-expert-redesign` 提倡的「無 emoji」原則下不應出現於 session card；(3) `Nm` 比 `M:SS` 在 Pro 5min vs Max 1hr 兩種 TTL 下都易讀。

色彩 class 由同一元素承載（不額外加 leading dot）：
- `pct > 0.6` → `.cache-far`（綠）
- `pct > 0.3` 且 `<= 0.6` → `.cache-near`（黃）
- `pct <= 0.3` → `.cache-close`（紅 + pulse）
- `remaining <= 0` → `.cache-expired`（終態）

> **Threshold drift：** 早期草案要求絕對 `> 300s` / `> 60s` 切 tier。Shipped 改用 `pct > 0.6` / `> 0.3`，讓同一邏輯同時適用 Pro 5min 與 Max 1hr，無需 per-plan 分支。功能近似但不完全等價：例如 Pro 5min 下 `0.6 * 300 = 180s` 才從 far → near（草案是 300s）；Max 1hr 下 `0.6 * 3600 = 2160s = 36min` 切換點。

#### Scenario: 一般 active session 顯示倒數

- **Given** session 最後一輪 response 在 30 秒前完成
- **And** 計費方案為 Pro（TTL 5 分鐘 = 300000 ms）
- **When** dashboard 渲染該 session card
- **Then** `.si-cache` 元素文字為 `cache 5m left`（`Math.ceil(270/60) = 5`）
- **And** className 為 `si-cache cache-far`（pct = 270/300 = 0.9 > 0.6）
- **And** card 有 `data-active="1"` 屬性

#### Scenario: Cache 進入最後 60 秒

- **Given** cache 剩餘 45 秒
- **When** ticker 執行
- **Then** 文字顯示 `cache 45s left`
- **And** 套用 `.cache-close` CSS class（紅 + pulse）

#### Scenario: Cache 已過期

- **Given** session 最後一輪在 TTL 之前
- **When** dashboard 渲染或 ticker 執行
- **Then** 顯示 `cache expired` 靜態文字
- **And** className 為 `si-cache cache-expired`
- **And** `data-active` 設為 `"0"`，ticker 不再更新此元素

### Requirement: Ticker DOM-write throttling

單一 app-level `setInterval(1000)` 在 `public/countdown-ticker.js` 驅動所有 `.si-cache[data-active="1"]` 元素。每次 tick 計算當下文字與 className，僅在值改變時寫回 DOM（textContent 與 className 各自比對）。沒有「依時間分層的 update 頻率」邏輯——所有 active 元素皆 1s 評估一次，但 DOM write 自然受文字內容變化頻率調節。

> **Drift from earlier draft：** 早期草案規定「TTL > 5min 每 10s 才改文字」「1–5min 每秒更新」分層 ticker。Shipped 改為單一 1s ticker + textContent 比對：`cache Nm left` 因為 `Math.ceil(s/60)` 在分鐘邊界才變值，自然每分鐘只 write 一次；`cache Ns left` 階段每秒值都不同所以每秒 write。等價於原規範的分層效果，但實作更簡單。

#### Scenario: 分鐘格式期間 DOM-write 頻率

- **Given** cache 剩餘 12 分鐘 30 秒
- **When** ticker 連續執行 60 次（60 秒）
- **Then** `_formatCountdown` 被呼叫 60 次
- **AND** `el.textContent` 只在分鐘邊界才改變（從 `cache 13m left` 到 `cache 12m left`，因 `Math.ceil(s/60)` 邊界）
- **AND** 1 分鐘內 textContent 寫入次數 ≤ 1

#### Scenario: 秒格式期間每秒更新

- **Given** cache `remaining` 為 44500ms（剛跨入 44 秒邊界）
- **When** ticker 執行
- **Then** 文字渲染為 `cache 45s left`（`Math.ceil(44500 / 1000) = 45`）
- **And** 1 秒後 `remaining = 43500ms`，文字渲染為 `cache 44s left`
- **And** 秒格式期間每次 tick textContent 必不同（與分鐘格式 scenario 對比，分鐘格式只在邊界改動）

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

`CCXRAY_PLAN` env 接受四個 plan id：`pro`、`max5x`、`max20x`、`api-key`（皆 case-insensitive）。每個 id 對應 `PLAN_CONFIG`（`server/plans.js`）中的一個項目，提供 `label`、`cacheTtlMs`、`tokens5h`、`monthlyUSD`。未知值 fallback 至 `api-key`（最保守）。Topbar 透過 `/_api/settings` 取得 label 與 TTL，以 `Plan: {label} · TTL {h|m}{source-badge}` 格式顯示。

> **Drift from earlier draft：** 早期草案使用 `CCXRAY_PLAN=max` 與 `PLAN_LABEL = 'Max'`。Shipped code 不接受 plain `max`——必須明確指定 `max5x` 或 `max20x`，因為兩者 monthlyUSD（100 vs 200）影響 ROI 計算，無 plain 'Max' 別名以避免歧義。

#### Scenario: 預設方案為保守

- **Given** 啟動時無 `CCXRAY_PLAN` env var
- **And** auto-detection 樣本不足
- **When** `getEffectivePlan()` 被呼叫
- **Then** 回傳 `{ plan: 'api-key', source: 'default', confidence: 'insufficient' }`
- **And** `getPlanConfig('api-key').label = 'API key'`
- **And** `cacheTtlMs = 300_000`（5 分鐘）
- **And** topbar 顯示 `Plan: API key · TTL 5m (detecting…)`

#### Scenario: Max 5x 方案

- **Given** `CCXRAY_PLAN=max5x` 啟動
- **When** `getEffectivePlan()` 被呼叫
- **Then** 回傳 `{ plan: 'max5x', source: 'env', confidence: 'high' }`
- **And** `getPlanConfig('max5x').label = 'Max 5x'`
- **And** `cacheTtlMs = 3_600_000`（1 小時）
- **And** topbar 顯示 `Plan: Max 5x · TTL 1h (env)`

#### Scenario: Max 20x 方案

- **Given** `CCXRAY_PLAN=max20x` 啟動
- **When** topbar 渲染
- **Then** 顯示 `Plan: Max 20x · TTL 1h (env)`

#### Scenario: 未知值 fallback

- **Given** `CCXRAY_PLAN=max`（plain `max` 未定義，需明確 max5x 或 max20x）或 `CCXRAY_PLAN=enterprise`
- **When** `getEffectivePlan()` 被呼叫
- **Then** `isKnownPlan` 回傳 false
- **And** 跳過 env 路徑，落入 auto-detect 或 default
- **And** 最終可能 fallback 至 `api-key`

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
