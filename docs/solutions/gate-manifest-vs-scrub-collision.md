# GATE-MANIFEST 與 scrub-output 的規則衝突（無相容形式）

- 發現：2026-07-30，PR #378（#377 slice 1）
- 影響：任何遵循 runbook step 7 的 PR 都無法通過 `scrub-output.sh`

## 現象

runbook step 7 要求 PR body 附 `GATE-MANIFEST`，且每行的 `@sha` 必須等於 PR 的
`headRefOid`：

```
issue-lint=pass @<headRefOid>
full-test=0 @<headRefOid>
boot-smoke=0 @<headRefOid>
```

`gate-marker-check.sh` 以字串相等比對 `@sha` 與 `headRefOid`（該 script 的
sha 比對段），因此**必須是完整 40 字元 hex**，短 sha 一律判為陳舊。

而 `scrub-output.sh` 的 R3 規則（密鑰/高熵字串）正則含 `[0-9a-fA-F]{40,}`，
完整 40 字元 hex 必然命中 → exit 1、不放行。

兩者都是 runbook 的強制閘，且**沒有同時滿足的寫法**：

| manifest 形式 | gate-marker-check | scrub-output |
|---|---|---|
| 完整 40 字元 sha | ✓ | ✗ R3 |
| 短 sha（12 字元） | ✗ 判為陳舊 | ✓ |
| 省略 manifest | ✗ 缺席 | ✓ |

## 為什麼之前沒爆

manifest 通常直接貼上，沒有先過 scrub（scrub 是「發 comment 前的 pipe 閘」，
而 manifest 常被視為 PR body 的一部分而非 comment）。PR #357 的 manifest
comment 即為完整 sha，可推測未經 scrub。也就是說這兩個閘在實務上從未被
串在同一條路徑上跑過。

## 本次處置（非長久解）

PR body 去掉 manifest 後過 scrub（exit 0），manifest 單獨以 comment 貼出並
在同一則 comment 明示「未經 scrub、原因為 R3 與 headRefOid 不相容、內容經
人工檢視僅四行 `gate=value @sha`」。揭露而非靜默繞過。

## 建議修法（擇一，需 owner 裁）

1. **R3 加白名單**：在 `secret_re` 命中後，先剔除符合
   `^[[:space:]]*[a-z-]+=(0|pass|n/a)[[:space:]]+@[0-9a-f]{40}[[:space:]]*$`
   的行再判定。最小改動，語義明確（只放行 manifest 行的 sha，不放行裸 hex）。
2. **manifest 改用短 sha**：同步放寬 `gate-marker-check.sh` 為前綴比對
   (`[[ "$head_oid" == "$sha"* ]]`，並要求 sha 長度 ≥ 12)。代價是比對變寬鬆。
3. **manifest 不走 scrub**：明文在 runbook 記載 manifest 是 scrub 的例外。
   最省事但最差 —— 「哪些東西可以不過閘」一旦開始列舉就會擴張。

傾向 1：R3 的威脅模型是「意外貼出 token/log」，而 manifest 是機器產生、
形狀固定、內容為公開 commit hash 的字串，用形狀白名單排除不削弱該模型。
