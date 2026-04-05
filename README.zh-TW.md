# ccxray

[English](README.md) | **正體中文** | [日本語](README.ja.md)

AI 代理工作階段的透視鏡。零設定的 HTTP 代理，記錄 Claude Code 與 Anthropic API 之間的每一次呼叫，搭配即時儀表板，讓你看清代理內部到底在做什麼。

![License](https://img.shields.io/badge/license-MIT-blue)

![ccxray 儀表板](https://raw.githubusercontent.com/lis186/ccxray/main/docs/dashboard.png)

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

就這樣。代理啟動、Claude Code 透過代理連線、儀表板自動在瀏覽器中開啟。

### 其他執行方式

```bash
ccxray                           # 只啟動代理 + 儀表板
ccxray claude --continue         # 所有 claude 參數直接穿透
ccxray --port 8080 claude        # 自訂 port（獨立模式，不共用 hub）
ccxray claude --no-browser       # 不自動開啟瀏覽器
ccxray status                    # 顯示 hub 資訊及已連線的 client
ANTHROPIC_BASE_URL=http://localhost:5577 claude   # 手動設定（現有工作階段）
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

使用 `--port` 可改為獨立模式。

## 功能

### 時間軸

即時觀看代理的思考過程。每個回合拆解為思考區塊（含時長）、tool call 內聯預覽、助手回應。

![時間軸檢視](https://raw.githubusercontent.com/lis186/ccxray/main/docs/timeline.png)

### 用量與成本

追蹤你的實際花費。工作階段熱力圖、消耗速率、ROI 計算 — 精確掌握 token 流向。

![用量分析](https://raw.githubusercontent.com/lis186/ccxray/main/docs/usage.png)

### System Prompt 追蹤

自動偵測版本變更，內建 diff 檢視器。精確掌握 Claude Code 更新時改了什麼 — 不再遺漏任何 prompt 變動。

![System Prompt 追蹤](https://raw.githubusercontent.com/lis186/ccxray/main/docs/system-prompt.png)

### 其他功能

- **工作階段偵測** — 自動依 Claude Code session 分組，含專案/工作目錄擷取
- **Token 記帳** — 每回合明細：input/output/cache-read/cache-create tokens、美元成本、上下文窗口使用率

## 運作原理

```
Claude Code  ──►  ccxray (:5577)  ──►  api.anthropic.com
                      │
                      ▼
                  ~/.ccxray/logs/ (JSON)
                      │
                      ▼
                  儀表板（同一連接埠）
```

ccxray 是透明的 HTTP 代理。它將請求原封不動地轉發到 Anthropic，將請求與回應記錄為 JSON 檔案，並在同一連接埠提供網頁儀表板。不需要 API 金鑰 — 它直接傳遞 Claude Code 送出的內容。

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

日誌儲存在 `~/.ccxray/logs/`，格式為 `{timestamp}_req.json` 和 `{timestamp}_res.json`。

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
