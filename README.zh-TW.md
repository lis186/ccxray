# ccxray

[English](README.md) | **正體中文** | [日本語](README.ja.md)

AI 代理工作階段的透視鏡。零設定的 HTTP 代理，記錄 Claude Code、Codex 與上游 API 之間的每一次呼叫，搭配即時儀表板與工作流程時間軸，讓你看清代理內部到底在做什麼。

![License](https://img.shields.io/badge/license-PolyForm%20Noncommercial-blue)
[![Mentioned in Awesome Claude Code](https://awesome.re/mentioned-badge-flat.svg)](https://github.com/hesreallyhim/awesome-claude-code)

![ccxray 儀表板](https://raw.githubusercontent.com/lis186/ccxray/v2.5.0-rc.1/docs/dashboard-v2.png)

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
# 或
npx ccxray codex
# 或
npx ccxray grok
```

代理會啟動，選定的 CLI 經由代理執行，儀表板也會自動開啟。在 macOS 和 Linux 上，不指定 `--port` 的 agent launch 會共用同一個 hub 和 dashboard。Windows 每次 launch 都是獨立 server，請參考下方範例。

如果 ccxray 無法載入 proxy 或連接 hub，會直接啟動 agent，該 session 不會被記錄。Hub 連線預設有 3000 ms 時限；未完成的連線會在時限到達時 fallback，若更早失敗也會提前 fallback。可用 `CCXRAY_ATTACH_TIMEOUT_MS` 調整時限。ccxray 會嘗試將 fallback 寫入 `<CCXRAY_HOME>/fail-open.log`（預設 `~/.ccxray/fail-open.log`），但寫檔屬於 best effort，可能失敗。設定 `CCXRAY_FAIL_CLOSED=1` 可改為停止啟動。Claude 的 `--bg` / `--background` launch 會依設計略過 proxy。

若要持續安裝並設定 Claude shell wrapper（僅本機記錄）：

```bash
npm install -g ccxray
ccxray setup
# 開啟新終端機（或重新載入 shell profile），再確認設定：
ccxray setup --check
```

單純執行 `ccxray setup` 不會寫入任何匯出設定，也不需要 bucket、domains 或 gcloud 憑證。GCS 摘要匯出需以 `--export` 明確啟用。使用前請先安裝 Claude Code，並確認 ccxray 能讀取已登入帳號的 email；`--domains` 清單必須包含該帳號的網域。匯出設定也需要可讀取的 gcloud Application Default Credentials，請先執行 `gcloud auth application-default login`。即使 exporter 本身支援 service-account key file，setup 仍會拒絕 `CCXRAY_EXPORT_GCS_KEY_FILE`。

```bash
gcloud auth application-default login
ccxray setup --export --bucket "<bucket>" --domains example.com --cwd-allowlist "project-a,project-b" --retention-days 30
```

已啟用匯出的安裝（由 2.x 設定）在不帶 `--export` 重新執行 `ccxray setup` 時會繼續匯出，setup 會印出一行說明。

`setup` 會在 shell profile 加入 Claude wrapper（使用 `--export` 時另加匯出設定）、設定日誌保留期限，並寫入 `CCXRAY_IMPORT_DISABLE=1`。它不會安裝 Codex wrapper。可用 `ccxray setup --dry-run` 預覽變更（帶上相同的 setup 選項）。`ccxray setup --remove` 會移除 ccxray 寫入的 shell 區塊，並寫入 tombstone 停止後續上傳；不會刪除本機日誌或已上傳的摘要。資料與移除方式詳見[匯出設定指南](docs/export-onboarding.md)。

launcher 參數由 provider registry 管理。目前支援 `claude`、`codex` 與 `grok`；未知的 provider command 會直接失敗，避免靜默啟動未設定的 proxy。

### Herdr plugin

在 Herdr 裡執行 ccxray session，可直接在 sidebar 看到 context、cost 與 health，並用 Mission Control 和 dashboard 追查每個 turn：

```bash
herdr plugin install lis186/ccxray/plugins/herdr
herdr plugin action invoke ccxray.herdr.quick-start
```

第二個命令會因為安裝到已在執行的 Herdr 不會觸發 startup hooks，而立即開啟可用游標操作的 Quick Start。請用方向鍵或 `j`/`k` 移動、按 `Enter` 執行；數字與字母快捷鍵仍可用。如果 onboarding 尚未完成，plugin 也會在下一次完整啟動 Herdr 時提供一次 Quick Start。它會偵測已安裝的 provider，並啟動第一個 traced session；sidebar 變更仍是 optional、explicit 且 reversible。第一次 traced session 後會提供 Mission Control，累積足夠樣本後才提供 experimental Capability Footprint。安裝、信任、更新與解除安裝請參閱 [Herdr plugin 指南](https://github.com/lis186/ccxray/blob/v2.5.0-rc.1/plugins/herdr/README.md)；Provider 功能矩陣與已知限制請參閱 [Herdr 支援說明](https://github.com/lis186/ccxray/blob/v2.5.0-rc.1/docs/herdr-support.zh-TW.md)。

### 其他執行方式

```bash
ccxray                           # 只啟動代理 + 儀表板
ccxray claude --continue         # 傳入 provider 的參數範例
ccxray codex exec "hello"        # 傳入 provider 的參數範例
ccxray grok -p "hello"           # 傳入 provider 的參數範例
ccxray --port 8080 claude        # 自訂 port（獨立模式，不共用 hub）
ccxray claude --no-browser       # 不自動開啟瀏覽器
ccxray status                    # 顯示 process、匯出、home 與 hub 狀態
ccxray --port 5602 status        # 找不到 hub lock 時才會探測 5602 port
ANTHROPIC_BASE_URL=http://localhost:5577 claude   # 將現有 claude session 指向運行中的 ccxray hub
```

Hub 與 standalone 的差異、如何讓 proxy 持續運作、以及如何讓不是透過 ccxray 啟動的 agent 走 proxy：詳見 [Running ccxray](docs/running-ccxray.md)（英文）。

Provider 參數會傳給對應的 CLI；ccxray 自己辨識的 global flag（例如 `--port`、`--no-browser`）無論出現在參數列哪個位置，都會由 ccxray 取走而不會傳給 CLI。

### 多專案

在 macOS 和 Linux 上，多個終端機執行 `ccxray claude` 會自動共用同一個 proxy 和 dashboard — 無需任何設定。Windows 不使用共享 hub；每次 launch 都是獨立 server，需使用各自的 port。

```bash
# Terminal 1
cd ~/project-a && ccxray claude     # 啟動 hub + claude

# Terminal 2
cd ~/project-b && ccxray claude     # 連線至現有 hub

# 兩個專案都顯示在 http://localhost:5577 的 dashboard
```

如果 macOS 或 Linux 上的 hub 意外終止，已連線的 client 會在數秒內自動恢復。Windows 請讓每個 launch 使用不同 port：

```powershell
# Terminal 1
ccxray --port 5577 claude

# Terminal 2
ccxray --port 5578 claude
```

分別開啟 `http://localhost:5577` 和 `http://localhost:5578` 查看兩個獨立 dashboard。

```bash
$ ccxray status
Hub: http://localhost:5577 (pid 12345, uptime 3600s, v<version>)
Process: exportState=enabled ... identity={...}
Home: ~/.ccxray — current — cursor has consumed through the index tail (...)
Machine: {"proxy":true,"hub":true,"pid":12345,"port":5577,"occupant":"ccxray-hub"}
Connected clients (2):
  [1] pid 23456 — ~/dev/project-a
  [2] pid 34567 — ~/dev/project-b
Shell: exportState=enabled hash=... — this shell's environment, not what the running exporter uses
Config: equal
Durable: ~/.ccxray (named by hub) — enrollment=enrolled · cursor ... · last attempt ...
```

`Process`、`Home`、`Shell`、`Config` 與 `Durable` 行會顯示執行中的 process、本機匯出狀態、目前 shell 設定，以及持久化的 enrollment/cursor 紀錄。使用 `--port` 可改為獨立模式。

## 支援的 agent 模組

Launcher 註冊在 `server/providers.js`（共用同一 hub + dashboard）：

| 命令 | Wire 家族 | 預設上游 |
|------|-----------|----------|
| `ccxray claude` | Anthropic Messages | `api.anthropic.com` |
| `ccxray codex` | OpenAI Responses | `api.openai.com` / ChatGPT |
| `ccxray grok` | OpenAI Responses（client 模組） | `cli-chat-proxy.grok.com`（`XAI_BASE_URL` 可覆寫） |

非 Codex 的 OpenAI-wire 客戶端（目前：Grok）列在 `OPENAI_WIRE_CLIENTS`：共用 parser、各自 host/agent/raw-session。多 agent hub 可並存，不必改 `OPENAI_BASE_URL`。驗收備註：[Grok 測試說明](https://github.com/lis186/ccxray/blob/v2.5.0-rc.1/docs/grok-testing.md)。

**Grok 帳單揭露：** 代理 Grok CLI 流量時，ccxray 會呼叫 `cli-chat-proxy.grok.com/v1/billing`（使用 CLI 已經透過 proxy 傳送的同一組 auth token）來填充 Usage 分頁的帳戶卡片。成功回應後的 60 秒內會抑制重複呼叫（per alias+credential）。設定 `XAI_BASE_URL` 可將呼叫導向其他主機。

## Codex 支援（Beta）

```bash
npx ccxray codex
```

支援 API key session。**2.5.0-rc.3 已知不支援：** Codex 0.159.2 與 0.163.0 的 ChatGPT 登入 session，經由本機 HTTP proxy 進行 workspace-routing bootstrap 時會失敗（[#671](https://github.com/lis186/ccxray/issues/671)）。這類 session 請直接執行 Codex，不要套用 ccxray 的 base-URL 覆寫。discovery 路徑不符與 HTTPS-origin 限制的說明見[調查記錄](docs/codex-workspace-routing.md)。

對相容的 ChatGPT client，帶有 `chatgpt-account-id` header 時會路由到 `chatgpt.com/backend-api/codex`。Codex 啟動時的平台輪詢（plugin 清單、connector 目錄、app metadata）會照常代理，但不顯示在儀表板上，讓 timeline 只呈現對話流量。

**Beta 注意事項：**
- WebSocket 傳輸（`/v1/responses` 升級）會逐 frame 解碼：每個 codex turn 記錄 model、token 用量、請求的 instructions/input/tools 與回應事件。少數大型 envelope 事件只保留精簡的時間錨點（供 TTFT 計算）而非完整內容，所以 codex turn 的細節在部分地方仍不及 Claude turn。
- 相較 Claude 路徑，實際使用的驗證量較少。

可調整的環境變數：`OPENAI_BASE_URL`、`CHATGPT_BASE_URL`、`CCXRAY_WS_IDLE_TIMEOUT_MS`、`CCXRAY_WS_MAX_QUEUE_BYTES`。詳見 [CLAUDE.md](https://github.com/lis186/ccxray/blob/v2.5.0-rc.1/CLAUDE.md)。

歡迎到 [GitHub](https://github.com/lis186/ccxray/issues) 回報問題 — Beta 的意思就是我們想收到粗糙邊角的回報。

## 功能

### 工作流程時間軸

即時觀看代理的思考過程與並行結構。

**Turn 卡片**：每個回合渲染成五行資訊卡——cost、cache 熱度（含 turn 間空檔時間，及時抓出 cache miss）、tool 失敗風險訊號、`hit:0%` 紅色警示、tools 列前置於標題上方。不用展開任何一張卡片，就能掃完整場 session 的健康狀態。

**Lane 視覺化**：多 agent session 自動拆分為平行 lane——orchestrator 走主 lane，subagent 分出 Fork / Teammate lane。每條 lane 有 WCAG ≥3:1 對比的獨立色彩，支援混合 model 標示。Sequential-interleave tracker 標記同一對話中哪些 turn 是循序、哪些是並行。

**鳥瞰模式**：切換 birdseye overview 可將 overview 區域放大到約 80% viewport，搭配放大版 minimap 與範圍摘要，掌握長 session 的全貌。

**L1/L2 雙層選取**：Tab / ▲▼ 選取 lane（L1），j/k 在 lane 內選取 turn（L2），Esc 逐層退出。取代舊的單層 click 模型。

![工作流程時間軸](https://raw.githubusercontent.com/lis186/ccxray/v2.5.0-rc.1/docs/timeline-v2.png)

### 用量與成本

追蹤你的實際花費。消耗速率、各帳號 Claude 及 Codex 速率限制卡片 — 精確掌握 token 流向。

![用量分析](https://raw.githubusercontent.com/lis186/ccxray/v2.5.0-rc.1/docs/usage.png)

### System Prompt 追蹤

自動偵測版本變更，內建 diff 檢視器。瀏覽多種已辨識 agent 類型的 prompt，精確掌握每次更新的差異。不確定的項目會誠實標為 `unknown`。

![System Prompt 追蹤](https://raw.githubusercontent.com/lis186/ccxray/v2.5.0-rc.1/docs/system-prompt-v2.png)

### 鍵盤導航

整個儀表板都能用鍵盤操控。每個畫面底部都有情境感知的快捷鍵提示列，會隨你移動即時更新目前有效的按鍵。按 `?` 展開完整快捷鍵清單。從 projects → sessions → timeline → 個別 diff hunk，全程不用碰滑鼠。

**工作流程導航**：Tab / ▲▼ 在 lane 之間切換（L1 選取），j/k 在 lane 內的 turn 之間切換（L2 選取），Esc 逐層退出回上一層。

**步驟類型跳轉**：`e`/`E` 跳到下/上一個錯誤，`s`/`S` 跳到 Skill 呼叫，`a`/`A` 跳到 subagent（Agent/Task）呼叫，`m`/`M` 跳到 MCP 工具呼叫。每次跳轉都有位置感知——從目前位置往前或往後找最近的符合步驟，並同步更新網址列。

`n`/`N` 可在整個儀表板中跳到下/上一個加星項目——跨越 projects、sessions、turns 及 timeline 的個別步驟。快捷鍵列只在目前畫面有可到達的加星項目時才顯示此按鍵。

![鍵盤導航](https://raw.githubusercontent.com/lis186/ccxray/v2.5.0-rc.1/docs/keyboard-v2.png)

### Session 標題與 Cache 提醒

Session 卡片顯示 Claude Code 自動生成的標題（例如 `Fix login button on mobile`），並附有即時 cache TTL 倒數（`cache 4m left`），不到 1 分鐘時變紅閃爍。任何 session 接近到期時，瀏覽器分頁標題會在 `ccxray` 和 `⚠ ccxray` 之間交替。可選的瀏覽器通知會在計畫感知的提前時間觸發 — Max 提前 5 分鐘、Pro/API key 提前 60 秒。直接 API 呼叫或仍在進行中的 session 退回顯示短雜湊。

![Session 標題與 Cache 到期提醒](https://raw.githubusercontent.com/lis186/ccxray/v2.5.0-rc.1/docs/cache-expiry.png)

### Session 天氣

每張 session 卡片顯示天氣 emoji（☀️ 晴天 → ⛈️ 暴風雨），依 context 壓力、compaction、輸出截斷、延遲漂移與 cache 命中率計分。缺少 tool 結果證據時，狀態也可能顯示為 unavailable。Hover 可看分解。詳見[天氣功能說明](https://github.com/lis186/ccxray/blob/v2.5.0-rc.1/docs/weather.md)。

> **注意（2.3.1）：** 天氣顯示**預設關閉**，因為工具失敗訊號正在修復中。計算仍在背景持續進行。在 dashboard URL 後加 `?weather=on` 可臨時檢視，或在 console 執行 `localStorage.setItem('ccxray-weather-display', 'on')` 持久啟用。詳見[天氣功能說明](https://github.com/lis186/ccxray/blob/v2.5.0-rc.1/docs/weather.md#display-toggle-231)。

### 計畫自動偵測

ccxray 透過讀取 Anthropic 的 `cache_creation` 用量欄位，自動偵測你的訂閱計畫（Pro、Max 5x、Max 20x），無需任何設定。Cache TTL 和配額門檻均使用偵測到的計畫。若偵測結果有誤，可用 `CCXRAY_PLAN` 覆蓋。

### 各帳號速率限制

在同一個儀表板上查看每個 Claude 和 Codex 帳號的 5 小時和每週配額用量。自動偵測 `~/.codex-*/sessions/` 以支援多帳號 Codex 設定，並透過 `ccxray setup-statusline` 讀取 Claude statusline 資料。Business/unlimited Codex 計畫顯示 `∞ Unlimited`。資料每 30 秒在背景非同步刷新，不阻塞 proxy。

### 請求攔截與編輯

在請求送出至 Anthropic 之前先暫停。在 session 上開啟攔截後，下一個來自 Claude Code 的請求會被儀表板留住 — 你可以即時編輯 system prompt、訊息、tools 或 sampling 參數，再選擇放行（轉發你編輯後的版本）或拒絕（回傳錯誤給 Claude Code）。適合 prompt engineering、把高風險 tool call 隔離在沙箱裡、或在不分叉 agent 的情況下做實驗。

### Context HUD

可選的上下文統計區塊，會被附加到 Claude Code 中 Claude 的回覆尾端：`📊 Context: 28% (290k/1M) | 1k in + 800 out | Cache 99% hit | $0.15`。預設啟用；可從儀表板頂部列切換。

**為什麼需要這個開關？** 當主 agent 透過 Agent / Task tool 呼叫 sub-agent 時，附加的區塊可能會把 sub-agent 的回傳內容截斷在父 agent 看到的範圍之外，造成多 agent 工作流程靜默地遺失資料。跑 sub-agent 較重的 session 時請關掉 HUD。狀態保存在 `~/.ccxray/settings.json`。

### 加星永久保留

在 turn、session 或 project 卡片上點星號，即可標記為永久保留。加星項目不會被 `LOG_RETENTION_DAYS` 的自動清理刪除;狀態存於 `~/.ccxray/settings.json`,server 端持續、跨瀏覽器同步。Star 一個 turn 連帶保護整個 session 的所有 turn;star 一個 session 保護其下所有 turn;star 一個 project 保護其下所有資料。Catch-all bucket(`direct-api`、`(unknown)`、`(quota-check)`)禁止在 bucket 層加星——請對裡面的個別 turn 加星即可。

Timeline 的個別步驟也可以加星（每個步驟 row 上有 `★`/`☆` toggle）。加星的步驟與直接對 turn 加星效果相同，同樣保護其 parent turn 和 session。

當父層因為下方有 starred 子項目而被間接保留,badge 會顯示 `☆ [N]` 而非 `★`。點 chip 數字會展開 popover,列出究竟是哪些子項目在保它。每筆的星號是獨立 toggle;點 row 主體則直接跳到該 turn / session。

![星號保留與子項目 popover](https://raw.githubusercontent.com/lis186/ccxray/v2.5.0-rc.1/docs/stars.png)

### 使用量分析 CLI

```bash
ccxray usage                          # 人類可讀摘要
ccxray usage --json                   # JSON 輸出，供 agent 消費 (< 4KB)
ccxray usage --last 7d                # 最近 7 天（支援 d/h/m）
ccxray usage --cwd myproject          # 目錄名子字串智慧比對
ccxray usage --cwd ~/code/app         # 絕對路徑或 ~ 路徑 → 子目錄樹前綴比對
ccxray usage --cwd proj-a,proj-b      # 多個專案 → 比較表
ccxray usage --session latest         # 最近的 session
ccxray usage --session costliest      # 最貴的 session
ccxray usage --session "fix login"    # 依 session 標題搜尋
ccxray usage --session 950432         # UUID 前綴比對
ccxray usage --session costliest --open  # 在儀表板開啟該 session
ccxray usage --tools                  # 完整工具呼叫明細
```

0.6 秒完成自動化使用量分析 — 不用手動翻 log 就能知道 token 和錢花在哪。直接讀取 `index.ndjson`，不需要啟動 server。顯示模型成本分佈、工具與 skill 使用量、prompt hash 穩定性（system/tools/core prompt 在 turn 間的變化頻率）、依 turn 間隔的 cache 命中率、以及花費最高的 10 個 session（含標題）。

`--json` 輸出是 agent-facing 契約 — 完整的逐欄位 schema、multi-cwd 與錯誤輸出形狀、以及過濾語意見 [`docs/usage.md`](docs/usage.md)。

### agentflow 報表（實驗性）

```bash
ccxray agentflow report              # 專案 agentflow notebook 的每個 Ask
ccxray agentflow report --ask A-012  # 單一 Ask
ccxray agentflow report --json       # JSON
```

給使用 [agentflow](https://github.com/agfnow/agentflow) 的專案：列出 notebook 每個 Ask 的 token、成本、模型、effort 與時間，並分成 host session、subagent 與派出去的 external worker。報表會讀 transcript 來做歸屬，但用量數字來自 ccxray index 中的 turns。若所需 turns 已在 index，可略過 import；只有 transcript 的歷史資料必須先匯入才會計入用量。`ccxray setup` 會停用 import，需要時請依指南使用單次 import 流程。不需啟動 server。詳見 [`docs/agentflow-report.md`](docs/agentflow-report.md)（英文）。

### 其他功能

- **Deep Link 導航** — 每個選取狀態（project / session / turn / step）都會反映在網址列 URL 中。把 URL 貼到新分頁，儀表板會直接導航到相同的畫面。
- **可收合側欄** — overview 面板可收合，給 timeline 更多空間。
- **Cache TTL 分項** — turn 詳情顯示 cache 使用的是 5 分鐘或 1 小時 TTL。
- **隱藏專案** — 在 `settings.json` 設定 `hiddenProjects` 隱藏特定專案，分享時不洩漏。
- **Per-session 還原上限** — `CCXRAY_SESSION_ENTRY_CAP` 限制啟動還原時單一 session 載入的條目數，防止巨量 session 擠掉其他 session。
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

ccxray 是透明的 HTTP 代理。它將請求轉發到上游 API（Anthropic 或 OpenAI），將請求與回應記錄為 JSON 檔案，並在同一連接埠提供網頁儀表板。Loopback 對 dashboard 與 upstream API 的請求預設信任；設定 `CCXRAY_LOOPBACK_REQUIRE_AUTH=1` 後，loopback 也需通過認證。非 loopback 的受保護 dashboard/API 請求需要有效認證；upstream HTTP 與 WebSocket 流量通常需要 ccxray 注入的認證資訊。ChatGPT 路由的 Codex 流量有相容性例外：ccxray 接受 `chatgpt-account-id` 與 JWT 外觀的 `Authorization` header，但不驗證簽章，OAuth 有效性由 upstream 判定。`AUTH_TOKEN` 可設定共用 token，未設定時 ccxray 使用本機 secret。`/_api/health` 仍公開最小識別資訊（`capabilities: []`）；只有受信任的呼叫端會收到 export report。Hub 間通訊透過 Unix domain socket（`~/.ccxray/hub.sock`）而非 HTTP。

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
| `AUTH_TOKEN` | _（未設定）_ | 選用的共用存取 token。未設定時使用 `<CCXRAY_HOME>/local-secret`（預設 `~/.ccxray/local-secret`）。非 loopback 的受保護 dashboard/API 請求與多數 upstream 流量需要認證；ChatGPT 路由的 Codex 流量有 native-marker 例外。除非設定 `CCXRAY_LOOPBACK_REQUIRE_AUTH=1`，否則 loopback 預設信任。詳見 [SECURITY.md](SECURITY.md)。 |
| `CCXRAY_SESSION_ENTRY_CAP` | `500` | 啟動還原時單一 session 最多載入的條目數。超過此值的 session 只保留最新 1 筆（runtime 不限制） |
| `CCXRAY_LOOPBACK_REQUIRE_AUTH` | _（未設定）_ | Loopback 預設免認證；設為 `1` 可強制 loopback 也走認證閘門 |
| `CCXRAY_HOME` | `~/.ccxray` | 基底目錄，存放 hub lockfile、logs、hub.log |
| `CCXRAY_MAX_ENTRIES` | `5000` | 記憶體中最多保留的條目數（最舊的會被淘汰；磁碟日誌不受影響） |
| `LOG_RETENTION_DAYS` | `14` | 啟動時自動清除超過 N 天的日誌檔案。加星的 turn / session / project（及其下所有條目）會受保護;仍被還原條目參照的檔案也會受保護。設為 `0` 可停用;但已完成匯出 enrollment 的 home 會改用其記錄的正數保留天數(見 export onboarding)。 |
| `RESTORE_DAYS` | `14` | 限制啟動時讀回的日誌天數（`0` = 全部，仍受 `CCXRAY_MAX_ENTRIES` 上限影響）。日誌目錄非常大時很有用。 |
| `CCXRAY_PLAN` | _（自動）_ | 覆蓋計畫偵測：`pro`、`max5x`、`max20x`、`api-key` |
| `CCXRAY_DISABLE_TITLES` | _（未設定）_ | 設為 `1` 可停用 session 標題擷取（退回顯示短雜湊） |
| `CCXRAY_MODEL_PREFIX` | _（未設定）_ | 轉發前在 model 名稱前加上前綴（例如 `databricks-`）。適用於上游需要廠商前綴 model 名稱、但 Claude Code 只接受標準名稱的情況。 |
| `HTTPS_PROXY` / `https_proxy` | _（未設定）_ | 透過 HTTP CONNECT tunnel 將對外 HTTPS 流量導向企業 proxy。 |
| `ANTHROPIC_BASE_URL` | — | 自訂上游 Anthropic 端點（例如企業閘道）。支援 base path — `https://host/serving-endpoints/anthropic` 直接可用。設定了 `ANTHROPIC_TEST_*` 時以其為準。 |

所有環境變數（含預設值與定義檔案）列於 [docs/env-vars.md](docs/env-vars.md)。

原始 request/response 日誌會留在本機 `LOGS_DIR`（預設 `~/.ccxray/logs/`），檔名為 `{timestamp}_req.json` 和 `{timestamp}_res.json`。從 v1.0 升級？`./logs/` 中的日誌會在首次啟動時自動遷移。

若透過 `ccxray setup` 設定匯出，ccxray 可上傳每日與單一 session 的摘要；不會上傳原始 request/response 日誌。摘要可能包含使用者身分、session ID、repository basename、model 名稱，以及 tool 或 skill 名稱。來源提供的名稱與 metadata 不會全面去敏，啟用匯出前請先檢查。`CCXRAY_EXPORT_CWD_ALLOWLIST` 會把未列出的 repo 名稱遮罩為 `[other]`，不會排除該 session。設定 `CCXRAY_EXPORT_DOMAINS` 後，只會匯出帶有相符 Claude launch-account snapshot 的 turn；Codex 和 Grok launch 不帶此 snapshot，因此會被排除。這是目前預期的行為。欄位、篩選與移除方式詳見[匯出設定指南](docs/export-onboarding.md)。

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

PolyForm Noncommercial 1.0.0 — 見 [LICENSE](LICENSE)
