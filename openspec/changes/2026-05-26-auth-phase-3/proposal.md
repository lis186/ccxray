## Why

Phase 2 完成後，auth scheme 已完全生效但保留了若干 backward-compat shims（`?token=` redirect on `/`、deprecation header code paths）。Phase 3 移除這些殘留，讓 auth surface 精簡到最終形態。

## What Changes

- 移除 `?token=` 在 `/` 的 redirect shim（`ccxray open` 是唯一 browser bootstrap）
- 移除 `whichLegacyMechanism()` 和 `setDeprecation()` code paths
- 移除 `X-Ccxray-Deprecation` response header 相關邏輯
- 最終 auth surface: `server/auth.js` ~180 LOC, `server/index.js` dispatch ~25 LOC

## Capabilities

### Modified Capabilities

- `two-domain-auth-scheme`: remove legacy compatibility paths, final minimized form

## Impact

- `server/auth.js`: 刪除 ~50 LOC（legacy detection + deprecation headers）
- `server/index.js`: simplify dispatch call site
- `public/index.html`: remove any `?token=` → cookie redirect handling
- CHANGELOG: note `?token=` no longer accepted anywhere
