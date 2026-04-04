## 1. Hub 核心模組

- [ ] 1.1 建立 `server/hub.js` — lockfile 讀寫（`readHubLock`, `writeHubLock`, `deleteHubLock`），路徑 `~/.ccxray/hub.json`
- [ ] 1.2 實作 hub discovery 邏輯（讀 lockfile → pid check + `/api/health` 雙重驗證 → 判斷 hub/client 模式）
- [ ] 1.3 實作 detached hub process 啟動（`spawn('node', [hubScript], { detached, stdio: [ignore, fd, fd] })`），stdout/stderr 導向 `~/.ccxray/hub.log`
- [ ] 1.4 實作 hub 的 graceful shutdown（SIGTERM handler、刪除 lockfile）
- [ ] 1.5 Lockfile 在 `listen()` 成功後才寫入（readiness signal）
- [ ] 1.6 Lockfile 加入 `version` 欄位，記錄 ccxray 版本

## 2. Client 生命週期

- [ ] 2.1 新增 `/api/register` endpoint — 接收 `{ pid, cwd }`，加入 active clients 列表
- [ ] 2.2 新增 `/api/unregister` endpoint — 接收 `{ pid }`，移除 client
- [ ] 2.3 實作 idle shutdown — client count === 0 → 5 秒 timer → 關閉 hub
- [ ] 2.4 實作 dead client cleanup — 每 30 秒 `process.kill(pid, 0)` 檢查所有 client

## 3. 啟動流程改造

- [ ] 3.1 修改 `server/index.js` — 啟動時先呼叫 hub discovery，決定 hub 或 client 模式
- [ ] 3.2 Hub 模式：維持現有啟動流程 + listen 後寫 lockfile + 啟動 client lifecycle endpoints
- [ ] 3.3 Client 模式：fork hub → poll lockfile 出現（每 200ms，timeout 10 秒）→ POST /api/register → spawn claude → 退出時 POST /api/unregister
- [ ] 3.4 `--port` 明確指定時跳過 hub discovery，走獨立 server 模式
- [ ] 3.5 Client 啟動時 semver 比對（major 拒絕、minor 警告、patch 靜默）
- [ ] 3.6 新增 hubMode（不 suppress console.log，不開 browser，不印互動式 banner）

## 4. LOGS_DIR 遷移

- [ ] 4.1 修改 `server/config.js` — LOGS_DIR 改為 `~/.ccxray/logs/`
- [ ] 4.2 啟動時 migration — 舊路徑有 `index.ndjson` 且新路徑沒有 → 搬移

## 5. 診斷功能

- [ ] 5.1 新增 `/api/health` endpoint — 回傳 `{ ok: true }`
- [ ] 5.2 新增 `/api/status` endpoint — 回傳 hub info + clients 列表
- [ ] 5.3 新增 `ccxray status` CLI 子指令 — 讀 lockfile + 呼叫 `/api/status` + 人類可讀輸出

## 6. Hub crash auto-recovery

- [ ] 6.1 Client 端 hub pid 監控 — 每 5 秒 `process.kill(hubPid, 0)` 檢查 hub 存活
- [ ] 6.2 偵測到 hub 死亡 → 刪除 stale lockfile → fork 新 hub
- [ ] 6.3 Port mutex 防腦裂 — fork 的 hub `listen()` 失敗時（EADDRINUSE）放棄並重新讀 lockfile
- [ ] 6.4 Recovery 時輸出可見訊息（"Hub recovered"）

## 7. Hub log 管理

- [ ] 7.1 Hub 啟動時檢查 `~/.ccxray/hub.log` > 1MB → truncate 到最後 100KB

## 8. 驗證

- [ ] 8.1 單專案場景測試 — 行為不退化，hub 在 claude 退出後 5 秒內自動關閉
- [ ] 8.2 多專案場景測試 — 兩個 `ccxray claude` 共用同一 dashboard，各自退出不影響彼此
- [ ] 8.3 Stale lockfile 測試 — 手動殺 hub pid 後，下一個 ccxray 能偵測並啟動新 hub
- [ ] 8.4 Dead client cleanup 測試 — SIGKILL 一個 client，hub 在 30 秒內清理
- [ ] 8.5 Hub crash recovery 測試 — 殺 hub pid，client 自動恢復，claude 下一次 request 成功
- [ ] 8.6 多 client race recovery 測試 — 殺 hub pid，多個 client 同時偵測，只有一個成功成為新 hub
- [ ] 8.7 Hub readiness 測試 — fork hub 後 claude 不會在 lockfile 出現前啟動
- [ ] 8.8 版本不一致測試 — 修改 lockfile 版本為不同 major，確認拒絕連線
- [ ] 8.9 `--port` 測試 — 帶 `--port` 啟動不參與 hub
- [ ] 8.10 LOGS_DIR migration 測試 — 舊路徑 logs 正確搬移到新路徑
- [ ] 8.11 PID reuse 測試 — lockfile 記錄的 pid 存活但 `/api/health` 失敗時視為 stale
