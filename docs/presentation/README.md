# ccxray 高橋流簡報(10 分鐘)

`index.html` 是一份零依賴的單檔簡報,直接用瀏覽器開啟即可。

三層結構:

1. **表層:高橋流** — 一頁一句、字極大,文字頁用機關槍節奏連發。
2. **視覺層:十步揭開真實 dashboard** — STEP 2–10 全部是 **ccxray v2.3 實際介面截圖**
   (深色主題、合成示範資料實拍,非示意圖);只有 STEP 1 的架構分鏡是線框示意,並標註「架構示意」。
3. **故事層:英雄旅程八幕** — 右上角幕別徽章,讓聽眾隱約感覺「這是一個故事」。

## 操作

| 按鍵 | 動作 |
|------|------|
| `→` / 空白鍵 / 點擊右側 | 下一頁 |
| `←` / 點擊左側 25% | 上一頁 |
| `Home` / `End` | 跳到頭 / 尾 |
| `A` | 自動播放(每 6 秒一頁,再按一次停止)|
| 手機 | 左右滑動翻頁 |

網址 hash 記錄頁碼(`#42`),中斷後可從原頁繼續。

## 視覺層:十步(全部真實畫面)

| STEP | 畫面 | 出現於 | 內容 |
|------|------|--------|------|
| 1 | 架構分鏡 ×5(唯一線框)| 第三幕 | 連續五頁共用同一組元素,翻頁不重建、以平移/縮放延伸(FLIP 轉場):Claude Code 獨處 → 直連 API(光點開始流)→ **zoom in** 管線中點(虛線圈標記空位)→ ccxray 縮放進場 → **zoom out** + 記錄流逐列疊出 |
| 2 | Topbar | 第四幕 | `● ccxray` + Dashboard / Usage / System Prompt + Context HUD + quota ticker |
| 3 | PROJECTS + SESSIONS 欄 | 第四幕 | 專案卡(成本黃字)、session 卡(model · turns · 時長、**97% of 200K** 紅色 context bar)|
| 4 | TIMELINE steps | 第四幕 | user 泡泡、Read/Grep/Edit/Bash 步驟、thinking、逐字內容 |
| 5 | Agent 卡 + Usage 卡 | 試煉一 | CONTEXT/CACHE/COST/TOKENS/TOOLS + MONTHLY/DAILY COST + ACCOUNTS |
| 6 | Cache 過期分鏡 ×4 | 試煉一 | 同一張真實 session 卡跨四頁存活,一頁一個情況、狀態原地交叉淡變:`cache 50m left`(綠,安心)→ 去開會 `20m`(黃)→ 最後 3 分鐘(紅,**以原生 cachePulse 節奏閃爍**,鏡頭推近 1.24×)→ `cache expired`(灰,鏡頭拉回);紅色態由兩幀真實畫格交錯重現 |
| 7 | Workflow 泳道 | 試煉二 | main lane + Explore 子代理 lane、minimap、時間軸 |
| 8 | System Prompt 頁 | 試煉三 | AGENTS / VERSIONS(v2.0.14 → v2.0.15 `+0.2k`)/ DIFF mode |
| 9 | Intercept | 第六幕 | topbar `HELD (117s)` 琥珀 chip + session 卡紅色 `HELD` 徽章 |
| 10 | 完整 dashboard | 第七幕壓軸 | 全畫面:columns + 泳道 + agent 卡 + timeline 同框 |

### 截圖是怎麼來的(可重現)

截圖來自真的 ccxray server(非 mockup):

```bash
node tools/gen-fixture.mjs /tmp/ccxray-demo      # 合成示範資料(index + req/res + system prompts)
CCXRAY_HOME=/tmp/ccxray-demo ccxray --port 5602 --no-browser
# headless Chromium(dark color-scheme)逐畫面截圖(含真的 intercept HELD:
# 開 /_api/intercept/toggle 後送一個 request 讓它真的被攔下)
node tools/build-deck.mjs                        # 把截圖以 base64 內嵌進 deck-template.html → index.html
```

改版後要更新簡報:重跑上面三步即可。截圖務必走 `CCXRAY_HOME` 隔離目錄(見 `docs/testing.md`),
不要拿自己真實的 `~/.ccxray` 資料截圖。

### Cache 20× 這個數字

