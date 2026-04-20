# Replace `turns-left` prediction with event-driven countdowns

> Supersedes [`fix-turns-left-prediction`](../fix-turns-left-prediction/proposal.md).
> 前一版提案想「修」 predictor；本版基於實測決定「移除」 predictor 並加兩個不需要預測的資訊欄位。

## Why

### 前一版提案的核心假設失敗

原 [`fix-turns-left-prediction`](../fix-turns-left-prediction/proposal.md) 提案嘗試用 robust statistic（trimmed median、Theil-Sen）改進預測精度。**實測證明這條路走不通**：

| 演算法 | Mean MAPE | Median MAPE | Within 30% |
|---|---|---|---|
| Current（5-turn mean of `tokens.messages` delta） | **87%** | 43% | 42% |
| 改 Theil-Sen on total | **135%** | 56% | 21% |
| 改三估計器 ratio-based | 未跑（預期類似） | — | — |

**結論**：Session 有相位變化（早期 file read 重、中期 tool use 重、末期輕量確認），任何「只看過去」的估計器在相位切換時都會錯。點估計準確度 <20% 不可能達成。

### 同時發現原 bug 是複合問題

| 元素 | 是否真的錯 |
|---|---|
| ccxray dashboard 顯示的 `ctx 83%` | ✅ **正確**（早已用 `usage.sum / maxContext`）|
| Predictor 顯示的 `≈367 turns left` | ❌ 5-turn mean of `tokens.messages` delta，容易被末端輕量 turn 打歪 |
| 使用者困惑 | ✅ 來自「ctx 83%」與「還 367 turn」兩個訊息**互相矛盾** |

**修掉 predictor，原 bug 的 user-facing 痛點就消失。**

### 使用者真正需要的是可行動的 countdown，不是預測數字

經實測 + reframe 確認使用者的 peripheral awareness 看的是：

1. **還多久 auto-compact**（~83.5% context 觸發）→ 決定「要不要手動 `/compact` / wrap up」
2. **Cache 還多久失效**（Pro 5m / Max 1h）→ 決定「現在繼續還是接受 cold start」

這兩個都是**事件導向、不需要預測演算法**：
- Auto-compact 門檻是 Claude Code 的**已知常數**（83.5%）
- Cache TTL 是**純時鐘減法**

## What Changes

### Removed Capabilities

- **`turns-left-prediction`** — 徹底移除 `predictRemainingTurns` 與其 UI。
  - 刪 `public/miller-columns.js:654-687`（演算法）
  - 刪 `public/miller-columns.js:726-731`（`renderPredictionRow` 與其呼叫處）
  - CHANGELOG 註明移除原因：實測 MAPE 87% 會誤導使用者

### New Capabilities

- **`cache-ttl-countdown`** — Session card 底部動態顯示 cache 到期倒數
  - 來源：`lastReceivedAt + planTtl - now`
  - Active 判定：`(now - lastReceivedAt) < TTL`
  - 分層節流：`>5m` 每 10s / `1–5m` 每 1s / `<1m` 每 1s + 紅色
  - Dormant 恢復：間隔 > TTL 時先顯示 `cache rebuilding`，首輪 response 若有高 `cache_creation` → 確認冷啟動

- **`auto-compact-reference-line`** — Ctx bar 上靜態標示 83.5% 觸發線
  - 純視覺標記，無預測
  - Tooltip：`auto-compact triggers at ~83.5%`
  - 當 `ctxPct > 83.5%` 時線色切紅

- **`plan-auto-detect`** — 從 response usage 的 `cache_creation.ephemeral_5m/1h_input_tokens` 自動推論 plan（零配置）
  - `ephemeral_1h > 0` 出現 → Max（預設歸為 Max 5x）
  - 全 `ephemeral_5m > 0` → Pro
  - 資料不足 → fallback 到 api-key（保守）
  - `CCXRAY_PLAN=pro|max5x|max20x|api-key` env var 可覆寫

- **`plan-aware-quota-panel`** — 既有 quota panel（cost-budget、quota-ticker）改讀 plan config
  - `server/cost-budget.js` 的硬編 `TOKEN_LIMIT = 220_000`（Max 20x 值）改用 `PLAN_CONFIG[plan].tokens5h`
  - `SUBSCRIPTION_USD = 200`（Max 20x 值）改用 `PLAN_CONFIG[plan].monthlyUSD`
  - 修正 Max 5x 使用者 ROI badge 被低估 50% 的 bug
  - Live rate limit headers 仍優先於 fallback

