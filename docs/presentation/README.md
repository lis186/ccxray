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
| 3 | PROJECTS + SESSIONS 欄 | 第四幕 | 專案卡(成本黃字)、session 卡(`fable-5 · 17t · 9m`、`$6.80`、**38% of 1M** context bar、綠色 cache 倒數)|
| 4 | TIMELINE steps | 第四幕 | user 泡泡、Read/Grep/Edit/Bash 步驟、thinking、逐字內容 |
| 5 | Agent 卡 + Usage 卡 | 試煉一 | CONTEXT/CACHE/COST/TOKENS/TOOLS + MONTHLY/DAILY COST + ACCOUNTS |
| 6 | Cache 過期分鏡 ×4 | 試煉一 | 同一張真實 session 卡跨四頁存活,一頁一個情況、狀態原地交叉淡變:`cache 50m left`(綠,安心)→ 去開會 `20m`(黃)→ 最後 3 分鐘(紅,**以原生 cachePulse 節奏閃爍**,鏡頭推近 1.24×)→ `cache expired`(灰,鏡頭拉回);紅色態由兩幀真實畫格交錯重現 |
| 7 | Workflow 泳道 | 試煉二 | main lane + Explore 子代理 lane、minimap、時間軸 |
| 8 | System Prompt 頁 | 試煉三 | AGENTS / VERSIONS(v2.0.14 → v2.0.15 `+0.2k`)/ DIFF mode |
| 9 | Auto-compact 逐格重播 ×6 | 第六幕 | 26 幀**真實泳道 render**(對同一份 log 取前 k 回合前綴、真 server 逐格實拍),六頁分段自動播放、跨頁同一 DOM 續播:context 柱狀圖慢慢長高 → 穿過 80 虛線進 dumb zone(faults 軌紅點連發、天氣轉雷雨)→ 聊到 95% → auto compact 摔回 15%(cache 全滅:該回合 read=0、整根橙色重寫 + compaction/cache-miss 標記)→ 再爬。倒退翻頁重播該段;`prefers-reduced-motion` 直接跳段尾 |
| 10 | 模型選擇對照 ×3(縮時)| 第六幕 | **講者提供的兩個真實 session** birds-eye overview 原圖(橫軸=時間,多 subagent 斜瀑布),以**左→右時間擦除**縮時重播——擦除線就是時間游標,跨線的長紅 bar 會逐漸變長。選對模型一片綠、快進快出 vs 模型太小 window 不足、失敗率飆高長紅 bar;第三頁定性結論浮現(不標數字——原圖 session 的實際統計以講者現場口述為準)。三頁同 DOM;倒退重播 |
| 11 | 完整 dashboard | 第七幕壓軸 | 全畫面:columns + 泳道 + agent 卡 + timeline 同框 |

### 截圖是怎麼來的(可重現)

截圖來自真的 ccxray server(非 mockup):

```bash
node tools/gen-fixture.mjs /tmp/ccxray-demo /tmp/ccxray-demo-home   # 合成示範資料
#   → CCXRAY_HOME(index + req/res + system prompts)+ 假 HOME(~/.claude JSONL,Usage 頁來源)
HOME=/tmp/ccxray-demo-home CCXRAY_PLAN=max5x CCXRAY_HOME=/tmp/ccxray-demo ccxray --port 5602 --no-browser
# headless Chromium(dark color-scheme)逐畫面截圖
node tools/gen-spiral.mjs /tmp/ccxray-spiral     # 死亡螺旋 session(STEP 9 的 26 幀來源)
node tools/shoot-spiral.mjs                      # 對 log 前綴逐格重啟 server 實拍泳道
node tools/gen-fanout.mjs /tmp/ccxray-fanout     # 模型選擇對照(STEP 10 的兩張 birds-eye 來源)
node tools/build-deck.mjs                        # 把截圖以 base64 內嵌進 deck-template.html → index.html
```

改版後要更新簡報:重跑上面三步即可。截圖務必同時隔離 `CCXRAY_HOME` **和** `HOME`(ADR 0015 R4
的教訓:cost-worker 掃 `$HOME/.claude*`,不隔離 HOME 會把你自己的真實帳單掃進 Usage 頁),
不要拿真實的 `~/.ccxray`/`~/.claude` 資料截圖。

### 示範資料的數字怎麼算

主 session 用 `claude-fable-5`(1M 視窗,`SUPPORTS_1M` 實測支援 `[1m]` marker):
14 回合、context 從 184K 爬到 **380K = 38% of 1M**;每回合 cache 寫入 8–30K(工具結果)、
增量 input 23–88、output 290–2,450(thinking 回合最大)、elapsed 8–72 秒、回合間隔 15–45 秒,
全程約 10 分鐘。**成本不是手填的**:`tools/gen-fixture.mjs` 直接按
`server/default-rates.js` 的 fable-5 費率(input $10 / output $50 / cache write $12.5 /
cache read $1 每百萬 token)算出每回合 cost,主 session 合計 ≈ $6.7。Explore 子代理與
webapp session 用 `claude-sonnet-4-6`(200K)同法計價。STEP 9 的螺旋 session(api-server 專案)
也是 sonnet-4-6:26 回合、49 分鐘,context 依 [11%→95%] 再 compact 至 15% 的曲線推進,
`toolFail` 落在 13/16/18–21 回合(dumb zone 失敗率上升的紅點來源),compact 回合
`cache_read=0`、`cache_creation≈29.6K`(全量重寫),同費率表計價共 $1.87。STEP 10 的對照
sessions:STEP 10 現採用**講者提供的真實 session 原圖**(`tools/` 仍保留 `gen-fanout.mjs`
可生成同形狀的合成對照組,供無原圖時重建)。Usage 頁的 $6.89(Today/Month)
= ccxray 專案 $6.80 + webapp $0.09——產生器同步輸出 `~/.claude/projects/*.jsonl`
(cost-worker 的掃描來源),兩邊數字天然一致。

