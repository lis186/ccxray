# ccxray @ COSCUP 閉幕時段(10 分鐘)

`index.html` 是零依賴單檔簡報,瀏覽器直接開。為第二天下午的疲憊聽眾設計:
高橋流快節奏 + 真實故事開場 + live demo + 明確 CTA。

## 結構:七幕(英雄 = 講者本人)

| 幕 | 時間 | 內容 | 節奏提示 |
|----|------|------|----------|
| 序幕 · 大爆發 | 0:00–1:10 | 背景九連發:2026 年 2 月 Agentic Coding 大躍進、Opus 4.6 + GPT-5.3 Codex、從助手變自主工程代理、自主規劃執行自我修正、多代理協作、完整生命週期、大型專案幾小時、門檻大降 → 承接個人:「我很好奇——Agent 到底能做到什麼?」→ 日夜嘗試 → 撞上限 → 自介(「我是阿修,一個想看清楚的工程師」)| 背景頁每頁 2–3 秒機關槍鋪勢;「我很好奇——」放慢轉入個人;limit 訊息頁停 2 秒;「撞牆/又撞/再撞」連擊;「為什麼?不知道」壓低接自介 |
| 一 · 上限之謎 | 1:10–2:00 | 上限被什麼吃掉?三個問題 | 連珠炮;「上限知道」重擊 |
| 二 · 打造 X 光機 | 2:00–3:20 | ccxray + X 光點題 → **開機兩行**:`npx ccxray --port 5577` + `ANTHROPIC_BASE_URL=http://localhost:5577 claude`(使用者回饋最常忘 base URL,sub 直接點名)→ 架構五分鏡演原理 → 收尾亮一行懶人版 `npx ccxray claude` | 兩行指令各停 3 秒;「大家最常忘的就是這行」讓有經驗的人點頭;分鏡後「嫌兩行麻煩?」抖包袱亮一行版 |
| 三 · 第一張 X 光片 | 3:20–5:10 | **dashboard 導覽七頁(總—分鏡頭)**:完整畫面 → 圈 topbar → 放大(STEP 2)→ 拉回圈 columns → 放大(STEP 3)→ 拉回圈 timeline → 放大(STEP 4)——同一張全圖 zoom,空間關係不斷裂 → **LIVE DEMO**:點新 session 的 turn #1 → System 分塊 | 導覽每頁 3–5 秒,「圈」頁指著說、「放大」頁講內容;demo 是全場核心 aha:「你只說了一句話,22K 先付了;而且大部分是你自己裝的」 |
| 四 · 試煉之路 | 5:00–6:50 | 成本一目了然 + cache 20× 四分鏡 + subagent 泳道 | 三段快進 |
| 五 · 深淵 | 6:50–8:40 | smart/dumb zone + auto-compact 逐格重播 + 模型對照縮時 | 全簡報高潮;95% 定格停 3 秒 |
| 六 · 歸返 | 8:40–9:20 | 回扣二月底那個問題:上限=房租+斷 cache+塞爆 context+選錯模型;X 光哲學 | 「治不了病」重擊 |
| 終幕 · 處方箋 | 9:20–10:00 | CTA:npx 指令/「今晚照一張」/PM 丟老闆群組/repo+star | 醫療隱喻收束:X 光照完,處方箋自己開 |

## LIVE DEMO(兩段式,總計約 100 秒)

**第一段(第二幕 ~2:30,約 20 秒)**:講到「開機兩行」時,按投影片上的 ⧉ 複製按鈕
把兩行指令貼進終端執行(現場示範「照著抄就會動」),然後立刻切回投影片繼續講
架構分鏡——server 在背景暖機,不佔演講時間。
**第二段(第三幕 ~4:20,約 80 秒)**:跑指令時 dashboard 已**自動在瀏覽器打開**(這就是預設行為),LIVE 頁提示切回那個分頁做 turn #1 示範。(`D` 鍵仍保留為備用:萬一分頁被關掉可一鍵重開。)

## LIVE DEMO 細節

- **內容**:還沒開始對話,MCP 工具描述、skills、system prompt、記憶就先吃掉 context。
  點一個**新 session 的 turn #1** → 右側 System 分塊:coreInstructions [anthropic] 只佔零頭,
  customSkills / pluginSkills / mcpServersList **[user]** 佔大頭;左面板 In 22K / Usage 11%。
- **操作**:第一段跑指令時 dashboard 自動開啟;LIVE 段切回該分頁即可(備用:`D` 鍵重開 `http://localhost:5577`)。
  建議 demo 自己真實的 `~/.ccxray`(最有說服力);或會前跑 demo 資料包:
  `node tools/gen-fixture.mjs /tmp/demo /tmp/demo-home && HOME=/tmp/demo-home CCXRAY_HOME=/tmp/demo ccxray --port 5577 --no-browser`
  (side-quest 專案的 c0ffee99 session 就是為此設計的乾淨範例)。
- **Fallback**:demo 任何一步卡住,直接翻下一頁——STEP 5 就是同畫面截圖,講稿照走,零損傷。
- **複製按鈕**:五個指令/URL 頁右上有 ⧉(點擊複製、✓ 回饋、不觸發翻頁;code 頁可直接選字)。
  聽眾開同一份簡報也能照按——「我做一遍,你們照著做」零打字零打錯。
- **排練清單**:終端先開好、字體調大 ✓ 兩行指令現場貼上跑一次 ✓ 簡報 hash 記頁碼(切走可回)✓
  `D` 鍵測過 ✓ 投影機解析度下 System 分塊字體可讀 ✓

## 給講者的其他鍵

`→`/空白/點右側翻頁 · `←` 倒退(分鏡會反向動畫)· `A` 自動播放 · `D` 重開 dashboard(備用)· hash 記頁碼

## 視覺步驟(全部真實畫面;僅架構分鏡為線框)

STEP 1 架構分鏡×5(FLIP)| 2–4 dashboard 導覽分鏡×7(全圖→圈選→放大,同一張全圖 zoom)| **5 turn #1 隱形房租(demo fallback)**
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
自介頁名字在 deck-template.html 搜「阿修」修改;副標「想看清楚的工程師」可自行調整。

## 設計原則

- 示範介面 = 實際介面(截圖頁標「實際畫面」;分鏡標「架構示意」;demo 直接真的來)。
- 一頁一個念頭;分鏡連續性(#pxroot/#cxroot/#acroot/#mcroot 跨頁同 DOM,倒退反向動畫)。
- 首尾閉環:二月底撞上限開場 → 歸返幕逐項回答;npx 出現兩次(神器/處方)。
- X 光隱喻三落點:點題(造 X 光機)→ 伏筆(選擇 X 光不會替你做)→ 收束(照得出病灶,治不了病,判斷在你)。

> 註:投影片內中文標點一律全形(英文訊息、指令、URL、時間戳保持半形)。
