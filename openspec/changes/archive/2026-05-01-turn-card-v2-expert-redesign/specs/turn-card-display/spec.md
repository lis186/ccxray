## REMOVED Requirements

### Requirement: Turn card has five-layer visual hierarchy
**Reason**: v2 compresses to a five-line layout (identity / title / ctx-bar / secondary / risk) with conditional omission, replacing the prior "five visual layer" abstraction. Risk is split: critical-tier on line 1, warning/notice on line 5.
**Migration**: See `turn-card-v2` spec. Existing `.turn-risk` legacy badge layer removed; warning/notice signals render as plain text on line 5 instead.

### Requirement: Identity line shows turn number, model, status dot, wait indicator
**Reason**: The left-edge color bar was added (Ware's position channel is more effective than small dots for severity at a glance) but the status dot was retained on the identity line as a redundant signal — it conveys HTTP success/failure of the specific turn, while the left bar conveys aggregated severity across all signals. Model name omission was originally specced (session-aware skip when same model + ≤5 entries away) but **never shipped**: the omission rule is dropped because scanning cost is lower than the confusion caused by intermittent model labels.
**Migration**: Add `.turn-left-bar` class on the `.turn-item` (via `.risk-critical` / `.risk-warning` / `.risk-notice` modifiers). Keep `.status-dot` CSS and span (do NOT remove). Always render model name on line 1 for both main and subagent turns.

### Requirement: Risk badges surface actionable signals
**Reason**: `⚠` emoji badges caused symbol competition with other glyphs and failed Tufte's data-ink principle. Replaced by plain ASCII markers — critical-tier on line 1 (`!http`, `!max`, `!len`, `!stop`, `!filter`), warning/notice tiers on line 5 (`cred`, `tool-fail`, `dupes×N`).
**Migration**: Remove `.turn-risk` legacy layer and all `*-badge` classes except `.cred-highlight` (used in detail view). Emit `!`-prefixed critical markers on identity line via `.turn-critical-marker`; emit warning/notice text on a separate risk line at the bottom. No emoji anywhere on the card.

### Requirement: compact and inferred metadata available via tooltip
**Reason**: Retained in spirit but made stricter — the v2 spec forbids the `turn-meta` text suffix entirely; only tooltip remains.
**Migration**: Remove `.turn-meta` span output. Keep tooltip attribute on the `.turn-identity` element.
