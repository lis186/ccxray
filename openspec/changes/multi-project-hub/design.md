## Context

ccxray 是 Claude Code 的透明 HTTP proxy，目前每次 `ccxray claude` 啟動都會建立獨立的 HTTP server。多專案同時使用時，dashboard 散落在不同 port，使用者需要自己管理。

現有啟動流程（`server/index.js`）：
1. `config.storage.init()` → `fetchPricing()` → `restoreFromLogs()`
2. `tryListen(server, config.PORT, maxAttempts)` — claudeMode 下會自動 +1 重試最多 10 次
3. `spawnClaude(actualPort, claudeArgs)` — 設定 `ANTHROPIC_BASE_URL` 並 spawn claude
4. Claude 退出時 `server.close()` → `process.exit()`

Session/project 分群已在 `server/store.js` 實作，不同 claude 實例天然使用不同 session ID，dashboard 的 Miller column 能正確分群。

## Goals / Non-Goals

**Goals:**
- 多個 `ccxray claude` 共用同一個 proxy server 和 dashboard
- 指令完全不變（zero-config）
- 單專案體驗不退化
- Hub 生命週期自動管理（無需手動啟動/關閉）

**Non-Goals:**
- 跨機器的 hub discovery（只處理 localhost）
- Hub 的認證/授權（本機開發工具，不需要）
- Dashboard UI 改動（現有 project/session 分群已足夠）
- 多 hub 共存（一台機器只有一個 hub）

## Decisions

### D1: Hub 是 detached background process

Hub server 以 `spawn('node', [hubScript], { detached: true, stdio: 'ignore' })` 啟動，不綁定任何 claude 實例的生命週期。

**替代方案**：Hub 綁定第一個 claude → 被否決，因為第一個 claude 退出會殺死所有人的 dashboard。

### D2: 用 lockfile 做 discovery，不用 port probe

Hub 啟動後寫 `~/.ccxray/hub.json`：
```json
{ "port": 5577, "pid": 12345, "startedAt": "2026-04-05T..." }
```

後續的 ccxray 讀這個檔案找 hub，而不是嘗試連 localhost:5577。

**理由**：
- Port probe 無法區分 ccxray 和其他程式佔用同一 port
- Lockfile 可以攜帶 pid，用於 stale detection
- 支援 `--port` 自訂 port 的場景

### D3: Client 計數 + idle shutdown

Hub 維護 `activeClients` 計數：
- `POST /api/register` → count++
- `POST /api/unregister` → count--（claude 退出時由 client process 呼叫）
- 備援：Hub 定期檢查已註冊 pid 是否存活（`process.kill(pid, 0)`）
- count === 0 → 啟動 5 秒 idle timer → timeout 後 hub 自動關閉並刪除 lockfile

**為什麼 5 秒**：足夠短讓單專案場景「感覺」像同步退出；足夠長容忍「關一個馬上開另一個」的場景。

### D4: Client 模式只 spawn claude，不啟動 server

偵測到 hub 存在時，ccxray 不啟動自己的 HTTP server，只做：
1. `POST /api/register` 註冊自己
2. `spawn claude` with `ANTHROPIC_BASE_URL` 指向 hub
3. Claude 退出時 `POST /api/unregister`

**理由**：避免 port 消耗，避免多 server 的記憶體開銷。

### D5: Hub script 用絕對路徑解析

`npx ccxray` 會在暫存的 node_modules 裡執行。Hub process 用 `path.resolve(__dirname, 'index.js')` 取得絕對路徑，確保 detach 後仍能找到 module。

### D6: Hub crash auto-recovery（pid 偵測 + port mutex）

Hub crash 時 blast radius = N（所有 claude 實例斷線）。Client process 負責偵測並自動恢復：

1. 每個 client 每 5 秒 `process.kill(hubPid, 0)` 檢查 hub 存活
2. 偵測到 hub 死亡 → 刪除 stale lockfile → fork 新 hub
3. **用 port 當天然 mutex 防止腦裂**：多個 client 同時偵測到 hub 死亡時，只有一個能成功 `listen()` 在目標 port，其他會收到 `EADDRINUSE` 並放棄
4. 失敗的 client 等 5 秒後重新讀 lockfile，確認新 hub 存活 → 重新進入 client 模式

**替代方案分析**（8 個方案，按 6 項標準評分，滿分 10）：
- 不管 = 5 分（無自動恢復，blast radius 由 1 → N 是退步）
- Leader election / flock = 7 分（跨平台問題，over-engineered）
- SO_REUSEPORT = 6 分（資料不共享，沒解決單一 dashboard 問題）
- Foreground hub = 5 分（使用者關 terminal 全斷，無自動恢復）
- Aggregator 架構 = 9 分（crash 隔離完美，但需要額外指令啟動 dashboard）
- **pid + port mutex = 10 分**（自動恢復 < 10 秒，port 天然防腦裂，~60 行實作）

### D8: LOGS_DIR 改為固定路徑 `~/.ccxray/logs/`

