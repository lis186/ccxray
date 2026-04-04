## ADDED Requirements

### Requirement: Hub auto-discovery on startup
ccxray 啟動時 SHALL 讀取 `~/.ccxray/hub.json` 來偵測是否有 hub 正在運行。若 lockfile 存在且 pid 存活，SHALL 進入 client 模式；否則 SHALL 啟動新的 hub。

#### Scenario: No existing hub
- **WHEN** `~/.ccxray/hub.json` 不存在
- **THEN** ccxray SHALL fork 一個 detached hub process，寫入 lockfile，然後以 hub 的 port 作為 `ANTHROPIC_BASE_URL` spawn claude

#### Scenario: Hub already running
- **WHEN** `~/.ccxray/hub.json` 存在且記錄的 pid 仍存活
- **THEN** ccxray SHALL 跳過 server 啟動，直接以 lockfile 中的 port 作為 `ANTHROPIC_BASE_URL` spawn claude

#### Scenario: Stale lockfile (hub crashed)
- **WHEN** `~/.ccxray/hub.json` 存在但記錄的 pid 已不存活
- **THEN** ccxray SHALL 刪除 stale lockfile 並啟動新的 hub

### Requirement: Hub runs as detached process
Hub server SHALL 以 detached child process 啟動，不綁定任何 claude 實例的生命週期。Hub process 退出時 SHALL 刪除 `~/.ccxray/hub.json`。

#### Scenario: First claude exits, second still running
- **WHEN** 兩個 claude 實例連接到同一個 hub，第一個退出
- **THEN** hub SHALL 繼續運行，第二個 claude 不受影響

#### Scenario: Hub process receives SIGTERM
- **WHEN** hub process 收到 SIGTERM
- **THEN** hub SHALL 刪除 lockfile 並 gracefully shutdown

### Requirement: Client registration
每個 ccxray client SHALL 在 spawn claude 前向 hub 註冊（`POST /api/register`），並在 claude 退出後反註冊（`POST /api/unregister`）。

#### Scenario: Client registers successfully
- **WHEN** ccxray client 發送 `POST /api/register` with `{ pid, cwd }`
- **THEN** hub SHALL 將 client 加入 active clients 列表並回傳 200

#### Scenario: Client unregisters on claude exit
- **WHEN** claude process 退出
- **THEN** ccxray client SHALL 發送 `POST /api/unregister` with `{ pid }` 然後自己退出

### Requirement: Idle shutdown
Hub SHALL 在 active clients 數量降為 0 後啟動 5 秒 idle timer。Timer 到期時 hub SHALL 自動關閉並刪除 lockfile。

#### Scenario: Last claude exits
- **WHEN** 最後一個 claude 實例退出，active clients 降為 0
- **THEN** hub SHALL 在 5 秒後自動關閉

#### Scenario: New client connects during idle timer
- **WHEN** idle timer 正在倒數，一個新的 ccxray client 註冊
- **THEN** hub SHALL 取消 idle timer 並繼續運行

### Requirement: Dead client cleanup
Hub SHALL 每 30 秒檢查所有已註冊 client 的 pid 是否存活（`process.kill(pid, 0)`）。不存活的 client SHALL 被移除。

#### Scenario: Client killed with SIGKILL
- **WHEN** 一個已註冊的 client process 被 SIGKILL（無法執行 unregister）
- **THEN** hub SHALL 在下一次 health check 時偵測到並移除該 client

### Requirement: Hub crash auto-recovery
每個 client SHALL 每 5 秒檢查 hub pid 是否存活。偵測到 hub 死亡時，client SHALL 自動嘗試啟動新 hub。用 port 作為天然 mutex 防止多個 client 同時成為 hub。

#### Scenario: Hub crashes, single client recovers
- **WHEN** hub process 意外終止，且只有一個 client 在運行
- **THEN** client SHALL 在 5 秒內偵測到，刪除 stale lockfile，fork 新 hub，claude 的下一次 API request 即恢復

#### Scenario: Hub crashes, multiple clients race
- **WHEN** hub process 意外終止，且多個 client 同時偵測到
- **THEN** 每個 client SHALL 嘗試 fork 新 hub，只有一個能成功 `listen()` 在目標 port，其他收到 EADDRINUSE 後 SHALL 放棄並重新讀取 lockfile 進入 client 模式

#### Scenario: Recovery notification
- **WHEN** client 成功恢復 hub
- **THEN** client SHALL 輸出可見訊息告知使用者 hub 已恢復

