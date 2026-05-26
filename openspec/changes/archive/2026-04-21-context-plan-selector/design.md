## Context

Claude Code 允許使用者透過 `/model` 切換 model。切換後：
- `parsedBody.model` 更新為新 model
- system prompt **不更新**（仍指向 session 開始時的 model）
- `[1m]` 標記只在 session 一開始就是 opus Max 時才會出現在 system prompt

結果：對於 Max plan 使用者，從 sonnet/haiku 切到 opus 後，opus turn 的 context % 用 200K 基數計算，實際應為 1M。

從 request 本身**無法可靠區分**Max 與 Pro 用戶。但使用者自己清楚——這是 Don Norman 說的「對齊 user's mental model」，設計上直接問使用者最誠實。

## Goals / Non-Goals

**Goals:**
- 讓使用者一次性設定 plan，之後所有 turn 的 % 都用正確基數計算
- 設定完全在 client，不污染 server 資料格式
- 預設 Auto 模式，保留現有行為（無感升級）

**Non-Goals:**
- 不改 server 端 `getMaxContext` 邏輯
- 不儲存到 `~/.ccxray` 磁碟，僅 localStorage（跨瀏覽器不同步沒關係）
- 不處理 sonnet / haiku 的 plan 差異（兩者在所有 plan 下都是 200K）

## Decisions

### 1. 只覆寫 opus-4 系列

Plan 差異僅影響 opus-4（Pro/API = 200K, Max = 1M）。sonnet 和 haiku 不受影響，維持現有計算。Override 邏輯只在 model 以 `claude-opus-4` 開頭時生效。

### 2. Client 端 override，不動 server

在 `entry-rendering.js` 計算 `ctxMax` 處加一層 helper：

```js
function getEffectiveMaxContext(entry) {
  const plan = localStorage.getItem('ccxray.plan') || 'auto';
  const model = entry.model || '';
  if (plan === 'max' && model.startsWith('claude-opus-4')) return 1_000_000;
  if (plan === 'pro' && model.startsWith('claude-opus-4')) return 200_000;
  return entry.maxContext || DEFAULT_MAX_CTX;
}
```

### 3. Topbar UI 元素

選擇器放在 quota-ticker 附近（已有 topbar），用 `<select>` 元素。變更時觸發全域重 render：重新計算所有 turn 的 context bar。

### 4. 首次 nudge

若 localStorage 無 `ccxray.plan` key，選擇器旁顯示 `(set plan for accurate %)` 淡字提示。點擊後消失。

## Risks / Trade-offs

- **Re-render 成本**：切換 plan 需重跑所有可見 turn 的 context bar render。在 1000+ turn 的 session 可能短暫 lag；可接受，切換是低頻操作
- **新使用者 UX**：Auto 模式下 Max 用戶仍會看到錯誤 %，直到手動設定。Nudge 降低這個風險但無法消除
- **跨裝置不同步**：localStorage 是 per-browser，使用者在不同機器開 ccxray 要重設一次。不是大問題（每台機器設一次）
