# ccxray @ COSCUP 閉幕時段(10 分鐘)

`index.html` 是零依賴單檔簡報,瀏覽器直接開。為第二天下午的疲憊聽眾設計:
高橋流快節奏 + 真實故事開場 + live demo + 明確 CTA。

## 結構:七幕(英雄 = 講者本人)

| 幕 | 時間 | 內容 | 節奏提示 |
|----|------|------|----------|
| 序幕 · 大爆發 | 0:00–1:10 | 背景九連發:2026 年 2 月 Agentic Coding 大躍進、Opus 4.6 + GPT-5.3 Codex、從助手變自主工程代理、自主規劃執行自我修正、多代理協作、完整生命週期、大型專案幾小時、門檻大降 → 承接個人:「我很好奇——Agent 到底能做到什麼?」→ 日夜嘗試 → 撞上限 → 自介(「我是阿修,一個想看清楚的工程師」)| 背景頁每頁 2–3 秒機關槍鋪勢;「我很好奇——」放慢轉入個人;limit 訊息頁停 2 秒;「撞牆/又撞/再撞」連擊;「為什麼?不知道」壓低接自介 |
| 一 · 上限之謎 | 1:10–2:00 | 上限被什麼吃掉?三個問題 | 連珠炮;「上限知道」重擊 |
| 二 · 打造 X 光機 | 2:00–3:20 | ccxray + X 光點題 → **開機兩行**:`npx ccxray --port 5577` + `ANTHROPIC_BASE_URL=http://localhost:5577 claude`(使用者回饋最常忘 base URL,sub 直接點名)→ 架構五分鏡演原理 → 收尾亮一行懶人版 `npx ccxray claude` | 兩行指令各停 3 秒;「大家最常忘的就是這行」讓有經驗的人點頭;分鏡後「嫌兩行麻煩?」抖包袱亮一行版 |
| 三 · 第一張 X 光片 | 3:20–5:10 | **dashboard 導覽七頁(總—分鏡頭)**:完整畫面 → 圈 topbar → 放大(STEP 2)→ 拉回圈 columns → 放大(STEP 3)→ 拉回圈 timeline → 放大(STEP 4)→ **LIVE DEMO**:點新 session 的 turn #1 → Cost → 揭曉「這個 session 我**故意裝好裝滿**」(28 個 MCP、22 個 skills、CLAUDE.md、記憶)→ **稅單導覽十二頁(STEP 5)**:回放 → 圈 turn → 圈 Cost → 放大(**In 99K,$1.02**)→ Cost 分頁稅單攤開 → 圈 skills/記憶/CLAUDE.md 區塊 → 放大(skills 12,770 tok)→ 圈 28 個 MCP bars → 放大 → 固定稅總結(**96,947 tok = 48.5%**)→ 圈 0-uses 點名牆 → 放大 | demo 是全場核心 aha:「你只說了一句話,$1 就沒了」;收在三連擊「全是行前簡報 → MCP/skills/CLAUDE.md/記憶是你自己塞進去的 → 用不到的就刪掉」(清理敘事只點名使用者可控項,不碰 system prompt/內建 tools) |
| 四 · 試煉之路 | 5:00–6:50 | **成本導覽七頁(STEP 6)**:回到 dashboard → 圈專案欄 → 放大($6.80)→ 圈 session 卡 → 放大 → 圈 turn Cost → 放大($0.5464)→ 切 Usage 頁「每日也記著」→ cache **過期** 20×:官方價目表三分鏡(圈 Fable 5 列 → 放大 cache 兩欄:1h 重建 $20 vs 命中 $1)→ cache 倒數四分鏡 | 專案/session/turn 三層帳「越點越細」(試煉一);官方頁佐證讓 20× 不是口說(試煉二) |
| 五 · 深淵 | 6:50–8:40 | smart/dumb zone + auto-compact 逐格重播 → 解方「分工給 subagent」→ Subagent 亂舞?泳道時間軸(STEP 8)→ 但分工也要選對模型 → 模型對照縮時 | 全簡報高潮;95% 定格停 3 秒;泳道緊跟在「分工」之後,回答「誰生了誰」 |
| 六 · 歸返 | 8:40–9:20 | 回扣二月底那個問題:上限=行前簡報+過期 cache+塞爆 context+選錯模型;X 光哲學 | 「治不了病」重擊 |
| 終幕 | 9:20–10:00 | CTA:「總之——平常用 Agent,先掛上 ccxray」→ `npx ccxray claude` → 看見,然後決定 → 謝謝 → 最終頁「你可以在 X 找到我」x.com/lis186 + QR code + github.com/lis186/ccxray(附 ⧉ 複製) | 最終頁停留讓大家掃 QR |

## LIVE DEMO(兩段式,總計約 100 秒)

**第一段(第二幕 ~2:30,約 20 秒)**:講到「開機兩行」時,按投影片上的 ⧉ 複製按鈕
把兩行指令貼進終端執行(現場示範「照著抄就會動」),然後立刻切回投影片繼續講
架構分鏡——server 在背景暖機,不佔演講時間。
**第二段(第三幕 ~4:20,約 80 秒)**:跑指令時 dashboard 已**自動在瀏覽器打開**(這就是預設行為),LIVE 頁提示切回那個分頁做 turn #1 示範。(`D` 鍵仍保留為備用:萬一分頁被關掉可一鍵重開。)

## LIVE DEMO 細節

