# Fix `turns left` prediction (severe overestimate)

## Why

Dashboard 的 Sessions card 底下的 `≈N turns left` 預測常常離譜高估，最壞到 10 倍以上。

實例（2026-04-19 觀察）：

| Session | Model | 實際 turns | tokens 用量 | Context 使用率 | 顯示 | 合理估計 |
|---|---|---|---|---|---|---|
| `317f419d` | haiku-4-5 | 167 | 166,741 / 200,000 | 83% | **≈367** | ~34 |
| `239986d4` | opus-4-7 | 236 | — | — | **≈3535** | << 100 |

317f419d 右側 timeline 明確顯示 `"This session is being continued from a previous conversation that ran out of context. Context: 85.5% (170,986 / 200,000)"`——已經 compaction continue，context 即將耗盡，卻預測還能跑 367 回合。

## Root cause (5-why)

1. **顯示 367 而不是 ~34**：`predictRemainingTurns` 只用最後 5 回合的 `tokens.messages` 增量當速率。最後 5 回合剛好是輕量活動（cache hit 98%、短 Bash / 確認類）→ avgDelta ≈ 93 tokens/turn，但 session-wide 平均是 166,741 / 167 ≈ 994 tokens/turn，差 10 倍。
2. **為什麼最後 5 回合這麼輕**：是 session **末期局部特徵**，不是整場代表值。活動有 spiky pattern（大 bash output、檔案 diff、思考 block），window size=5 無法吸收方差。
3. **為什麼 window=5 且用平均**：假設 recency 最能預測 near-term；5 是沒驗證過的 magic number，mean 對 spike 不抗。
4. **compaction session 更嚴重**：`isCompacted` flag 若未被正確標上 → `startIdx=0` 讓 `.slice(-5)` 抓到 5 筆末尾輕量 turn；就算 flag 正確，post-compaction prefix turns 本就偏輕，5 筆完全涵蓋在這階段。兩條路徑都讓 avgDelta 過低。
5. **為什麼一直沒被發現**：預測的輸出**從不跟實際結果比對**，沒 sanity cap（例如 `Math.min(result, 99)`）、沒 unit test、沒 backtest。只有數字爆到 367/3535 這等級才肉眼抓到。

**核心**：單一小窗口（5 筆）× 缺 sanity cap × compaction 檢測不可靠三者疊加，末端輕量 turn 直接把 avgDelta 打成整段平均的 1/10，除法後產生 10x 高估。

## Current code

`public/miller-columns.js:654-687`:

```js
function predictRemainingTurns(sid) {
  const turns = allEntries.filter(e =>
    e.sessionId === sid && !e.isSubagent &&
    e.usage && (e.usage.input_tokens || 0) > 0 &&
    e.tokens && e.tokens.messages > 0
  );
  if (turns.length < 3) return null;

  let startIdx = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].isCompacted) { startIdx = i; break; }
  }
  const recent = turns.slice(startIdx);
  if (recent.length < 2) return null;

  const window = recent.slice(-5);                            // ← 只用 5 筆
  const deltas = [];
  for (let i = 1; i < window.length; i++) {
    deltas.push((window[i].tokens.messages || 0) - (window[i - 1].tokens.messages || 0));
  }
  const avgDelta = deltas.reduce((s, d) => s + d, 0) / deltas.length;  // ← 純平均
  if (avgDelta <= 0) return null;

  const last = recent[recent.length - 1];
  const maxCtx = last.maxContext || DEFAULT_MAX_CTX;
  const currentTotal = (last.tokens.system || 0) + (last.tokens.tools || 0) + (last.tokens.messages || 0);
  const remaining = maxCtx - currentTotal;
  if (remaining <= 0) return 0;

  return Math.round(remaining / avgDelta);                     // ← 無 cap
}
```

`public/miller-columns.js:726-731`（呼叫端 + 顏色閾值）:

```js
function renderPredictionRow(sid) {
  const remaining = predictRemainingTurns(sid);
  if (remaining === null) return '';
  const color = remaining <= 3 ? 'var(--red)' : remaining <= 8 ? 'var(--yellow)' : 'var(--dim)';
  return '<div style="font-size:10px;color:' + color + ';margin-top:2px">≈' + remaining + ' turns left</div>';
}
```

## What Changes

三個尺度的修法，建議階段推進：

### 🟢 A. 最小修補（< 10 行）

核心：**不准 avgDelta 低於整段 session 平均的一半**，並加 sanity cap。

```js
// 在 return 前插入
const sessionAvg = currentTotal / turns.length;
const stableAvg = Math.max(avgDelta, sessionAvg * 0.5);
return Math.min(Math.round(remaining / stableAvg), 99);
```

預期：317f419d 的 367 → ~34；3535 被 cap 到 99。

### 🟡 B. 中等修補（~20-30 行）

- window 從 5 擴到 min(20, recent.length)
- 平均改中位數（對 spike robust）
- 加 compaction fallback：當 B1/B2 含 `"continued from a previous conversation"` 但 `isCompacted` 未標時補標
- 保留 A 的 sanity cap

### 🔴 C. 改顯示邏輯（重新設計 UI）

- 以最近 N 回合 token 消耗的 P50 / P80 算樂觀 / 悲觀邊界
- UI 從 `≈367 turns left` 改成 `~8-34 turns left` 表示區間
- 更誠實反映不確定性，但 session card 空間有限需重排版

## Validation

修完後以真實資料回測：

1. 撈 `~/.ccxray/logs/` 裡**已結束**的 sessions（end_turn / context 爆掉）
2. 對每個 session 的第 k 回合，跑 `predictRemainingTurns` 取預測值
3. 跟實際「從第 k 回合到 session 結束還跑了幾回合」對比
4. metric: median absolute percent error
5. 目標：median 誤差 <50%，worst case 不超過 2x 高估

可用 `test/agent-classify-eval.js` 同款架構寫 `test/predict-eval.js`。

## Impact

- `public/miller-columns.js:654-687` — `predictRemainingTurns`
- `public/miller-columns.js:726-731` — `renderPredictionRow`（未改，但需確認 cap 後顏色閾值仍合理）
- 相關待查：
  - `server/helpers.js` — `tokens.messages` 的確切定義（是整段 messages token 總數、不是 delta；確認就好）
  - `server/store.js` / `server/helpers.js` — `isCompacted` 的判斷邏輯（bug 放大器，需同步補強）

## Release timing

當前 v1.6.0 已 commit（`d62fd5b`）但未 push / publish：

- **(a)** A 塞進 1.6.0：`git commit --amend` 合併、tag 不動（未推出，amend 安全）
- **(b)** 1.6.0 先發，A 作為 1.6.1 patch：新 commit + bump version

建議 **(a)**，因為 367/3535 這種顯示會嚴重影響 first impression，值得卡發布補上最小修補。
