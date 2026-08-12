# 新增 INDEX_FIELDS 欄位：五個寫入點、兩個刻意不蓋、一個看不到的接縫

- 發現：2026-08-11，#504 / PR #512
- 適用：任何要往 `INDEX_FIELDS` 加欄位的票

## 一、`null` 與 `undefined` 在這裡不是風格問題

`buildIndexLine` 的投影條件是 `entry[k] !== undefined`，所以 **`null` 會被寫出**。若新欄位的「無值狀態」是 `null`（例如 `helpers.extractDuplicateToolCalls` 無重複時回 `null`，且三個站點硬寫 `duplicateToolCalls: null`），把它加進 `INDEX_FIELDS` 會讓幾乎每一行 index 都多出 `"key":null`。

`server/entry.js` 的 `OMIT_IF_NULL` 是這個問題的單點解：登記在內的 key 同時跳過 `undefined` 與 `null`。既有欄位**刻意不**登記——它們照舊寫 `null`，這正是 add-only guard 得以成立的前提。

同族問題見 ADR 0018（`turnToolCalls` 的 `null` / `{}` / 非空三態），那裡的「沒有值」有三種寫法而每種被不同消費端賦予不同語意。

## 二、index 寫入點是五個，不是一個

```
server/forward.js      ×4   HTTP：anthropic SSE / openai SSE / non-SSE ×2
server/ws-proxy.js     ×1   codex 主 session（/v1/responses 升級為 WebSocket）
server/rebuild-index.js ×1  從倖存的 _req/_res 重建
server/importer.js     ×1   從其他工具的 transcript 匯入
```

只改 `forward.js` 會漏掉 codex 的主要流量——CLAUDE.md 明載 codex 正常對話走 WebSocket 升級，不是 `/v1/realtime`。#504 第一版就漏了這一個，由 codex 二審 P1 抓到。

後兩個（`rebuild-index` / `importer`）**刻意不蓋**部署身分類欄位：它們重建或匯入的是歷史 turn，把當前機器的身分蓋上去是誤標，不是補完。這個判斷要寫進 commit message，否則下一個人會以為是漏的。

## 三、guard 掛在哪個接縫上，決定它看不看得見違反

#504 的 guard 是「未設定任何新 env var 時，index 行與變更前逐 byte 相同」。第一版測試這樣寫：

```js
buildIndexLine(entry)   // ← 看不到違反
```

但真實寫入路徑是**建構處先展開、投影在後**：

```js
buildIndexLine({ ...entry, ...deploymentFields(startTime) })   // ← 違反在這裡
```

`deploymentFields` 在 `forward.js` 與 `ws-proxy.js` 的 entry literal 裡展開，所以只餵 `buildIndexLine` 的斷言**在結構上不可能**觀察到「新欄位無條件出現」。第一版因此在真實路徑上每行多 44 bytes，而它自己的 G2 測試報綠。

這是 [`negative-claim-evidence-standard.md`](negative-claim-evidence-standard.md) 規則 **F**（「如果實作是假的，這條會紅嗎？」）與實例 **2-3**（「測試必須驅動真實入口，不是自己擺好終局狀態」）的第二次發生。規則早就寫下來了，仍然被違反——因為 issue 的 guard 只寫了**性質**（逐 byte 相同），沒寫**觀察點**（哪個函式產出的那一行）。

寫 guard 指標時把觀察點寫進去，錯誤的接縫就寫不出來。

這次改寫的結論是採用投影式契約：對所有 production index 寫入路徑，把新版輸出投影回變更前欄位集合與順序後做 byte 級比較；而觀察點必須是真實建構路徑，不能直餵 `buildIndexLine()` 或用 regex 掃原始碼替代。

## 相關

- ADR 0012（`_foldEntry` 的 prefer-non-null 合併清單；`duplicateToolCalls` 已在內，#504 的其餘 6 個欄位是同機常數故未加）
- ADR 0013（persist the fact, derive the view——4 個 env 欄位與 `tz` 都是 fact：`tz` 是該機器寫入當下的時區，無法由任何其他欄位重建，事後補不回來。`localDate` 則是 `f(receivedAt, tz)` 的推導值，逐行儲存屬廉價 denormalization（約 25 bytes/行），owner 明示保留以便分析端不必自算 UTC 邊界）
- ADR 0018（`turnToolCalls` 的 null-vs-empty 契約）
