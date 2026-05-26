## Why

Context % 計算依賴 `extractModelFromSystem` + fallback table 推斷 context window，但 Claude Code 切換 model 時 system prompt 不會更新，導致 opus 切換後 % 膨脹到實際 5 倍（1M 窗口顯示為 200K 基數）。從 request 無法可靠偵測 Max plan 的 1M 模式。最誠實的作法是讓使用者明確告訴 ccxray 自己的 plan——對齊使用者 mental model。

## What Changes

- **Topbar plan 選擇器**：加入下拉選單，三個選項 Auto / Max (1M) / Pro (200K)
- **localStorage 持久化**：使用者偏好存在 client 端，不需 server roundtrip
- **Override 邏輯**：client 端在計算 `ctxMax` 時，若 plan 不是 Auto 且 model 是 opus-4 系列，覆寫 server 端 `maxContext`
- **首次提示**：若 localStorage 無紀錄，topbar 顯示淡化 nudge 建議設定

## Capabilities

### New Capabilities

- `context-plan-preference`: 使用者 plan 偏好設定、持久化、UI 呈現、與 context 計算的整合規則

### Modified Capabilities

（無現有 spec 需要更新）

## Impact

- `public/index.html`：新增 topbar plan 選擇器元素
- `public/app.js` 或新檔 `public/plan-preference.js`：讀寫 localStorage、暴露 `getEffectiveMaxContext(entry)` helper
- `public/entry-rendering.js`：`ctxMax` 計算改用 helper
- `public/style.css`：新 selector 樣式
