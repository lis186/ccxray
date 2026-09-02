# 描述被啟動 session 的事實，必須從 launch env 解析，不能從 parent process

- 發現：2026-09-03，#611 / PR #616（codex 二審 round 1 與 round 2，**同一類別連續兩輪**）
- 適用：任何 launcher 注入的 header／欄位，只要它宣稱描述「被啟動的那個 session」

## 一、缺陷形狀

`server/providers.js` 的 `claude.createLaunch({ port, args, env })` 用 `env` 參數組出 `launchEnv`，而 `server/index.js` 以 `spawn(bin, args, { env: launch.env })` 啟動子行程——**`spawn` 會完全取代子行程的環境**。因此子 Claude 解析自己的 config 目錄時看的是 `launchEnv`，即 `env.CLAUDE_CONFIG_DIR || env.HOME/.claude`。

第一版的帳號快照卻從 **parent** 讀：

```js
// round 1 的缺陷
const claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
```

結果：呼叫方若傳入不同 config dir，Claude 以帳號 A 啟動，index 卻蓋上帳號 B ——**正是這個欄位存在的目的（歸因）被破壞**。

## 二、為什麼修了一次還沒修完（本檔存在的真正理由）

round 1 只改了 `CLAUDE_CONFIG_DIR`：

```js
// round 1 的修法 —— 仍有缺陷
const claudeHome = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
```

`os.homedir()` 在 POSIX 讀 parent 的 `$HOME`。所以只要呼叫方給了不同 `HOME` 而沒給 `CLAUDE_CONFIG_DIR`，同一個缺陷就從 fallback 那條路回來，而且會去讀開發者**真實**的 `~/.claude/.claude.json`。round 2 的 P2 就是這個。

**歸因**：round 1 的派工指令逐字寫出了 `env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')`——orchestrator 指定了半套修法。實作端照做並不算失誤；**是指令把缺陷的一半當成正解寫進去了**。

教訓與 `docs/solutions/negative-claim-evidence-standard.md` 同源：修 review finding 時，若只針對「被指出的那一行」下指令，就會逐輪剝洋蔥。正確做法是**要求把不變式寫出來，並稽核同類的每一個輸入**。

## 三、不變式（照抄進註解，別重新推導）

> **帳號快照必須完全照被啟動的行程解析自己 config 的方式解析：每一個輸入都取自 launch `env`，永不取自 parent process。**

```js
const claudeHome = env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), '.claude');
```

`os.homedir()` 只保留為「呼叫方完全沒給 `HOME`」的最後手段——此時子行程也會退回 passwd entry，兩者一致。**不要「簡化」掉這層。**

反向的判斷同樣要寫下來：`getUpstreamToken()` 刻意**維持** install-scoped——upstream secret 是這個 ccxray 安裝的性質，不是被啟動 session 的設定。同一個函式裡兩種讀法並存是對的，所以必須各自註明理由，否則下一個人會把其中一個「統一」掉。

## 四、測試必須看得見這個缺陷

round 1 的測試在 `beforeEach` 設 `process.env.CLAUDE_CONFIG_DIR`，卻把 `env` 參數傳成不含該變數——於是**即使實作讀錯來源，測試照樣綠**。這是 `negative-claim-evidence-standard.md` 規則 **F**（「如果實作是假的，這條會紅嗎？」）在本 repo 的又一次發生。

可觀察的寫法是 precedence（優先序）案例，parent 與 launch 各放一個不同帳號，斷言 launch 勝出：

| 案例 | parent | launch env | 斷言 |
|---|---|---|---|
| config dir 優先序 | `CLAUDE_CONFIG_DIR`→A | `CLAUDE_CONFIG_DIR`→B | 注入 B |
| HOME fallback 優先序 | `HOME`→parent home（帳號 A） | `HOME`→launch home（帳號 B），不給 config dir | 注入 B |

兩條都以 `scripts/diff-check.sh` 取得 old FAIL / new PASS。覆寫 `process.env.HOME` 的案例要確認 `afterEach` 真的還原它——洩漏的 `HOME` 會污染同一輪後續所有測試。

## 五、可重用的檢查清單

新增任何 launcher 注入的欄位時逐項問：

- [ ] 這個值描述**被啟動的 session**，還是**這台機器／這個安裝**？兩種都合法，但要分類並註明。
- [ ] 若是前者：解析鏈上**每一個**輸入都來自 launch `env` 嗎？（config dir、`HOME`、cwd、`TMPDIR`…）
- [ ] `spawn` 是否用明確 `env` 取代子環境？是的話 parent 的值對子行程一律不可見，任何 parent 讀取都是不一致來源。
- [ ] 測試是把差異放在 **parent vs launch env** 之間，而不是靠 global 讓兩邊碰巧相同？

## 六、升級提案（同類 finding 第二次出現）

依 runbook「同類 finding 第二次出現 → 升級清單附 runbook/authoring 修訂提案」，建議在派工 prompt 模板的 review-fix 段加一句：

> 修 review finding 時，指令只給「要滿足的不變式」與「稽核範圍」，**不要逐字給出修法程式碼**——orchestrator 寫出的半套修法會被實作端忠實照做，於是同一缺陷類別逐輪剝洋蔥（#611 round 1→2 實例）。

## 相關

- `negative-claim-evidence-standard.md` — 規則 F；本案是它的第三次發生
- `index-field-addition-write-sites.md` — 同一張票的另一半：欄位寫入點與 guard 觀察點
- `configdir-allowlist-enforcement.md` — 同樣圍繞 `CLAUDE_CONFIG_DIR` 的既有討論