### Cache 20× 這個數字

1h TTL(Max 方案,`server/plans.js`)的 prompt cache:命中讀取計價 **0.1×**、過期重建 **2×**
——放著讓它斷線,同一段 context 的價差就是 **20 倍**。ccxray 的三層提醒都是實際功能:
卡片倒數四態(`public/countdown-ticker.js`:>60% 綠 / 30–60% 黃 / <30% 紅 + `cachePulse`
閃爍 / 過期灰)、cache <60s 時分頁標題閃 `⚠ ccxray`、以及 opt-in 的瀏覽器通知
(`public/cache-notify.js`,Max 預設開、提前 5 分鐘)。STEP 6 的四態截圖用
`CCXRAY_PLAN=max5x` 跑出 1h TTL 後實拍。

## 節奏表(總長 ~10:10,102 頁;需壓回 10:00 時第一、二幕文字頁加速)

高橋流的節奏感 = **快慢交錯**:文字頁 1–5 秒連發,截圖頁停 15–25 秒講;
紅字 = 痛點、青字 = ccxray/轉折、綠字 = 解脫。

| 幕 | 英雄旅程 | 時間 | 節奏與講法 |
|----|----------|------|------------|
| 序幕 | 平凡世界 | 0:00–0:40 | 平穩親切。「但是——」故意拖長,吊住全場 |
| 第一幕 | 冒險的召喚 | 0:40–1:50 | 連珠炮拋問題。「你不知道」放慢,「帳單知道」重擊+停 3 秒 |
| 第二幕 | 拒絕召喚 | 1:50–2:30 | 模仿觀眾自我安慰,輕鬆;「直到——」轉折收笑 |
| 第三幕 | 導師現身 | 2:30–3:40 | code 頁停 4 秒讓人拍照;五頁分鏡一頁一個重點、每頁 3–6 秒:獨處 → 直連 → zoom in「中間什麼都沒有」(壓低聲音)→「站進來」(重擊)→ zoom out 看 log 疊出 |
| 第四幕 | 跨越門檻 | 3:40–5:00 | 「看見」是軸心字;STEP 2→3→4 逐步揭開:入口 → 欄位 → 逐字步驟;指著 38% of 1M context bar 與 thinking 步驟講 |
| 第五幕 | 試煉之路 | 5:00–7:10 | 三段同構:「試煉 N(灰)→ 痛點(紅)→ STEP 截圖 → 收尾(綠)」;試煉一內插 cache 段:「差 20 倍」重擊後停 2 秒;STEP 6 四頁分鏡一頁一個情況(綠安心 → 黃開會 → 紅閃爍推近鏡頭壓低聲音 → 過期拉遠嘆氣),講「它在催你回去」 |
| 第六幕 | 深淵尋寶 | 7:10–8:55 | 這是全簡報的「深淵」本體。Smart/Dumb Zone 兩個大字各停 2 秒;六頁逐格重播讓柱狀圖自己長:「還在漲」語速加快製造焦慮 → 紅點段壓低聲音「它開始失手了」→ 95% 定格停 3 秒 → auto compact 那格落下時拍手一聲「沒了」→ 重生段放鬆;收尾回扣試煉二:「分工給 subagent,留在 smart zone」;接著模型選擇對照三頁:good 縮時 7 秒播完先立標竿 → bad 續播(觀眾會等它停,它還一直長)→ 結論浮現時逐項點名「更久、更貴、更差」,實際數字由講者口述 |
| 第七幕 | 帶著火種歸返 | 8:55–9:40 | 輕快收攏 hub/多代理/delta;code 頁二現首尾呼應;STEP 10 壓軸大圖停滿 20 秒 |
| 終幕 | — | 9:40–10:10 | 點破故事層:「不是屠龍,是帶回火種」。「透明」一字收束,報 repo,謝幕 |

## 設計原則

- **示範介面 = 實際介面**:STEP 2–10 不畫示意圖,直接放真實截圖,每頁角落標
  「ccxray v2.3 實際畫面(示範資料)」;唯一的線框(STEP 1)明確標示「架構示意」。
- **一頁一個念頭**:超過 7 個字就該懷疑要不要拆頁。
- **視覺是累積的**:入口 → 欄位 → 步驟 → 各功能分區 → 最後全畫面同框,壓軸沒有新資訊,只有完成感。
- **分鏡連續性**:STEP 1(`#pxroot`,五頁)、STEP 6(`#cxroot`,四頁)、STEP 9(`#acroot`,六頁)、STEP 10(`#mcroot`,三頁)
  各共用同一個 DOM,
  翻頁只切換 scene class,元素靠 CSS transition 平移/縮放/交叉淡變到新狀態——一頁一個重點,
  節奏不被重繪打斷;倒退翻頁會反向動畫(含紅色態閃爍的恢復)。
- **問答對仗**:第一幕的每個問題,第四、五幕逐一回收。
- **首尾呼應**:`npx ccxray claude` 出現兩次;第一次是神器,第二次是行動呼籲。
