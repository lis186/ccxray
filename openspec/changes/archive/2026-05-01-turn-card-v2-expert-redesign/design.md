## Context

四位資訊設計專家（Tufte / Few / Ware / Victor）獨立評審後的共識：

- **Ware**：status 應編碼到 position channel（左邊）而非小 dot，利用 peripheral vision
- **Tufte**：移除 chartjunk（emoji、`·` 分隔符）、直接 label 勝過圖例
- **Few**：color 是稀缺資源、應給 exception；normal state 必須 recede
- **Victor**：cache composition 是 cost 的成因訊號，不該消失

前版 `turn-card-redesign` 在視覺層次上有進步，但在 pre-attentive、composition、時間語意三個維度仍有缺口。v2 在此基礎上追加 UX 評審，確立最終規格。

## Goals / Non-Goals

**Goals:**
- 成本在第一行右側，掃描路徑必然經過
- 全寬 ctx bar 同時顯示 context 佔用與 cache hit rate，兩者有明確微標籤
- Critical 風險升到第一行（不漏看）；warning/notice 留在底部（降低噪音）
- 時間資訊明確：elapsed / wait / think 各自有語意前綴
- Subagent 以 `↳` 明示「從屬關係」，不只是縮排
- 無 emoji（risk 改用純文字標籤）

**Non-Goals:**
- 不實作 session KPI 條（先不做）
- 不實作 trajectory sparkline（延後）
- 不改 server 端資料結構

## Layout

### 主 agent turn（最多五行）

```
│ #65  sonnet-4-6  ●  !max            $0.03 │  Line 1: 識別 + critical risk + 成本
│ Refactor auth middleware for GitHub login  │  Line 2: title（null 時省略）
│ ██████████████████████████████████████████│  Line 3: ctx bar 全寬
│                          ctx:42%  hit:86% │         標籤小字右下角
│ 9.6s  wait:11s  think:4.4s  Bash Read     │  Line 4: 時間 + tools
│ cred  tool-fail  dupes×3                  │  Line 5: warning/notice risk（有才顯示）
```

無 critical 時 line 1 不含 risk 標籤：

```
│ #65  sonnet-4-6  ●                  $0.03 │
│ Refactor auth middleware for GitHub login  │
│ ██████████████████████████████████████████│
│                          ctx:42%  hit:86% │
│ 9.6s  wait:11s  Bash Read                 │
│ cred  tool-fail                           │
```

無任何 risk 時 line 5 整行省略：

```
│ #65  sonnet-4-6  ●                  $0.03 │
│ Refactor auth middleware for GitHub login  │
│ ██████████████████████████████████████████│
│                          ctx:42%  hit:86% │
│ 9.6s  Bash Read                           │
```

title 為 null 時 line 2 省略（card 最少兩行）。

### Subagent turn

```
│ ↳s1  sonnet-4-6  ●                  $0.01 │  ↳ 代表從屬關係
│   Agent invocation                         │
│   ████████████████████████████████████████│  bar 與 ↳ 對齊縮排
│                         ctx:12%  hit:94%   │  標籤小字右下角
│   5.2s  Bash Read                          │
```

## Decisions

### 1. 五行版型

- **Line 1** turn#（主用 `#N`、subagent 用 `↳sN`）、model、status dot `●`、critical risk 標籤（有才顯示）、成本（右對齊）
- **Line 2** 僅 title；null 則整行省略
- **Line 3** 全寬 ctx bar + `ctx:NN%  hit:NN%`
- **Line 4** 時間欄位 + tools
- **Line 5** warning/notice risk 標籤；無 risk 則整行省略

### 2. Severity 三層與左色條

三層 severity taxonomy，同時作用於左色條與 context% 顏色：

| Tier | CSS token | 觸發條件 |
|------|-----------|---------|
| `critical` | `.risk-critical`（紅） | ctx > 95% / HTTP 非 2xx / abnormal stop |
| `warning` | `.risk-warning`（橙） | ctx 85–95% / `hasCredential` / `toolFail` |
| `notice` | `.risk-notice`（黃） | `duplicateToolCalls` |
| — | 無 | 以上皆無 |

左色條：2px 寬、整張 card 高度、靠左。

### 3. Risk 訊號分層呈現（方案 C）

Critical 訊號升到 line 1，緊跟在 `●` 後面、成本左邊。Warning / notice 留在 line 5。

**Critical markers（出現在 line 1）：**

