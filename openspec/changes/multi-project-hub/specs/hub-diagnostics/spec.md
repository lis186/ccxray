## ADDED Requirements

### Requirement: Health endpoint
Hub SHALL 提供 `GET /api/health` endpoint，回傳 200 和 `{ "ok": true }`。

#### Scenario: Health check
- **WHEN** 任何 client 發送 `GET /api/health`
- **THEN** hub SHALL 回傳 `200 { "ok": true }`

### Requirement: Status endpoint
Hub SHALL 提供 `GET /api/status` endpoint，回傳 hub 資訊和已連線的 clients 列表。

#### Scenario: Query hub status
- **WHEN** 發送 `GET /api/status`
- **THEN** hub SHALL 回傳：
  - `port`: hub 監聽的 port
  - `pid`: hub 的 process ID
  - `uptime`: hub 已運行時間（秒）
  - `clients`: 陣列，每個元素包含 `{ pid, cwd, connectedAt }`

### Requirement: Status CLI command
ccxray SHALL 支援 `ccxray status` 子指令，以人類可讀格式顯示 hub 狀態。

#### Scenario: Hub is running with clients
- **WHEN** 使用者執行 `ccxray status` 且 hub 正在運行
- **THEN** SHALL 輸出 hub 的 port、pid、uptime，以及每個已連線 client 的 pid 和 cwd

#### Scenario: No hub running
- **WHEN** 使用者執行 `ccxray status` 且無 hub 運行
- **THEN** SHALL 輸出 "No hub running"