- **內容**:還沒開始對話,MCP 工具描述、skills、CLAUDE.md、記憶就先吃掉 context。
  demo session 是**故意裝好裝滿**的:28 個 MCP(140 tools)+ 22 個 skills → 開口第一句
  **In 99K、$1.02**,固定稅 96,947 tok = 48.5% of 200K,28 個 MCP 全部「0 uses」被點名。
  點**新 session 的 turn #1** → 左面板 Cost(Turn $1.02)→ 左側導覽點 **Cost** 分頁看稅單。
- **操作**:第一段跑指令時 dashboard 自動開啟;LIVE 段切回該分頁即可(備用:`D` 鍵重開 `http://localhost:5577`)。
  會前跑 demo 資料包:
  `node tools/gen-fixture.mjs /tmp/demo /tmp/demo-home && HOME=/tmp/demo-home CCXRAY_PLAN=max5x CCXRAY_HOME=/tmp/demo ccxray --port 5577 --no-browser`
  (side-quest 專案的 c0ffee99 session 就是裝好裝滿的示範;要用自己真實的 `~/.ccxray` 也行,但數字就不是講稿上那組)。
- **Fallback**:demo 任何一步卡住,直接翻下一頁——STEP 5 十二頁導覽就是同畫面截圖的操作路徑回放,講稿照走,零損傷。
- **清理敘事邊界**:只點名使用者可控項(MCP、skills、CLAUDE.md、記憶);system prompt 與內建 tools 不在清理清單。
- **複製按鈕**:五個指令/URL 頁右上有 ⧉(含最終頁 repo 網址)(點擊複製、✓ 回饋、不觸發翻頁;code 頁可直接選字)。
  聽眾開同一份簡報也能照按——「我做一遍,你們照著做」零打字零打錯。
- **排練清單**:終端先開好、字體調大 ✓ 兩行指令現場貼上跑一次 ✓ 簡報 hash 記頁碼(切走可回)✓
  `D` 鍵測過 ✓ 投影機解析度下 System 分塊字體可讀 ✓

## 給講者的其他鍵

`→`/空白/點右側翻頁 · `←` 倒退(分鏡會反向動畫)· `A` 自動播放 · `D` 重開 dashboard(備用)· hash 記頁碼

## 視覺步驟(全部真實畫面;僅架構分鏡為線框)

STEP 1 架構分鏡×5(FLIP)| 2–4 dashboard 導覽分鏡×7(全圖→圈選→放大,同一張全圖 zoom)
| **5 稅單導覽分鏡×12(demo fallback;turn→Cost $1.02→Cost 分頁 bars→固定稅 48.5%→0-uses 點名牆)**
| **6 成本導覽分鏡×7(專案→session→turn 三層帳)+ Usage 每日單頁**($258/日均,30 天攀升曲線)
| 7 cache 過期:官方價目表分鏡×3(platform.claude.com 實際截圖)+ 倒數分鏡×4(原生閃爍)| 8 subagent 泳道
| 9 auto-compact 逐格重播×6(26 幀真實 render)| 10 模型對照縮時×3(講者真實 session 原圖)| 11 完整 dashboard

## 重現管線

```bash
node tools/gen-fixture.mjs /tmp/ccxray-demo /tmp/ccxray-demo-home
HOME=/tmp/ccxray-demo-home CCXRAY_PLAN=max5x CCXRAY_HOME=/tmp/ccxray-demo ccxray --port 5602 --no-browser
node tools/gen-spiral.mjs /tmp/ccxray-spiral && node tools/shoot-spiral.mjs
node tools/measure-tax.mjs      # turn1-tax.png(稅單第一段)+ tax tour 區域座標
node tools/measure-eff.mjs      # cost-eff.png / cost-eff2.png(Cost 分頁兩段)+ 區域座標
node tools/measure-cost.mjs     # cost-tour.png(第四幕三層帳)+ 區域座標
NODE_USE_ENV_PROXY=1 node tools/pricing-relay.mjs &   # 官方 pricing 頁 localhost 轉發
node tools/shoot-pricing-table.mjs                     # pricing-table.png + price tour 區域
node tools/build-deck.mjs
```

務必同時隔離 `CCXRAY_HOME` 和 `HOME`(cost-worker 掃 `$HOME/.claude*`,不隔離會把自己的真實帳單掃進 Usage 頁)。
所有金額由 `server/default-rates.js` 費率表對合成 token 計算,不手填;fable-5 主 session 38% of 1M、
side-quest 稅單 In 99,472 tok × $10/M + 520 out × $50/M = **$1.0207**、固定稅 96,947 tok(char/4,
與 server/helpers.js 同一估算器)、Usage 歷史正規化到 avg $258/day、cache 20× = 1h 重建 2× ÷ 命中 0.1×
(官方價目表 Fable 5 列:$20 vs $1,platform.claude.com 實際截圖)。區域座標全由 Playwright 量 DOM 得出。
自介頁名字在 deck-template.html 搜「阿修」修改;QR code 由 `qrcode` 套件產生(x.com/lis186)。

## 設計原則

- 示範介面 = 實際介面(截圖頁標「實際畫面」;分鏡標「架構示意」;demo 直接真的來)。
- 一頁一個念頭;分鏡連續性(#pxroot/#cxroot/#acroot/#mcroot 跨頁同 DOM,倒退反向動畫)。
- 首尾閉環:二月底撞上限開場 → 歸返幕逐項回答;npx 出現兩次(神器/處方)。
- X 光隱喻三落點:點題(造 X 光機)→ 伏筆(選擇 X 光不會替你做)→ 收束(照得出病灶,治不了病,判斷在你)。

> 註:投影片內中文標點一律全形(英文訊息、指令、URL、時間戳保持半形)。
