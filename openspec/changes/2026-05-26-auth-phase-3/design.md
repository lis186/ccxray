## Context

Phase 2 完成後，auth scheme 完全生效。殘留的 backward-compat shims（`?token=` redirect、deprecation headers）不再需要。

## Goals / Non-Goals

**Goals:**
- 移除所有 legacy auth 相容路徑
- 精簡 auth surface 到最終形態 (~180 LOC)

**Non-Goals:**
- 加入新功能（Phase 3 是純刪除）
- 修改認證架構（已在 Phase 2 定案）

## Decisions

所有結構性決策繼承自 Phase 2 design.md。Phase 3 無新設計決策 — 僅移除 Phase 2 標記為 deprecated 的 code paths。

## Risks / Trade-offs

- **使用者仍在用 `?token=` 書籤**：Phase 2 已轉為 cookie redirect，Phase 3 移除 redirect。CHANGELOG 提前通知。
- **`stripAuthParams` 移除後若有其他用途**：確認 `url-sanitize.js` 只服務 auth param stripping；若有其他 query param 也走此函式，需保留框架。

## Migration Plan

CHANGELOG 列出：「`?token=` 不再被接受。使用 `ccxray open` 進行瀏覽器認證。」
