# ccxray @ COSCUP 閉幕時段(10 分鐘)

`index.html` 是零依賴單檔簡報,瀏覽器直接開。為第二天下午的疲憊聽眾設計:
高橋流快節奏 + 真實故事開場 + live demo + 明確 CTA。

## 結構:七幕(英雄 = 講者本人)

| 幕 | 時間 | 內容 | 節奏提示 |
|----|------|------|----------|
| 序幕 · 除夕夜 | 0:00–0:50 | 過年 vibe coding 撞上限的真實故事;自介融入(「我是 Justin,一個不服氣的工程師」)| 「過年/圍爐/vibe coding」三連發輕鬆開場;usage limit 訊息頁停 2 秒讓全場會心;「撞牆/又撞/再撞」機關槍 |
| 一 · 上限之謎 | 0:50–1:40 | 上限被什麼吃掉?三個問題 | 連珠炮;「上限知道」重擊 |
| 二 · 打造 X 光機 | 1:40–2:50 | ccxray + X 光點題 + npx + 架構五分鏡 | code 頁停 4 秒拍照 |
| 三 · 第一張 X 光片 | 2:50–5:00 | STEP 2-4 看見 → **LIVE DEMO**:點新 session 的 turn #1 → System 分塊 | demo 是全場核心 aha:「你只說了一句話,22K 先付了;而且大部分是你自己裝的」 |
| 四 · 試煉之路 | 5:00–6:50 | 成本一目了然 + cache 20× 四分鏡 + subagent 泳道 | 三段快進 |
| 五 · 深淵 | 6:50–8:40 | smart/dumb zone + auto-compact 逐格重播 + 模型對照縮時 | 全簡報高潮;95% 定格停 3 秒 |
| 六 · 歸返 | 8:40–9:20 | 回扣除夕夜:上限=房租+斷 cache+塞爆 context+選錯模型;X 光哲學 | 「治不了病」重擊 |
| 終幕 · 處方箋 | 9:20–10:00 | CTA:npx 指令/「今晚照一張」/PM 丟老闆群組/repo+star | 醫療隱喻收束:X 光照完,處方箋自己開 |

## LIVE DEMO(2:50 段內,約 90 秒)

- **內容**:還沒開始對話,MCP 工具描述、skills、system prompt、記憶就先吃掉 context。
  點一個**新 session 的 turn #1** → 右側 System 分塊:coreInstructions [anthropic] 只佔零頭,
  customSkills / pluginSkills / mcpServersList **[user]** 佔大頭;左面板 In 22K / Usage 11%。
- **操作**:簡報 LIVE 頁按 **`D`** 直接開 `http://localhost:5577`(講者本機 hub)。
  建議 demo 自己真實的 `~/.ccxray`(最有說服力);或會前跑 demo 資料包:
  `node tools/gen-fixture.mjs /tmp/demo /tmp/demo-home && HOME=/tmp/demo-home CCXRAY_HOME=/tmp/demo ccxray --port 5577 --no-browser`
  (side-quest 專案的 c0ffee99 session 就是為此設計的乾淨範例)。
- **Fallback**:demo 任何一步卡住,直接翻下一頁——STEP 5 就是同畫面截圖,講稿照走,零損傷。
- **排練清單**:會前開好 server 分頁 ✓ 簡報 hash 會記頁碼(中斷可回)✓ `D` 鍵測過 ✓
  投影機解析度下 System 分塊字體可讀 ✓

## 給講者的其他鍵

`→`/空白/點右側翻頁 · `←` 倒退(分鏡會反向動畫)· `A` 自動播放 · `D` 開 dashboard · hash 記頁碼

## 視覺步驟(全部真實畫面;僅架構分鏡為線框)

STEP 1 架構分鏡×5(FLIP)| 2 topbar | 3 columns | 4 timeline steps | **5 turn #1 隱形房租(demo fallback)**
| 6 成本+Usage($258/日均,30 天攀升曲線)| 7 cache 過期分鏡×4(原生閃爍)| 8 subagent 泳道
| 9 auto-compact 逐格重播×6(26 幀真實 render)| 10 模型對照縮時×3(講者真實 session 原圖)| 11 完整 dashboard

## 重現管線

```bash
node tools/gen-fixture.mjs /tmp/ccxray-demo /tmp/ccxray-demo-home
HOME=/tmp/ccxray-demo-home CCXRAY_PLAN=max5x CCXRAY_HOME=/tmp/ccxray-demo ccxray --port 5602 --no-browser
node tools/gen-spiral.mjs /tmp/ccxray-spiral && node tools/shoot-spiral.mjs
node tools/build-deck.mjs
```

務必同時隔離 `CCXRAY_HOME` 和 `HOME`(cost-worker 掃 `$HOME/.claude*`,不隔離會把自己的真實帳單掃進 Usage 頁)。
所有金額由 `server/default-rates.js` 費率表對合成 token 計算,不手填;fable-5 主 session 38% of 1M、
Usage 歷史正規化到 avg $258/day、cache 20× = 1h 重建 2× ÷ 命中 0.1×。
自介頁名字在 deck-template.html 搜「Justin」修改。

## 設計原則

- 示範介面 = 實際介面(截圖頁標「實際畫面」;分鏡標「架構示意」;demo 直接真的來)。
- 一頁一個念頭;分鏡連續性(#pxroot/#cxroot/#acroot/#mcroot 跨頁同 DOM,倒退反向動畫)。
- 首尾閉環:除夕夜撞上限開場 → 歸返幕逐項回答;npx 出現兩次(神器/處方)。
- X 光隱喻三落點:點題(造 X 光機)→ 伏筆(選擇 X 光不會替你做)→ 收束(照得出病灶,治不了病,判斷在你)。
