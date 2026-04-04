## Why

同時在多個專案使用 `npx ccxray claude` 時，每個專案會啟動獨立的 HTTP server 佔用不同 port（5577, 5578, 5579...），導致 dashboard 散落各處、無法統一查看所有專案的 API 呼叫。這與 ccxray 的核心價值「零設定、透明觀測」矛盾 — 使用者不應該需要記住哪個 port 對應哪個專案。

## What Changes

- 引入 **Lazy Hub 架構**：第一個 `ccxray claude` 自動啟動背景 hub server，後續的 `ccxray claude` 偵測到 hub 後直接共用
- 新增 **hub discovery 機制**：透過 `~/.ccxray/hub.json` lockfile 紀錄 hub 的 port 和 pid
- 新增 **client 生命週期管理**：hub 追蹤已連線的 claude 實例數量，全部退出後 idle 5 秒自動關閉
- 新增 `ccxray status` 指令：顯示 hub 狀態和已連線的 claude 實例
- 新增 `/api/health` 和 `/api/status` REST endpoints

## Capabilities

### New Capabilities

- `hub-lifecycle`: Hub process 的啟動、discovery、client 註冊/反註冊、idle shutdown 機制
- `hub-diagnostics`: `ccxray status` CLI 指令和 `/api/health`、`/api/status` endpoints

### Modified Capabilities

（無既有 spec 需要修改 — 現有的 proxy、dashboard、session tracking 邏輯不變）

## Impact

- **server/index.js**: 啟動流程改動最大 — 從「直接啟動 server」變成「先 discover hub → 決定啟動模式」
- **新增 server/hub.js**: Hub lockfile 讀寫、discovery、detached process 管理
- **新增 server/routes/hub.js**: `/api/health`、`/api/status`、`/api/register`、`/api/unregister` endpoints
- **bin/ccxray 或 CLI entry**: 新增 `status` 子指令
- **外部依賴**: 無新增依賴
- **向後相容**: 單專案使用時行為幾乎不變（唯一差異：hub 在 claude 退出後延遲 5 秒關閉）
