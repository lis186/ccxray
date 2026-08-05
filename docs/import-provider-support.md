# Import Provider Support Matrix

匯入本機 transcript 時，各 provider 可用的 dashboard 功能對照。
`wire (proxy)` 欄為基準（完整擷取），匯入來源依資料豐富度遞減。

> **狀態（2026-08-04 核對）**：下方矩陣與來源路徑經 `server/importer.js` 核對後仍為現狀。
> 「UI guard 規則」一節是**未實作的設計意圖**，不是現況描述——見該節警示。

| 功能 | wire (proxy) | Claude Code local | Codex local |
|---|:---:|:---:|:---:|
| Turn list（對話順序） | ✅ | ✅ | ✅ |
| Cost / model / timing | ✅ | ✅ | ✅ |
| Session / cwd / project | ✅ | ✅ | ✅ |
| Context %（input token breakdown） | ✅ | ✅ 合計值，無 system/tools 拆分 | ❌ |
| Thinking blocks | ✅ | ✅ | ❌ |
| Tool use / tool result | ✅ | ✅ | △ response_item 有部分 |
| Cache breakdown（ephemeral 5m/1h） | ✅ | ✅ | ❌ |
| stop_reason | ✅ | ✅ | ❌ |
| Conversation branching（parentUuid） | N/A | ✅ | ❌ |
| System Prompt tab | ✅ | ❌ 未存 | ❌ |
| Request tab（raw req/res） | ✅ | ❌ | ❌ |
| TTFT / streaming timeline | ✅ | ❌ | ❌ |
| Rate-limit / quota headers | ✅ | ❌ | ❌ |
| Error / retry events | ✅ | ❌ transcript 多只記成功 | ❌ |

## 來源路徑

| Provider | 路徑 | 格式 |
|---|---|---|
| Claude Code | `~/.claude/projects/<slug>/<sessionId>.jsonl` | 每行一 message，帶 `type`/`parentUuid`/`message` |
| Codex | `~/.codex*/sessions/*.jsonl` | 每行一 event（`session_meta`/`event_msg`/`response_item`/`turn_context`/`token_count`） |

**Grok 不在此表**：grok（`UPSTREAMS.xai`，#313）只有 wire 路徑，沒有本機 transcript 匯入器。
`server/importer.js` 只產出兩種 `importSource`：`'claude-code'` 與 `'codex'`。
grok 的用量統計走另一條路——`server/cost-worker.js` 的 `scanGrokFromCcxrayIndex()`
讀 ccxray 自己的 `index.ndjson`，不是匯入外部 transcript。

## UI guard 規則

> ⚠️ **未實作 — 這是設計提案，不是現況。**
> 匯入 entry 確實帶 `imported: true` + `importSource`（`server/importer.js`），
> 但前端並未依 importSource 查本表做功能降級：`public/` 對 `importSource` 只有
> 一處引用（`public/messages.js`）。缺資料的功能目前仍顯示空殼，不是提示。

原始意圖：UI 依 `importSource` 查本表，缺資料的功能顯示提示而非空殼。
若要實作，本表就是那份查找表；`imported` badge 已經在 UI 上，是可掛載的錨點。