- **`cache-expiration-notification-layered`** — Cache 快過期時的警示，分兩層：
  - **Layer 1（所有方案，passive）**：tab title flash + session card border 閃爍，零 permission
  - **Layer 2（plan-gated）**：browser notification；Max 預設 on（5 分鐘 lead time）、Pro/api-key 預設 off（opt-in 後 60s lead time）
  - 同 cache cycle 不重複通知
  - `CCXRAY_CACHE_NOTIFY=on|off` env 覆寫
  - Permission denied → 靜默 fallback 到 Layer 1

- **`cross-level-context-vocabulary`** — 三層 context 視覺化（session card / turn card / turn detail）共用 `~83.5%` auto-compact landmark via CSS custom property；L1/L3 共用 color threshold（決策信號），L2 保留獨立 threshold（per-turn 異常偵測）；L1 加 recent-gate 避免歷史 session 全紅

- **`cache-ttl-silent-regression-detection`**（bonus，P2） — 被動偵測 Anthropic 實際 TTL 行為與設定不符
  - 觀察連續兩 turn 間隔 > 5m 且 `cache_read ≈ 0` + `cache_creation 大增`
  - 排除 `/compact` `/clear` 等使用者行為
  - 累計 3 次才警示；24h cooldown

### Modified Capabilities

- **視覺 hygiene**：所有 `⚠` Unicode 字元 → inline SVG（避免 font fallback）
- **註解**：`isSubagent` filter 處加註解說明為何排除

## Impact

### Files

| 檔案 | 變更 |
|---|---|
| `public/miller-columns.js` | 刪 `predictRemainingTurns` + `renderPredictionRow` |
| `public/entry-rendering.js` | Session card render 加 cache countdown + auto-compact ref line |
| `public/style.css` | `.cache-countdown`、`.auto-compact-ref`、`.warn-icon` 新樣式 |
| `public/app.js`（或新檔 `public/countdown-ticker.js`） | 單一 app-level `setInterval` + active session 節流 |
| `public/messages.js` | Ctx bar visualization 加 83.5% 參考線 |
| `server/config.js` | 讀 `CCXRAY_PLAN`、`CCXRAY_CACHE_NOTIFY` env |
| `server/plans.js` | 🆕 `PLAN_CONFIG` 中央表（pro/max5x/max20x/api-key × tokens5h/monthlyUSD/cacheTtlMs）|
| `server/plan-detector.js` | 🆕 `detectPlan()` + `getEffectivePlan()` |
| `server/cost-budget.js` | `TOKEN_LIMIT` 與 `SUBSCRIPTION_USD` 改讀 plan config |
| `server/forward.js` | 補 `anthropic-ratelimit-*` headers 持久化（供未來校準 5x vs 20x）|
| `server/routes/api.js` | 🆕 `/_api/settings` endpoint |
| `server/sse-broadcast.js` | 🆕 `settings_changed` SSE 事件 |
| `public/quota-ticker.js` | ROI 計算改讀 settings.monthlyUSD |
| `public/cost-budget-ui.js` | Zone 1 fallback 改讀 settings |
| `public/cache-notify.js` | 🆕 Layer 2 active notification |
| `public/entry-rendering.js` | L2 turn-ctx-bar 加 83.5% tick + 註解保留 85/95 threshold 的設計理由 |
| `public/messages.js` | L3 minimap 加 83.5% tick element |
| `public/settings.js` | 載入後設定 `--compact-threshold` CSS 變數於 `:root` |
| `CHANGELOG.md` | 記錄移除 + 新增 |

### Backwards compatibility

- **Breaking**：`≈N turns left` 欄位消失。未有 deprecation 期（其數字從未可信）。
- Release note 需顯著標示 + 解釋原因。
- localStorage/env 預設值不變（Pro/api-key → 5m TTL，最保守）。

### 與其他 changes 的關係

- **依賴**：[`context-plan-selector`](../context-plan-selector/proposal.md)（如已 merge）已處理 opus 1M vs 200K 判定。本 change 的 `cache-ttl-plan-config` 是**不同層次的** plan 設定（計費口徑 vs context window），但 UI 可能共用同一個 topbar selector。
  - 建議：本 change 用獨立 env var `CCXRAY_PLAN`，**不與** `context-plan-selector` 的 localStorage 混用；之後若 UI 統一再合併。

## Release timing

v1.6.0 已發布。本 change 是 v1.7.0 的主要內容（含 breaking: 移除 turns-left）。