| Signal | Marker |
|--------|--------|
| `stopReason === 'max_tokens'` | `!max` |
| `stopReason === 'length'` | `!len` |
| 其他非 `end_turn`/`tool_use` | `!stop` |
| `stopReason === 'content_filter'` | `!filter` |
| HTTP 非 2xx | `!http` |

- 最多顯示一個 critical marker（最高優先序）；若有多個 critical 以優先序取第一個，其餘摺疊進 line 5
- 無 critical 時 line 1 的 marker 位置完全隱藏（不留空格）
- 成本永遠右對齊，不因 marker 存在而位移

**Warning / notice markers（出現在 line 5）：**

| Signal | Tier | Marker |
|--------|------|--------|
| `hasCredential` | warning | `cred` |
| `toolFail` | warning | `tool-fail` |
| `duplicateToolCalls` | notice | `dupes×N`（N = 最多重複的工具總呼叫次數） |

- 多個 warning/notice 依序排列，空格分隔
- Overflow（>5 個）時後面摺疊為 `+N`
- 無 warning/notice 且 critical 已在 line 1 時，line 5 不出現
- 無任何 risk 時 line 5 整行省略

**不使用 emoji**。所有 marker 為純 ASCII 文字。

### 4. 全寬 ctx bar（Line 3）

Line 3 是一條佔滿 card 寬度的彩色橫條，標籤以小字沉在 bar 右下角：

```
██████████████████████████████████████████████
                                ctx:42% hit:86%
```

- Bar 全寬延伸，三色 segment：cache-read（青）/ cache-write（橙）/ input（紫）
- 標籤位於 bar 正下方右對齊，字級比 bar 更小（輔助確認用）
- `ctx:NN%` = 當前 context window 使用率（`ctxUsed / maxContext`），顏色隨 severity tier 變色
- `hit:NN%` = cache hit rate（`cache_read / total_tokens`），固定青色（與 bar 同色系）
- Tooltip on bar：精確 token 數 + 各類百分比
- 隱藏條件：usage 為 null 或 total tokens = 0 時整行隱藏

### 5. 時間欄位（Line 4）

格式：`{elapsed}  [wait:{gap}]  [think:{thinking}]  {tools}`

- `elapsed`：本 turn 耗時（`e.elapsed + 's'`），永遠顯示
- `wait:N`：與上一個 turn 的 idle gap，顏色隨 cache warmth（綠 < 5m、黃 5m–1h、紅 > 1h）；無前一 turn 時省略
- `think:N`：extended thinking 耗時；無 thinking 時省略
- `tools`：tool chip 列表，最多 3 個，超出折疊為 `+N`

### 6. Subagent 識別

Subagent 以 `↳sN` 前綴（N = session 內 subagent 序號），明示從屬關係。主 turn 用 `#N`。

- `↳` 在字型中渲染為向右下的箭頭，清楚表示「由上層呼叫」
- Subagent 永遠顯示 model name（不受省略規則影響）
- Line 3 bar 與 `↳` 對齊縮排，使層次感延伸到 bar

### 7. ↵ 等待指示符

`↵` 出現在 line 1 的 `●` 之後（stop reason 為 `end_turn` 時），表示 Claude 等待用戶回應。

### 8. Model 省略規則

同 session 內，當前主 turn 與上一個主 turn 使用同一 model，且相隔 ≤ 5 entries，則省略 model name。Subagent 永遠顯示。

### 9. 移除的元素

- `.turn-risk` layer → 移除；risk 改分層到 line 1 / line 5
- `.compact-badge`、`.inferred-badge`、`.turn-meta` → 移除；compact/inferred 僅掛 `title` tooltip
- `·` 分隔符 → 完全移除，用 CSS gap
- Emoji → 全部移除，改純文字縮寫

## Risks / Trade-offs

- **Critical 在 line 1 空間擠壓**：成本永遠右對齊，critical marker 在成本左側，若 marker 文字長（最長 `!filter`，7 chars）需測試是否擠壓 model name
- **Cache hit rate 標籤新增**：`hit:NN%` 標籤增加少量寬度，需確認窄視窗下不截斷
- **Wait/think 語意學習成本**：`wait:` / `think:` 前綴需要一次性學習，接受此 trade-off（初次 hover 可用 tooltip 補充）
- **Line 5 在底部**：warning/notice 可能被忽略，但 critical 已升到 line 1，此 trade-off 可接受
