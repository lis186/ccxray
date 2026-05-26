## Why

雖然 `turn-card-redesign` 改善了資訊層次，但專家評審（Tufte / Few / Ware / Victor）揭露幾個結構性問題：符號氾濫（`● ↵ ⏸ ⚠ ·` 五種 shape 相互競爭 pre-attentive channel）、狀態訊號埋沒（小 dot 無法 peripheral 感知）、紫色模型名浪費最強視覺資源、cache composition 資訊在上一版被意外移除（失去 cost-why 的主要訊號）。此次重設計把 state 編碼到左邊框色條、移除多餘 emoji、重新放回 cache composition bar，並依使用者優先序（turn# / sub / success-fail / context → cost / time / risk / tools）重整版位。

## What Changes

- **左邊框色條取代 status dot**：整張卡左側 2px 高度色條編碼最嚴重狀態（紅/橙/黃/無），取代既有 `.status-dot`。Peripheral vision 可感知
- **風險 inline markers 取代 ⚠ badges**：`⚠ tool-fail` → `✗tool`、`⚠ dupes` → `⟳Name×N`、`⚠ cred` → `🔑cred`、`⚠ max_tokens` → `✂max`；全部移入 secondary line，刪除獨立 risk line
- **Cache composition bar 放回 secondary line**：3 色 inline bar（cache-read 綠 / cache-write 橘 / input 黃，約 8 chars 寬）+ `NN%c` cache hit 文字標，緊鄰 cost 顯示
- **Context % 右上單獨顯示**：大字、按嚴重度變色（灰 / 黃 > 70% / 紅 > 95%）
- **移除分隔符 `·`**：改 flexbox gap 與欄位對齊
- **模型名 dim + session 內省略**：連續同 model 時省略顯示；model 變動時才重現
- **移除 `compactBadge`、`inferredBadge`、綠 dot**：compact/inferred 僅存 tooltip；成功狀態無 dot（無色條）
- **三層壓縮為三行**：line1 identity+ctx%、line2 title、line3 time+composition+tools+cost
- **BREAKING**：移除 `.turn-identity` 內的 `.status-dot`、`.turn-risk` layer、`.turn-meta`；新增 `.turn-left-bar`、`.turn-composition`、`.inline-marker`

## Capabilities

### New Capabilities

- `turn-card-v2`: 第二版 turn card 視覺規格，涵蓋左邊框色條、inline markers、cache composition、model 省略規則

### Modified Capabilities

- `turn-card-display`: 整體重構，layer 從五層變三行；原五層 spec 中的 risk line / status dot 需求移除或重新定義

## Impact

- `public/entry-rendering.js`：重寫 turn card HTML 建構（縮小 ~40 行）
- `public/style.css`：新增 left-bar / composition / inline-marker styles，移除 risk-layer / status-dot
- `openspec/specs/` — 未來 archive 時需合併 turn-card-display spec 的 delta
- 無 server 端變更，既有 `toolFail` / `duplicateToolCalls` / `hasCredential` / `stopReason` 欄位已足夠
- Client 舊資料相容：同前
