# Design: UX Card Polish

## Session card layout (after)

```
┌────────────────────────────────────────────────┐
│ ● 8adc7cfc  ★                                  │
│ ▶ continue: 8adc7cfc          [click to copy]  │
│ sonnet-4-6 · 294t · $15.24   2m ago            │
│ "全部 312 個測試通過，沒有失敗。實作已…"        │
│ ● cache · 57m left                             │
└────────────────────────────────────────────────┘
```

## Cache dot colour thresholds

| Plan | TTL  | Green     | Yellow    | Red      |
|------|------|-----------|-----------|----------|
| Max  | 60m  | > 36m     | 18–36m    | < 18m    |
| Pro  | 5m   | > 3m      | 1.5–3m    | < 1.5m   |

## Turn card time row (after)

```
wait:4s dur:9s (think:1.9s)       ← before
dur:9s  (wait:4s · think:1.9s)    ← after  [wait/think in dim smaller text]
```

## Continue chip copy behaviour

Click → clipboard receives `claude --continue 8adc7cfc` → chip text swaps to `✓ copied!` for 1500 ms → reverts.

## Project dot tooltip format

- streaming: `"streaming"`
- idle: `"idle · {N}m ago"` (use `Math.round((Date.now() - lastSeenAt) / 60000)`)
- offline: `"offline"`
