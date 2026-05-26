## V3 Turn Card — Implementation Tasks

### 1. CSS — Severity left border (2px)

- [x] 1.1 `.turn-item` 改 `border-left: 2px solid transparent`（原為 3px）
- [x] 1.2 新增 `.turn-item.risk-critical { border-left-color: var(--red) }`、`.risk-warning { --color-warning }`、`.risk-notice { --color-yellow }`
- [x] 1.3 `.turn-sub` 移除 `border-left-color: transparent !important`，讓嚴重性色條可正常顯示；保留 `.turn-sub.selected` 的橙色高亮

### 2. CSS — Identity line: cost 右對齊 + critical marker

- [x] 2.1 `.turn-item .turn-cost` 加 `margin-left: auto; flex-shrink: 0;`（cost 永遠在 identity line 最右）
- [x] 2.2 新增 `.turn-critical-marker { font-size: 10px; color: var(--red); font-weight: bold; flex-shrink: 0; }`
- [x] 2.3 移除 `.turn-item .turn-sep`（不再使用 `·` 分隔符）

### 3. CSS — Full-width ctx bar + dual labels

- [x] 3.1 `.turn-ctx-bar-bg` 高度改為 `4px`，保持 `display: flex`、無寬度限制
- [x] 3.2 新增 `.turn-ctx-labels { display: flex; justify-content: flex-end; gap: 6px; font-size: 9px; margin-top: 1px; line-height: 1; }`
- [x] 3.3 `.turn-ctx-pct` 改為無預設 color（顏色由子 class 控制）；新增 `.turn-ctx-pct.ctx-critical { color: var(--red) }`、`.ctx-warning { color: var(--yellow) }`、無 class 時 `color: var(--dim)`
- [x] 3.4 新增 `.turn-hit-pct { color: var(--color-cache-read); }`

### 4. CSS — Secondary line: wait/think，Line 5: risk

- [x] 4.1 `.turn-item .turn-secondary` 移除 `gap: 5px`，改 `gap: 6px`，`flex-wrap: nowrap`
- [x] 4.2 新增 `.turn-wait-gap { white-space: nowrap; }`
- [x] 4.3 新增 `.turn-think { color: var(--purple); white-space: nowrap; }`
- [x] 4.4 新增 `.turn-risk-line { font-size: 9px; color: var(--dim); margin-top: 2px; }`

### 5. CSS — Dead code cleanup

- [x] 5.1 移除 `.cred-badge`、`.dupe-badge`、`.tool-fail-badge`、`.max-tokens-badge`
- [x] 5.2 移除 `.sub-indent`
- [x] 5.3 移除 `.turn-item .turn-risk`（舊 risk badges layer）
- [x] 5.4 移除 `.turn-item .turn-meta`

### 6. JS — Helper functions

- [x] 6.1 新增 `isAbnormalStop(stopReason)` — 非 `end_turn`/`tool_use`/空字串 即為 abnormal
- [x] 6.2 新增 `classifySeverity(entry, ctxPct)` — `critical | warning | notice | null`；precedence：ctx>95%/HTTP非2xx/abnormal stop → ctx>85%/cred/toolFail → dupes → none
- [x] 6.3 新增 `getCriticalMarker(stopReason, httpStatus, ctxPct)` — 依優先序回傳 `!http`/`!max`/`!len`/`!stop`/`!filter` 或 null；ctx>95% 回傳 null（只靠左條）
- [x] 6.4 新增 `shouldOmitModel(curIdx, sessionId, model)` — 查詢 allEntries，找上一個同 sessionId 且非 subagent 的主 turn；距離 ≤5 且 model 相同則省略

### 7. JS — Render: Line 1 (identity + critical marker + cost)

- [x] 7.1 套用 `classifySeverity` 到 `el.className`（`risk-critical`/`risk-warning`/`risk-notice`）
- [x] 7.2 Prefix：主 turn → `#N`，subagent → `↳sN`；移除舊 `╎` indent
- [x] 7.3 `shouldOmitModel` 控制 model span 顯示（subagent 永遠顯示）
- [x] 7.4 `●` 狀態點（ok/err），`↵` 當 `stopReason === 'end_turn'`
- [x] 7.5 `getCriticalMarker` 決定 line 1 的 critical marker（最多 1 個）
- [x] 7.6 Cost span 移到 identity line，`margin-left: auto` 右對齊
- [x] 7.7 Compact/inferred 僅放 `title` tooltip，不渲染可見文字

### 8. JS — Render: Line 3 (full-width ctx bar + ctx:% hit:%)

- [x] 8.1 Segment 寬度改用 `tokens / totalUsed * 100%`（全寬比例），`min-width: 2px`
- [x] 8.2 `ctx:NN%` label：severity class 控色（`ctx-critical`/`ctx-warning`/無），前綴 `ctx:`
- [x] 8.3 `hit:NN%` label：`ctxCacheRead / totalUsed * 100`，只有 cache_read > 0 才顯示
- [x] 8.4 隱藏條件：`totalUsed === 0` 時整行省略
- [x] 8.5 Tooltip：bar hover 顯示精確 token 數與各類百分比

### 9. JS — Render: Line 4 (time + tools, no cost)

- [x] 9.1 Elapsed 永遠顯示：`{N}s`
- [x] 9.2 Gap 改格式：`wait:{gap}` 彩色（gapColor 已有）；無前一 turn 時省略
- [x] 9.3 Thinking 改格式：`think:{N}s`（無 emoji）
- [x] 9.4 Tool chips 最多 3 個，超出折疊為 `+N`
- [x] 9.5 Cost 從 secondary 移除（已在 line 1）
- [x] 9.6 各項目 space-only 間距（無 `·` 分隔符）

### 10. JS — Render: Line 5 (warning/notice risk, no emoji)

- [x] 10.1 `hasCredential` → `cred`
- [x] 10.2 `toolFail` → `tool-fail`
- [x] 10.3 `duplicateToolCalls` → `dupes×N`（N = 最高重複次數），N < 2 不顯示
- [x] 10.4 順序：`cred` → `tool-fail` → `dupes×N`；空格分隔
- [x] 10.5 無任何 warning/notice 時，整行省略
- [x] 10.6 確認無 emoji（純 ASCII）

### 11. Verification

- [x] 11.1 `node --check public/entry-rendering.js` 語法檢查
- [x] 11.2 `npm test` 通過
- [ ] 11.3 啟動 dev server，browser 驗證：
  - [ ] 11.3.1 正常 turn：無左色條，ctx bar 全寬，`ctx:NN% hit:NN%` 小字在 bar 右下
  - [ ] 11.3.2 Subagent turn：`↳s1` prefix，model 永遠顯示，ctx bar 全寬
  - [ ] 11.3.3 Tool-fail turn：左條橙色，line 5 顯示 `tool-fail`（無 ⚠ emoji）
  - [ ] 11.3.4 max_tokens turn：`!max` 在 line 1 cost 左側，左條紅色
  - [ ] 11.3.5 時間行：`9.6s  wait:11s  Bash Read`（語意前綴，無 ⏸/🧠）
  - [ ] 11.3.6 連續同 model 距離 ≤5：model name 省略；距離 >5 或換 model：重現
