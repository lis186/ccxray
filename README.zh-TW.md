# ccxray

[English](README.md) | **正體中文** | [日本語](README.ja.md)

AI 代理工作階段的透視鏡。零設定的 HTTP 代理，記錄 Claude Code 與 Anthropic API 之間的每一次呼叫，搭配即時儀表板，讓你看清代理內部到底在做什麼。

![License](https://img.shields.io/badge/license-MIT-blue)
[![Mentioned in Awesome Claude Code](https://awesome.re/mentioned-badge-flat.svg)](https://github.com/hesreallyhim/awesome-claude-code)

![ccxray 儀表板](docs/dashboard.png)

## 為什麼需要

Claude Code 是個黑盒子。你看不到：
- 它送出了什麼 system prompt（以及版本間的變化）
- 每次 tool call 花了多少錢
- 為什麼它思考了 30 秒
- 什麼東西吃掉了你的 200K token 上下文窗口

ccxray 讓它變成透明的。

## 快速開始

```bash
npx ccxray claude
```

就這樣。代理啟動、Claude Code 透過代理連線、儀表板自動在瀏覽器中開啟。在多個終端機執行時會自動共用同一個 dashboard。

### 其他執行方式

```bash
ccxray                           # 只啟動代理 + 儀表板
ccxray claude --continue         # 所有 claude 參數直接穿透
ccxray --port 8080 claude        # 自訂 port（獨立模式，不共用 hub）
ccxray claude --no-browser       # 不自動開啟瀏覽器
ccxray status                    # 顯示 hub 資訊及已連線的 client
ANTHROPIC_BASE_URL=http://localhost:5577 claude   # 將現有 claude session 指向運行中的 ccxray hub
```

### 多專案

在多個終端機執行 `ccxray claude` 會自動共用同一個 proxy 和 dashboard — 無需任何設定。

```bash
# Terminal 1
cd ~/project-a && ccxray claude     # 啟動 hub + claude

# Terminal 2
cd ~/project-b && ccxray claude     # 連線至現有 hub

# 兩個專案都顯示在 http://localhost:5577 的 dashboard
```

如果 hub 意外終止，已連線的 client 會在數秒內自動恢復。

```bash
$ ccxray status
Hub: http://localhost:5577 (pid 12345, uptime 3600s)
Connected clients (2):
  [1] pid 23456 — ~/dev/project-a
  [2] pid 34567 — ~/dev/project-b
```

使用 `--port` 可改為獨立模式。

## 功能

### 時間軸

即時觀看代理的思考過程。每個回合渲染成五層資訊卡：第 1 行 cost、cache 熱度（含 turn 間空檔時間，及時抓出 cache miss）、tool 失敗風險訊號、`hit:0%` 紅色警示、tools 列前置於標題上方。整場 session 的健康狀態一眼掃完，不必展開任何卡片。

![時間軸檢視](docs/timeline.png)

### 用量與成本

追蹤你的實際花費。工作階段熱力圖、消耗速率、ROI 計算 — 精確掌握 token 流向。

![用量分析](docs/usage.png)

### System Prompt 追蹤

自動偵測版本變更，內建 diff 檢視器。瀏覽 11 種已辨識的 agent 類型 — Orchestrator、General Purpose、Plan、Explore、Web Search、Codex Rescue、Claude Code Guide、Summarizer、Title Generator、Name Generator、Translator — 精確掌握每次更新的差異。對 12,730 份真實捕捉的 prompts 做回溯驗證：被分類的項目 100% 正確，不確定的則誠實標為 `unknown`。

![System Prompt 追蹤](docs/system-prompt.png)

### 鍵盤導航

整個儀表板都能用鍵盤操控。每個畫面底部都有情境感知的快捷鍵提示列，會隨你移動即時更新目前有效的按鍵。按 `?` 展開完整快捷鍵清單。從 projects → sessions → turns → sections → timeline → 個別 diff hunk，全程不用碰滑鼠。

![鍵盤導航](docs/keyboard.png)

### Session 標題與 Cache 提醒

Session 卡片顯示 Claude Code 自動生成的標題（例如 `Fix login button on mobile`），並附有即時 cache TTL 倒數（`cache 4m left`），不到 1 分鐘時變紅閃爍。任何 session 接近到期時，瀏覽器分頁標題會在 `ccxray` 和 `⚠ ccxray` 之間交替。可選的瀏覽器通知會在計畫感知的提前時間觸發 — Max 提前 5 分鐘、Pro/API key 提前 60 秒。直接 API 呼叫或標題生成仍在進行中的 session 退回顯示短雜湊。

![Session 標題與 Cache 到期提醒](docs/cache-expiry.png)

### 計畫自動偵測

ccxray 透過讀取 Anthropic 的 `cache_creation` 用量欄位，自動偵測你的訂閱計畫（Pro、Max 5x、Max 20x），無需任何設定。頂部列顯示 `Plan: Max 5x · TTL 1h (auto)`。ROI 計算和配額面板均使用偵測到的計畫。若偵測結果有誤，可用 `CCXRAY_PLAN` 覆蓋。

### 請求攔截與編輯

在請求送出至 Anthropic 之前先暫停。在 session 上開啟攔截後，下一個來自 Claude Code 的請求會被儀表板留住 — 你可以即時編輯 system prompt、訊息、tools 或 sampling 參數，再選擇放行（轉發你編輯後的版本）或拒絕（回傳錯誤給 Claude Code）。適合 prompt engineering、把高風險 tool call 隔離在沙箱裡、或在不分叉 agent 的情況下做實驗。

### Context HUD

可選的上下文統計區塊，會被附加到 Claude Code 中 Claude 的回覆尾端：`📊 Context: 28% (290k/1M) | 1k in + 800 out | Cache 99% hit | $0.15`。預設啟用；可從儀表板頂部列切換。

**為什麼需要這個開關？** 當主 agent 透過 Agent / Task tool 呼叫 sub-agent 時，附加的區塊可能會把 sub-agent 的回傳內容截斷在父 agent 看到的範圍之外，造成多 agent 工作流程靜默地遺失資料。跑 sub-agent 較重的 session 時請關掉 HUD。狀態保存在 `~/.ccxray/settings.json`。

### 其他功能

- **工作階段偵測** — 自動依 Claude Code session 分組，含專案/工作目錄擷取
- **Token 記帳** — 每回合明細：input/output/cache-read/cache-create tokens、美元成本、上下文窗口使用率

## 運作原理

```
Claude Code  ──►  ccxray (:5577)  ──►  api.anthropic.com（或 ANTHROPIC_BASE_URL）
                      │
                      ▼
                  ~/.ccxray/logs/ (JSON)
                      │
                      ▼
                  儀表板（同一連接埠）
```

ccxray 是透明的 HTTP 代理。它將請求轉發到 Anthropic，將請求與回應記錄為 JSON 檔案，並在同一連接埠提供網頁儀表板。不需要 API 金鑰 — 它直接傳遞 Claude Code 送出的內容。

## 設定

### CLI 參數

| 參數 | 說明 |
|---|---|
| `--port <number>` | 代理 + 儀表板的連接埠（預設：5577）。使用後不共用 hub。 |
| `--no-browser` | 不自動在瀏覽器中開啟儀表板 |

### 環境變數

| 變數 | 預設值 | 說明 |
|---|---|---|
| `PROXY_PORT` | `5577` | 代理 + 儀表板的連接埠（`--port` 會覆蓋此值） |
| `BROWSER` | — | 設為 `none` 可停用自動開啟 |
| `AUTH_TOKEN` | _（無）_ | 存取控制用 API 金鑰（未設定時停用） |
| `CCXRAY_HOME` | `~/.ccxray` | 基底目錄，存放 hub lockfile、logs、hub.log |
| `CCXRAY_MAX_ENTRIES` | `5000` | 記憶體中最多保留的條目數（最舊的會被淘汰；磁碟日誌不受影響） |
| `LOG_RETENTION_DAYS` | `14` | 啟動時自動清除超過 N 天的日誌檔案。仍被還原條目參照的檔案會受保護。設為 `0` 可停用。 |
| `RESTORE_DAYS` | `0` | 限制啟動時讀回的日誌天數（`0` = 全部，仍受 `CCXRAY_MAX_ENTRIES` 上限影響）。日誌目錄非常大時很有用。 |
| `CCXRAY_PLAN` | _（自動）_ | 覆蓋計畫偵測：`pro`、`max5x`、`max20x`、`api-key` |
| `CCXRAY_DISABLE_TITLES` | _（未設定）_ | 設為 `1` 可停用 session 標題擷取（退回顯示短雜湊） |
| `CCXRAY_MODEL_PREFIX` | _（未設定）_ | 轉發前在 model 名稱前加上前綴（例如 `databricks-`）。適用於上游需要廠商前綴 model 名稱、但 Claude Code 只接受標準名稱的情況。 |
| `HTTPS_PROXY` / `https_proxy` | _（未設定）_ | 透過 HTTP CONNECT tunnel 將對外 HTTPS 流量導向企業 proxy。 |
| `ANTHROPIC_BASE_URL` | — | 自訂上游 Anthropic 端點（例如企業閘道）。支援 base path — `https://host/serving-endpoints/anthropic` 直接可用。設定了 `ANTHROPIC_TEST_*` 時以其為準。 |

日誌儲存在 `~/.ccxray/logs/`，格式為 `{timestamp}_req.json` 和 `{timestamp}_res.json`。從 v1.0 升級？`./logs/` 中的日誌會在首次啟動時自動遷移。

### S3 / R2 儲存後端

設定 `STORAGE_BACKEND=s3` 即可把日誌寫到 S3 相容儲存（AWS S3、Cloudflare R2、MinIO）而不是本機磁碟。需要安裝 `@aws-sdk/client-s3`。

| 變數 | 預設值 | 說明 |
|---|---|---|
| `STORAGE_BACKEND` | `local` | `local` 或 `s3` |
| `S3_BUCKET` | _（必填）_ | Bucket 名稱 |
| `S3_REGION` | `auto` | 區域（R2 請用 `auto`） |
| `S3_ENDPOINT` | _（未設定）_ | 自訂 endpoint URL（R2 / MinIO） |
| `S3_PREFIX` | `logs/` | Bucket 內的 key 前綴 |

## Docker

```bash
docker build -t ccxray .
docker run -p 5577:5577 ccxray
```

## 系統需求

- Node.js 18+

## 作者的其他作品

- [SourceAtlas](https://sourceatlas.io/) — 任何 codebase 的導航地圖
- [AskRoundtable](https://github.com/AskRoundtable/expert-skills) — 讓你的 AI 像 Munger、Feynman、Paul Graham 一樣思考
- 在 X 上追蹤 [@lis186](https://x.com/lis186) 獲取最新動態

## 授權

MIT