1h TTL(Max 方案,`server/plans.js`)的 prompt cache:命中讀取計價 **0.1×**、過期重建 **2×**
——放著讓它斷線,同一段 context 的價差就是 **20 倍**。ccxray 的三層提醒都是實際功能:
卡片倒數四態(`public/countdown-ticker.js`:>60% 綠 / 30–60% 黃 / <30% 紅 + `cachePulse`
閃爍 / 過期灰)、cache <60s 時分頁標題閃 `⚠ ccxray`、以及 opt-in 的瀏覽器通知
(`public/cache-notify.js`,Max 預設開、提前 5 分鐘)。STEP 6 的四態截圖用
`CCXRAY_PLAN=max5x` 跑出 1h TTL 後實拍。

## 節奏表(總長 10:00,87 頁)

高橋流的節奏感 = **快慢交錯**:文字頁 1–5 秒連發,截圖頁停 15–25 秒講;
紅字 = 痛點、青字 = ccxray/轉折、綠字 = 解脫。

| 幕 | 英雄旅程 | 時間 | 節奏與講法 |
|----|----------|------|------------|
| 序幕 | 平凡世界 | 0:00–0:40 | 平穩親切。「但是——」故意拖長,吊住全場 |
| 第一幕 | 冒險的召喚 | 0:40–1:50 | 連珠炮拋問題。「你不知道」放慢,「帳單知道」重擊+停 3 秒 |
| 第二幕 | 拒絕召喚 | 1:50–2:30 | 模仿觀眾自我安慰,輕鬆;「直到——」轉折收笑 |
| 第三幕 | 導師現身 | 2:30–3:40 | code 頁停 4 秒讓人拍照;五頁分鏡一頁一個重點、每頁 3–6 秒:獨處 → 直連 → zoom in「中間什麼都沒有」(壓低聲音)→「站進來」(重擊)→ zoom out 看 log 疊出 |
| 第四幕 | 跨越門檻 | 3:40–5:00 | 「看見」是軸心字;STEP 2→3→4 逐步揭開:入口 → 欄位 → 逐字步驟;指著紅色 97% bar 與 thinking 步驟講 |
| 第五幕 | 試煉之路 | 5:00–7:10 | 三段同構:「試煉 N(灰)→ 痛點(紅)→ STEP 截圖 → 收尾(綠)」;試煉一內插 cache 段:「差 20 倍」重擊後停 2 秒;STEP 6 四頁分鏡一頁一個情況(綠安心 → 黃開會 → 紅閃爍推近鏡頭壓低聲音 → 過期拉遠嘆氣),講「它在催你回去」 |
| 第六幕 | 深淵尋寶 | 7:10–8:15 | 語速最慢。「不」「攔截」單字重擊;STEP 9 指著 HELD 徽章講「主導權回到你手上」 |
| 第七幕 | 帶著火種歸返 | 8:15–9:20 | 輕快收攏 hub/多代理/delta;code 頁二現首尾呼應;STEP 10 壓軸大圖停滿 20 秒 |
| 終幕 | — | 9:20–10:00 | 點破故事層:「不是屠龍,是帶回火種」。「透明」一字收束,報 repo,謝幕 |

## 設計原則

- **示範介面 = 實際介面**:STEP 2–10 不畫示意圖,直接放真實截圖,每頁角落標
  「ccxray v2.3 實際畫面(示範資料)」;唯一的線框(STEP 1)明確標示「架構示意」。
- **一頁一個念頭**:超過 7 個字就該懷疑要不要拆頁。
- **視覺是累積的**:入口 → 欄位 → 步驟 → 各功能分區 → 最後全畫面同框,壓軸沒有新資訊,只有完成感。
- **分鏡連續性**:STEP 1(`#pxroot`,五頁)與 STEP 6(`#cxroot`,四頁)各共用同一個 DOM,
  翻頁只切換 scene class,元素靠 CSS transition 平移/縮放/交叉淡變到新狀態——一頁一個重點,
  節奏不被重繪打斷;倒退翻頁會反向動畫(含紅色態閃爍的恢復)。
- **問答對仗**:第一幕的每個問題,第四、五幕逐一回收。
- **首尾呼應**:`npx ccxray claude` 出現兩次;第一次是神器,第二次是行動呼籲。