### Requirement: Hub log file
Hub process 的 stdout 和 stderr SHALL 導向 `~/.ccxray/hub.log`（append 模式），而非 `stdio: 'ignore'`。Hub 啟動時若 log file > 1MB SHALL truncate 到最後 100KB。

#### Scenario: Hub crashes on startup
- **WHEN** hub 啟動即失敗（例如 port 被非 ccxray 程式佔用）
- **THEN** 錯誤訊息 SHALL 被寫入 `~/.ccxray/hub.log`，使用者可透過 `ccxray status` 或直接查看此檔案診斷

#### Scenario: Hub log rotation
- **WHEN** hub 啟動時 `~/.ccxray/hub.log` > 1MB
- **THEN** hub SHALL truncate 到最後 100KB 後再開始寫入

### Requirement: Fixed LOGS_DIR
LOGS_DIR SHALL 為 `~/.ccxray/logs/`，不依賴 `__dirname` 或 npx cache 路徑。啟動時若舊路徑（`__dirname/../logs/`）存在 `index.ndjson`，SHALL 一次性搬移到新路徑。

#### Scenario: Fresh install
- **WHEN** `~/.ccxray/logs/` 不存在
- **THEN** ccxray SHALL 建立該目錄並在其中寫入 logs

#### Scenario: Upgrade from old LOGS_DIR
- **WHEN** 舊路徑 `__dirname/../logs/index.ndjson` 存在且 `~/.ccxray/logs/index.ndjson` 不存在
- **THEN** ccxray SHALL 將舊路徑的 logs 搬移到 `~/.ccxray/logs/`

#### Scenario: Hub recovery reads correct logs
- **WHEN** hub crash 後由不同 client fork 新 hub（可能有不同 `__dirname`）
- **THEN** 新 hub SHALL 從 `~/.ccxray/logs/` 讀取所有歷史 logs

### Requirement: Version compatibility check
Hub lockfile SHALL 記錄 hub 的 ccxray 版本。Client 啟動時 SHALL 比對自身版本與 hub 版本。

#### Scenario: Same major version
- **WHEN** client 版本 1.2.0 連線至 hub 版本 1.1.0
- **THEN** client SHALL 輸出警告並以 client 模式正常連線

#### Scenario: Different major version
- **WHEN** client 版本 2.0.0 連線至 hub 版本 1.x.x
- **THEN** client SHALL 拒絕連線並輸出 "Hub (v1.x) is incompatible. Close all ccxray instances and restart."

#### Scenario: Same version
- **WHEN** client 與 hub 版本完全一致
- **THEN** client SHALL 靜默以 client 模式連線

### Requirement: Hub readiness signal
Hub SHALL 在 `listen()` 成功後才寫入 lockfile。Client fork hub 後 SHALL poll lockfile 存在性（每 200ms），lockfile 出現才 spawn claude。Timeout 10 秒後 SHALL 報錯。

#### Scenario: Normal startup
- **WHEN** client fork hub，hub 在 3 秒內 listen 成功並寫入 lockfile
- **THEN** client SHALL 偵測到 lockfile 出現並 spawn claude

#### Scenario: Hub startup timeout
- **WHEN** client fork hub，10 秒內 lockfile 未出現
- **THEN** client SHALL 報錯並提示查看 `~/.ccxray/hub.log`

### Requirement: Explicit port opts out of hub mode
帶 `--port` 啟動時 SHALL 跳過 hub discovery，以獨立 server 模式運行（現有行為）。不帶 `--port` 時 SHALL 進入 hub 模式。

#### Scenario: User specifies --port
- **WHEN** 使用者執行 `ccxray --port 8080 claude`
- **THEN** ccxray SHALL 啟動獨立 server on 8080，不參與 hub

#### Scenario: User does not specify --port
- **WHEN** 使用者執行 `ccxray claude`
- **THEN** ccxray SHALL 進入 hub discovery 流程

### Requirement: PID reuse protection
Hub discovery SHALL 用 `process.kill(pid, 0)` + `GET /api/health` 雙重驗證。兩個都通過才認定 hub 存活。

#### Scenario: PID reused by unrelated process
- **WHEN** lockfile 記錄的 pid 被 OS 分配給非 ccxray process
- **THEN** pid check 通過但 `/api/health` 失敗（或回傳非預期格式），ccxray SHALL 視為 stale 並啟動新 hub
