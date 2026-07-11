# Seq tracker:到達序不是事件時序(一個根因、三種變形、一次回歸)

- Issue: #230 · PR: #237 · ADR: `docs/decisions/0009-sequential-interleave-conv-bracketing.md`

分類 tracker 的不變量定義在**事件時序**(receivedAt)上,但 live 路徑天然以
**到達序(完成序)**餵資料——嵌套的短 turn 會比先開始的長 turn 先完成、先到達。
同一個根因在 codex 審查中以三種變形出現:

1. **Trunk 毒化(round 1)**:嵌套的異 conv turn 先到達,成為 runs[0] = trunk,
   整個 session 的 bracket 永不關閉。修法:tracker 內部維護 `(receivedAt, id)`
   排序的 candidate list,runs 永遠從 list 重建、不從到達序。
2. **已關閉的 excursion 不可翻案(round 5)**:bracket 關閉後才到達的
   「開始最早、跨全程」turn 會改寫主幹本身,但 closed turns 已離開 tracker
   list——不存在增量修復。修法:inserted-before-tail 到達 → `wfAddEntry`
   放棄增量,整段 `wfBuildState` 重建(UI 狀態搬移)。
3. **單邊收斂(round 6)**:同一個 reordered flag 傳到 entry-rendering 卻被
   忽略——swimlane 翻案回 main 的 turn,turn list 永遠留在 sN。修法:
   `_seqRecomputeSession` 重放 session、雙向套用翻轉(`_seqFlipped` 標記
   seq 層所有權)。

**值得記住的回歸(069246a)**:對 R2 frontier store 做「顯而易見的清潔」——
延續合併、FIFO 上限——摧毀了歷史分岔點、驅逐了仍活躍的 conv。**所有 unit
fixture 全綠**;只有 439-session 真實資料 re-audit 攔到(jumpreturn 殘留
3→8,append-only 重做後回到 3)。教訓:

- 推論用的 evidence store 應 append-only,除非「消費」本身使該點退休
  (R2 stitch-advance、15 分鐘 TTL)。
- 分類/歸因類改動,unit 測試綠不等於完工——見
  `docs/verification-principles.md` 的「真實資料全量重放」一節。