現有 `LOGS_DIR = path.join(__dirname, '..', 'logs')` 會跟著 npx cache 路徑走。Hub recovery 時新 hub 可能有不同的 `__dirname`，導致讀不到舊 logs。

改為固定路徑 `path.join(os.homedir(), '.ccxray', 'logs')`。

**Migration**：啟動時檢查舊路徑（`__dirname/../logs/`）是否有 `index.ndjson`，有的話一次性搬移到新路徑。

**替代方案**：環境變數覆蓋 → 不夠 zero-config，否決。

### D9: Lockfile 記錄 hub 版本 + semver 比對

`hub.json` 加入 `version` 欄位。Client 啟動時比對：
- major 不同 → 拒絕連線，提示 "Close all ccxray instances and restart"
- minor 不同 → 警告但允許連線
- patch 不同 → 靜默允許

1.0 沒有 hub 功能，所以不存在 1.0 hub + 1.1 client 的情境。

### D10: Lockfile 在 listen 成功後才寫（readiness signal）

Hub 的 lockfile 不在 fork 時寫，而是在 `listen()` 成功後才寫。Client fork hub 後 poll lockfile 存在性（每 200ms `fs.existsSync`），lockfile 出現 = hub ready。Timeout 10 秒後報錯並提示查看 `~/.ccxray/hub.log`。

**替代方案**：HTTP poll `/api/health` → 可行但 lockfile poll 更輕量且語義更清晰（lockfile 存在 ≡ ready）。

### D11: `--port` 明確指定 = opt-out hub 模式

- 不帶 `--port` → 自動 hub 模式（discovery → 共用或啟動 hub）
- 帶 `--port` → 獨立 server 模式（現有行為，不參與 hub）

語義直覺：明確指定 port = 我想要獨立的 server。

### D12: hub.log truncation

Hub 啟動時檢查 `~/.ccxray/hub.log` 大小，> 1MB 時 truncate 到最後 100KB。保留最近的錯誤，防止無限增長。

### D13: PID reuse 防護 — 雙重驗證

Lockfile 存在時，先 `process.kill(pid, 0)` 再 `GET /api/health`。兩個都通過才認定 hub 存活。防止 OS 將死掉的 hub pid 分配給無關 process。

### D14: Hub 使用獨立的 hubMode

Hub 不進入 claudeMode（不 suppress console.log），也不是 standalone mode（不開 browser、不印完整 banner）。新增 hubMode：stdout/stderr 導向 hub.log，有 request log 但無互動式輸出。

### D7: Hub stdout/stderr 導向 log file

Detached process 的 `stdio: 'ignore'` 會吞掉所有錯誤訊息。Hub 改為：

```js
const hubLog = path.join(os.homedir(), '.ccxray', 'hub.log');
const fd = fs.openSync(hubLog, 'a');
spawn('node', [hubScript], {
  detached: true,
  stdio: ['ignore', fd, fd]
});
```

**理由**：Hub 啟動即 crash（例如 port 已被非 ccxray 程式佔用）時，使用者可以查看 `~/.ccxray/hub.log` 診斷。`ccxray status` 指令在回報錯誤時可以提示此路徑。

## Risks / Trade-offs

**[Hub crash → 全部 claude 斷線]** → Client 自動偵測（5 秒 pid check）→ fork 新 hub → claude 的下一次 API retry 即恢復。最長中斷時間 ~6 秒。

**[多 client 同時搶當 hub（race condition）]** → Port 是天然 mutex：只有一個 `listen()` 成功，其他收到 `EADDRINUSE` 並退回 client 模式。不需要 flock 或 leader election。

**[Lockfile 殘留（hub crash 沒清理）]** → 讀到 lockfile 後用 `process.kill(pid, 0)` 驗證 pid 是否存活。不存活就刪檔、自己成為 hub。

**[npx cache 清除導致 hub 的 JS 檔案消失]** → Hub 只需活到最後一個 claude 退出後 5 秒。npx 在 session 期間不會主動清 cache。可接受的風險。

**[Unregister 沒被呼叫（SIGKILL）]** → Hub 的 pid health-check 備援機制會在 30 秒內偵測到死掉的 client 並清理。

**[Hub 啟動失敗但使用者看不到錯誤]** → Hub stderr 導向 `~/.ccxray/hub.log`，`ccxray status` 會提示查看此檔案。

**[LOGS_DIR 跟著 npx cache → recovery 後讀不到舊 logs]** → LOGS_DIR 改為固定路徑 `~/.ccxray/logs/`，不依賴 `__dirname`。

**[Hub 版本不一致 → 404 或奇怪行為]** → Lockfile 記錄版本，client 啟動時 semver 比對。Major 不同拒絕，minor 警告，patch 靜默。

**[Client 在 hub 未 ready 時 spawn claude]** → Lockfile 在 listen 成功後才寫。Client poll lockfile 存在性，出現才 spawn claude。

**[`--port` 在 hub 模式下語義不明]** → 帶 `--port` = opt-out hub 模式，啟動獨立 server。

**[PID reuse 誤判]** → pid check + `/api/health` 雙重驗證。
