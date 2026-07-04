# Workflow View Design Spec

Issue: #91 — Session timeline can't express dynamic agent workflows

## Vocabulary

All code, comments, and discussions use these names consistently.

```
┌─ Topbar ─────────────────────────────────────────────────────────────────┐
├──────────┬──────────────┬────────────────────────────────────────────────┤
│          │              │ Overview Bar          Duration Badge  + − ⟲   │
│          │              │ ░░░░░░[Viewport Rect]░░░░░  Scale Labels      │
│ Projects │ Sessions     ├── Timeline Header (STICKY) ────────────────────┤
│ Column   │ Column       │  Lane Label │ Turn Bars ▕▕▕  Ctx Sparkline   │
│          │              ├── Sub-lanes (SCROLLABLE) ──────────────────────┤
│          │              │  Lane Label │ Turn Bars ▕▕▕  Ctx Sparkline   │
│          │              │  Lane Label │ Turn Bars ▕▕  ← SELECTED:      │
│          │              │             │  Ctx Sparkline ▁▂▃▅ (28px)      │
│          │              │             │  Cache Hit ▃▅▅▅ (20px)          │
│          │              │             │  Cost ▁▂▃▁ (20px)               │
│          │              │  Lane Label │ Turn Bars ▕▕▕  Ctx Sparkline   │
│          │              ├══ Resize Handle ═══════════════════════════════┤
│          │              │ ┌ Agent Card ────┐ ┌ Steps Panel ─────────────┤
│          │              │ │ Color Bar ▎    │ │ Step Row                 │
│          │              │ │ Context stats  │ │  ┌ Tool Group (brackets) │
│          │              │ │ Cache / Cost   │ │  └ Spawn Badge           │
│          │              │ │ Tool summary   │ │ Idle Separator ⏸ 10m     │
│          │              │ ├────────────────┤ │ Step Row (ctx% colored)  │
│          │              │ │ ● Timeline  30 │ │                          │
│          │              │ │ ● System   884 │ │ ← Detail view changes    │
│          │              │ │ ● Core    9·19 │ │   based on nav selection │
│          │              │ │ ● MCP      91  │ │                          │
│          │              │ │ ● Skills  220  │ │                          │
│          │              │ │ 💰 Cost Eff.   │ │                          │
│          │              │ │   Request      │ │                          │
│          │              │ │   Events  231  │ │                          │
│          │              │ └────────────────┘ └──────────────────────────┤
├── Bottom Bar ────────────────────────────────────────────────────────────┤
└──────────────────────────────────────────────────────────────────────────┘
```

### Term Definitions

| Term | Code ID/Class | Description |
|------|--------------|-------------|
| **Topbar** | `#topbar` | Branding, nav tabs, quota ticker. Unchanged from main ccxray. |
| **Projects Column** | `#projects-col` | Left sidebar (160px). Lists monitored projects. |
| **Sessions Column** | `#sessions-col` | Second column (200px). Lists sessions for selected project. |
| **Overview Bar** | `#overview-bar` | Full-width bar at top of right area. Shows entire session at reduced scale. Always visible. |
| **Viewport Rect** | — (canvas drawing) | Blue rectangle in Overview Bar showing currently visible time range. |
| **Duration Badge** | — (canvas drawing) | Blue pill at bottom-right of Viewport Rect showing its time span (e.g. "15.3m"). |
| **Scale Labels** | — (canvas drawing) | Time markers at 0 / midpoint / end in Overview Bar. |
| **Timeline Header** | `#timeline-header` | Sticky container for time axis + Main Lane. Never scrolls away. |
| **Sub-lanes** | `#macro-svg` | Scrollable SVG containing all agent lanes except main. |
| **Lane** | — (SVG group) | One horizontal row representing a single agent. Unselected: turn bars only (8px + 4px gap). Selected: expands with cache hit + cost rows (+40px). |
| **Lane Label** | `.lane-label` | Agent name + model + context window shown left of each Lane (240px). |
| **Turn Bar** | `.wf-turn-bar` | Colored rectangle in a Lane. Width ∝ elapsed duration, color = context zone (green <40% / yellow 40-80% / red ≥80%). Error turns add 45° hatching overlay. |
| **Context Sparkline** | — (SVG path) | **Removed in v1.10** — context signal now encoded directly in Turn Bar color (zone coloring). |
| **Cache Hit Chart** | — (SVG rects) | 20px bar chart showing per-turn cache hit ratio. Only visible on the **selected** lane. Green (≥50%), yellow (<50%). |
| **Cost Chart** | — (SVG rects) | 20px bar chart showing per-turn cost. Only visible on the **selected** lane. Orange bars, height ∝ turn cost. |
| **Spawn Connector** | `.spawn-line` | 0.5px gray line from parent Turn Bar to child Lane's first turn. |
| **Resize Handle** | `#wf-resize` | 4px draggable divider between timeline and Detail Area. |
| **Agent Card** | `#wf-agent-card-panel` | Left panel (240px) in Detail Area. Top: lane summary (context, cache, cost, tools). Bottom: **Section Nav** — clickable section items matching the existing ccxray sections column (Timeline, System, Core, MCP, Skills, Cost Efficiency, Request, Events). Clicking a nav item selects a turn and switches the Steps Panel to that section's detail view. |
| **Color Bar** | — (inline style) | 2px left border on Agent Card. Decorative accent only — not tied to turn bar encoding. |
| **Section Nav** | — (inside Agent Card) | Reuses the existing `renderSectionsCol` section items from v1.9.2. Each item shows: colored dot + label + badge (token/tool/event count) + chevron. Clicking sets `selectedSection` and renders the corresponding detail in the Steps Panel via `renderDetailCol`. |
| **Steps Panel** | `#wf-steps-content` | Right panel in Detail Area. Uses flex column layout so headers stay fixed and split panes scroll independently. Content depends on Section Nav selection — all sections (including Timeline) render via `renderDetailCol` → `commitDetailHtml` redirect. |
| **Timeline (v1.9.2)** | — (inside Steps Panel) | Reuses the full v1.9.2 timeline renderer (`renderStepListHtml`): human messages, thinking blocks with duration, tool calls with name/preview/status, star buttons, and minimap. Replaces the earlier flat turn list. |
| **Focused Mode** | **Removed (P16).** Steps and Step Detail are always side-by-side with a draggable resize handle between them. No mode to enter/exit. Replaces the former `.focused.wf-active` split-pane toggle. |
| **Position Cursor** | `#wf-cursor` | Semi-transparent accent-colored rect in swimlane (`position:absolute`, `z-index:10`) spanning the selected turn's time range (`receivedAt` to `receivedAt + elapsed`). Overview canvas draws a matching `fillRect`. Both use `_wfFindTurn` to resolve the turn object. Min width 3px; overview clamps to canvas bounds. Updated by `wfHighlightTurn`, `wfDeferRender` (pan/zoom), and `selectStep` (step navigation). All three areas (overview, swimlane, step list) stay in sync. |
| **Step Row** | `.tl-step-summary` | One step's display in the timeline. Row number + tool name/preview + status (✓/✗) + star + optional source badge. |
| **Tool Group** | `.step-tools` | Vertical list of tool calls with ┌│└ brackets when multiple. |
| **Spawn Badge** | `.spawn-badge` | `⑂ agent-name` marker in a Tool Group indicating an Agent spawn. |
| **Idle Separator** | `.step-idle-sep` | Amber `⏸ 10.0m` row between Step Rows where idle > 5 min. |
| **Star** | `.step-star` | ★/☆ toggle on Step Row (per-turn) or Agent Card header (per-agent). |
| **Bottom Bar** | `#bottom-bar` | Keyboard shortcut hints at bottom of window. |

## Problems to Solve

### Structure (1-5)
1. **Parent-child severed** — `inferParentSession()` merges subagent into parent session; the spawn edge is lost
2. **Parallelism invisible** — 4 parallel forks appear as a single `Agent×4` line item
3. **Fan-in invisible** — subagent results flowing back to orchestrator's next turn is not shown
4. **Multi-layer spawn** — orchestrator → fork → fork (eval batch pattern); prototype only handles one layer
5. **Heterogeneous agent types** — `Explore`, `fork`, `codex:codex-rescue` all shown as generic "subagent"

### Lifecycle (6-8)
6. **Task lifecycle invisible** — TaskCreate/Update/Stop scattered as individual tool calls; no create→running→done view
7. **Subagent success/failure invisible** — no lane-level pass/fail indicator
8. **Duration comparison impossible** — linear list can't show which parallel agent is the bottleneck

### Navigation (9-10)
9. **Spawn point not clickable** — `Agent×4` shows input JSON but can't jump to the spawned session
10. **No reverse navigation** — inside a subagent session, can't trace back to spawning orchestrator turn

### Resources (11-12)
11. **Context window state invisible** — fill level, compaction events, approaching-limit warnings not shown
12. **Model type + context window size invisible** — different agents use different models with different limits

## Constraints

- **Zero dependencies** — ccxray ships no build step, no npm deps beyond Node.js
- **No data-layer rewrite** — edges (spawn, parent, parallelism, timing) are already captured; this is a new view consuming existing data
- **Must coexist with existing UI** — replaces the Turns column only; Projects, Sessions, topbar, and detail pane format are preserved
- **Performance** — must handle 471-turn sessions (fable-161) smoothly
- **Dark theme** — bg #0d1117, surface #161b22, border #30363d, text #e6edf3, dim #8b949e

## Design Decisions

### Rejected approaches (prototyped and evaluated)

| Approach | Why rejected |
|----------|-------------|
| **A: Swimlane Flow** (horizontal bars, spawn/fan-in curves) | Bars pile up at 346+ turns; too much ink per turn |
| **B: Git Graph** (vertical topology, colored branch lines) | Branch lines become spaghetti at 6+ lanes; vertical layout wastes horizontal space |
| **C: Heatmap Swim** (context-colored bars) | Same density problem as A; color overload |
| **Progressive disclosure** (collapse/expand teams) | Tufte: "you're hiding data, not designing it"; adds affordance problems |

### Chosen: Tufte Sparkline Small Multiples + Existing ccxray Detail

> "346 turns is not too much information — your pixel allocation is too wasteful."

**Principle:** Show all data at once using high density. Let the eye do pattern recognition instead of making the user click to reveal hidden state.

## Layout

```
┌─ Topbar (unchanged) ──────────────────────────────────────────────────────┐
├──────────┬───────────────┬────────────────────────────────────────────────┤
│ PROJECTS │ SESSIONS      │ OVERVIEW (full-width bar)         + − ⟲      │
│          │               │ ░░░░░░░░[████████████]░░░░░░░  0    2.5h  5h │
│ (full    │ (full         ├────────────────────────────────────────────────┤
│  height) │  height)      │ ▶main ▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕  (STICKY)     │
│          │               │       ▁▂▃▃▃▅▅▆▆▇▇██████                      │
│ ● ccxray │ ● 4ff947ed    │ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ (scrollable) ─ │
│          │   opus-4-6    │  sub1 ▕▕▕▕▕▕░░▕▕                             │
│          │               │  sub2 ▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕                       │
│          │ ○ 1085045f    │  sub3 ▕▕▕▕▕▕▕▕▕                              │
│          │   opus-4-8    ├══ resize handle (drag to adjust) ═════════════┤
│          │   154t $26.42 │  ┌─ Agent Card (240px) ─┐ ┌─ Timeline Steps ─┐│
│          │               │  │ ▎spec-routing      ★ │ │ TIMELINE          ││
│          │ ○ 1bd91918    │  │ ▎fable-5 19t 1.7m    │ │ ● spec-routing   ││
│          │   opus-4-6    │  │                      │ │                   ││
│          │   72t $2.58   │  │ 39.7% (397K/1000K)  │ │ #44  Bash  13.2% ││
│          │               │  │ peak 39.7%           │ │ #45  Read  13.5% ││
│          │               │  │ ┌───────zone bars──┐ │ │ ⏸ 10.0m          ││
│          │               │  │ │╌╌╌╌╌╌╌╌╌╌╌83.5% │ │ │ #46  Bash  14.1% ││
│          │               │  │ │═══════════ 40%   │ │ │  (ctx% yellow    ││
│          │               │  │ │█████████ ⏸ ████  │ │ │   = cache cold)  ││
│          │               │  │ └──────────────────┘ │ │                   ││
│          │               │  │ CACHE  95.2% hit     │ │                   ││
│          │               │  │ ████████ ⏸ █░░████   │ │                   ││
│          │               │  │ COST  $0.738         │ │                   ││
│          │               │  │ ▒▒▒▒▒▒▒▒ ⏸ ▒▒████   │ │                   ││
│          │               │  └──────────────────────┘ └───────────────────┘│
│          │               │  ↑↓ steps  Esc reset  ⌘scroll zoom  drag pan  │
└──────────┴───────────────┴────────────────────────────────────────────────┘
```

### Key layout rules

1. **Topbar** — unchanged from current ccxray (branding, nav tabs, breadcrumb, quota ticker)
2. **Projects column** (160px) — full window height, scrollable independently
3. **Sessions column** (200px) — full window height, scrollable independently
4. **Right area** — everything right of Sessions extends to window edge
5. **Overview bar** (32px) — full-width, always visible at top of right area (Shneiderman: "overview first")
6. **Main lane + time axis** — sticky at top of timeline section, never scrolls away
7. **Sub-agent lanes** — scrollable below the sticky main lane
8. **Resize handle** — draggable divider between timeline and detail (min 60px timeline, min 150px detail)
9. **Agent Card** — 2px left border accent, connects visually to timeline lane
10. **Lane label width = Agent Card width** (240px) — visually one continuous left column
11. **Star (★)** appears before step number in Timeline Steps, not after

## Interaction Flow

### Session Selection
1. User clicks a session in the Sessions column (not tabs — sessions are in the column)
2. Workflow Timeline renders with all agent lanes (sparkline small multiples)
3. Main agent lane auto-selected; Agent Card + Timeline Steps appear below
4. No separator line between timeline and detail — they are one continuous vertical space

### Lane Selection
| Action | Result |
|--------|--------|
| Click lane label (240px area) | Select agent → Agent Card shows agent summary, Timeline Steps shows all turns |
| Click specific turn bar | Select agent + scroll Timeline Steps to that turn |
| Click different lane | Switch Agent Card + Timeline Steps to new agent |
| Esc | If zoomed → reset zoom. If not → back to main agent |
| ← main button | Return to main agent (never blank) |

### Timeline Interaction
| Action | Result |
|--------|--------|
| Horizontal drag | Pan time axis |
| Vertical drag | Scroll lanes (when many sub-agents) |
| Horizontal scroll (trackpad) | Pan time axis |
| Vertical scroll | Scroll lanes |
| Ctrl/⌘ + scroll | Zoom centered on cursor |
| Double-click | Reset to full session view |
| Hover turn bar | Tooltip: turn#, model, ctx%, tools, duration |

### Overview Bar (always visible, top of right area)
- Full-width horizontal bar showing entire session at reduced scale
- Scale labels: 0 / midpoint / total duration
- Blue rectangle = current viewport, dimmed outside
- **Viewport duration label**: blue pill badge at bottom-right of viewport rect
- `+` / `−` / `⟲` buttons for zoom in / out / reset
- Lane density bars proportional to turn activity

**Overview interactions:**
| State | Action | Result |
|-------|--------|--------|
| Not zoomed | Drag | Brush-to-zoom: draw selection range (crosshair cursor), zoom on release |
| Zoomed, on edge | Drag left/right boundary | Resize viewport start/end time (col-resize cursor) |
| Zoomed, inside | Drag | Pan viewport (grab cursor) |
| Zoomed, outside | Drag | Brush-to-zoom (new selection) |

### Agent Card (240px, left side of detail area)

**Agent summary** (default state):
- Agent name, model badge, turn count, duration, type (orchestrator/fork/general/codex)
- ★ star toggle (stars the entire agent; reflected on lane label)
- Context bar chart with three zone colors:
  - Green (#3fb950) — 0-40% (smart zone, good cache behavior)
  - Yellow (#d29922) — 40-80% (degradation zone)
  - Red (#f85149) — 80%+ (danger zone, near autocompact)
  - Context % normalized to lane's context window (avoids zigzag from model switches)
- Cache hit rate + inline bar chart (yellow bars for < 50% cache hit turns)
- Cost total + avg/turn + inline bar chart
- All three charts share X axis (turn index), clickable → select turn, accent cursor highlights the selected turn across all three
- **Idle gap markers**: amber (#d29922) dashed vertical lines between turns where idle > 5 min (cache TTL); markers span all three charts at the same X position
- Navigation items: Timeline (step count), Context (System/Core/MCP/Skills), Analysis (Cost), RAW (Request/Events) — with › chevrons
- Tools summary, Tokens summary, Spawns count
- ← main button (for subagent cards)

### Timeline Steps (right side of detail area, production ccxray style)
- Step rows: ★ star → #num → model badge → tool group → ctx% → duration
- ★ appears **before** the step number (leftmost element)
- **Tool group rendering** (matches `public/messages.js`): tools listed vertically with ┌│└ brackets when multiple; tool names in green (#3fb950) with ×count; spawn badges (`⑂ agent-name`) integrated in bracket group
- **Thinking turns**: 🧠 indicator with duration for long thinks (>5s)
- Selected step highlighted with blue left border
- Scrollable; auto-scrolls to selected turn
- **ctx% color**: gray (#8b949e) = cache warm (≥50% hit), yellow (#d29922) = cache cold (<50% hit)
- **Idle separator rows**: when gap between turns > 5 min, insert `⏸ 10.0m` separator in amber; only states the idle duration (no assumptions about cache state — the ctx% color is the evidence)
- Keyboard nav: ↑↓/jk steps, f star, n next star, E prev error, s next skill, a next subagent

### Star Functionality
| Target | How | Where visible |
|--------|-----|---------------|
| Turn | ★ on step row (before #num) | Timeline sparkline shows ▲ marker at turn position |
| Agent | ★ on Agent Card header | Lane label shows ★ |

## Sparkline Timeline Visual Encoding

### v8 — ctx-split turn bars (2026-07-04, current; supersedes v1.10 zone coloring below)

Design iteration history and rationale live in `prototype/swimlane/DESIGN-DECISIONS.md` (v8 chapter, 9.03/10). This section records what production (`public/workflow-timeline.js`) implements.

**Motto:** 高=滿 · 色=區 · 位=勢 · 線=界 · 點=事 · 橘=貴

#### Lane anatomy (collapsed 64px / expanded 88px)

| Track | Height | Encoding |
|-------|--------|----------|
| ctx% bars | 44px | Bar height = context window %. Stacked fill: cache read `#58a6ff` (bottom) / cache write `#f0883e` / input `#8b5cf6` (top). 40% gray + 80% red dashed threshold lines with right-edge labels |
| cost | 8px | Mini bars ∝ $ within lane; gray `#484f58`, orange `#f0883e` when > 3× lane median (outlier = the only preattentive cost signal — no cost event dot) |
| events | 8px collapsed / 4×8px expanded | 4 fixed-order tracks × exclusive color family, max 4 types each: Faults (red) / Context (purple) / Mutations (green) / Safety (amber). Collapsed shows **Faults + Safety only** — a healthy session's collapsed track looks empty |

Zone hue on turn bars is **removed** — zone semantics moved to the threshold lines (position-encoded, color-blind safe). Zone colors (`#3fb950/#d29922/#f85149`) still apply to the overview minimap, context minimap fill, and step list ctx% column (see P12 amendment).

#### Event detection (wired to real SSE entry fields)

| Event | Track | Signal |
|-------|-------|--------|
| error | Faults | non-2xx `status` or `toolFail` |
| rate-limit | Faults | `status` 429 |
| retry | Faults | `isRetry` (wins over 429) |
| compaction | Context | `isCompacted` |
| cache-miss | Context | cache read < 50% of input, input > 1k tokens |
| ctx80 | Context | ctx% crosses 80% (fires on crossing only, not every turn above) |
| file-write | Mutations | `toolCalls` has Write/Edit/MultiEdit/NotebookEdit |
| credential | Safety | `hasCredential` |

Deferred until server signals exist: perm-denied, git-commit, danger-bash, perm-prompt, unsafe-blocked. MCP/skill calls stay out of event tracks (not sparse enough) — tooltip only.

#### Tri-state interaction

| State | Trigger | Visual |
|-------|---------|--------|
| Idle | — | everything 100% opacity |
| Hover | mousemove over lane chart | **bars 1..N bright** (cumulative — API sends the whole conversation), rest 0.2; cost/event dots only N; rich tooltip |
| Locked | click chart (nearest turn) | spotlight persists across re-renders; other lanes dim 0.35; `#wf-cursor` band marks the locked turn across all lanes. Same-turn click or Esc unlocks |

Position marking is carried by the bar-highlight boundary (hover edge) plus the pre-existing `#wf-cursor` band (lock position). The prototype's per-lane cursor guide and lock-ghost line were **dropped in production** — they compensated for the prototype's lack of a cross-lane band (see DESIGN-DECISIONS.md dashboard-integration lessons). The band stays selected-turn-only: cumulative extent is the bar spotlight's job (within lane), the band's job is cross-lane time alignment.

Legend (read/write/input) renders inside the main SVG's axis row label zone (x 0–240, otherwise empty) — zero layout cost, no competition with the overview minimap.

### v1.10 — Context-Zone Turn Coloring (superseded by v8 above; kept for minimap/overview/step-list rationale)

**Problem:** Turn bars were colored by model name (hardcoded color table). This doesn't scale — model count grows with new providers, human color perception caps at ~8 distinguishable hues, and the lane label already displays the model name (redundant encoding). Meanwhile, the most actionable signal (context window pressure) required reading a separate sparkline that was hard to parse at overview scale.

**Decision:** Turn bar color encodes **context window zone** — the one dimension that demands immediate attention. Model identity stays in the lane label (text) where it belongs.

**Constraints:**
- Width already encodes elapsed duration — cannot use width for a second dimension
- Must work at 4px minimum turn width (zoomed out)
- Must work on iPad touch (44px tap target per row)
- Overview minimap must use the same visual language as turn bars

#### Turn bar color — context zone (3 discrete levels)

| Zone | Condition | Color | Meaning |
|------|-----------|-------|---------|
| Smart | ctx < 40% | green (#3fb950) | Healthy — good cache behavior, plenty of room |
| Dumb | 40% ≤ ctx < 80% | yellow (#d29922) | Degrading — cache less effective, context filling |
| Danger | ctx ≥ 80% | red (#f85149) | Near autocompact — agent may lose context |

Context % = `tokens.input / contextWindow` (per-model, from `server/config.js`).

#### HTTP error turns — hatched fill (independent of ctx zone)

Error (non-2xx status) and ctx zone are orthogonal. A turn can be green+error or red+error. Encoding both:

- **Normal turn:** solid fill in zone color
- **Error turn:** zone color fill + 45° SVG hatching pattern overlay

```
 Normal ctx-green:   ████████
 Error  ctx-green:   ▨▨▨▨▨▨▨▨   ← green + hatching = "healthy context, but call failed"
 Normal ctx-red:     ████████
 Error  ctx-red:     ▨▨▨▨▨▨▨▨   ← red + hatching = "danger zone AND call failed"
```

Hatching is visible at any width (pattern tiles at 4px) and uses a distinct visual channel (texture) from color, so the two signals never conflict.

#### Model fallback turns — dashed border

When a turn's model differs from the lane's primary model (e.g. haiku fallback in an opus lane):

- 1px dashed border on the turn bar (zone color fill unchanged)
- Tooltip shows actual model name

This is rare; a subtle marker suffices.

#### Selected turn — white stroke (unchanged)

#### Unselected lane — turn bars only

No sparkline. Turn bar zone color IS the context signal. One row, 8px height + 4px gap.

```
 main         ██ ██  ████ ██████ ██ ████ ██ ██████ ██ ██
 opus-4-6 1000K       yel   RED              yel
```

#### Selected lane — turn bars + cache + cost (+2 rows)

Turn bars stay identical. Two rows expand below:

```
 ▶ main         ██ ██  ████ ██████ ██ ████ ██ ██████ ██ ██
   opus-4-6 1000K       yel   RED              yel
 ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
   CACHE        ██ ██  ████ ░░░░░░ ██ ████ ██ ██░░██ ██ ██
 ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
   COST         ▁▁ ▁▁  ▂▂▂▂ ████████ ▁▁ ▃▃▃▃ ▁▁ ▂▂▁▁ ▁▁
```

**Cache row** (20px): same position and width as turn bar. Brightness encodes cache hit %. Bright (#3fb950 at full opacity) = high hit, dim (#3fb950 at 20% opacity) = low hit. Continuous encoding via opacity, not discrete buckets.

**Cost row** (20px): bar chart, bottom-aligned. Height ∝ relative cost within the lane (max turn = full height). Color: orange (#ffa657). Spike turns are visually obvious.

Three visual channels, three questions: **color** = context enough? **brightness** = cache working? **height** = how much did it cost?

#### Overview minimap — same zone colors (M1)

Minimap turn marks use the same ctx zone color as the main turn bars. The minimap is a 1:1 color-reduced thumbnail of the timeline — zero new visual language to learn.

```
 ┌──────────────────────────────────────────────────────────┐
 │ main  ▪▪ ▪▪ ▪▪▪▪ ▪▪▪▪▪▪ ▪▪ ▪▪▪▪ ▪▪ ▪▪▪▪▪▪ ▪▪ ▪▪      │
 │        g  g   y    R            y       g   y           │
 │ sub-7 ▪ ▪▪ ▪ ▪▪▪ ▪ ▪▪ ▪▪▪ ▪ ▪▪                         │
 └──────────────────────────────────────────────────────────┘
```

Error hatching is omitted at minimap scale (too small to render). Error turns appear as their zone color — the minimap's job is spatial overview, not per-turn diagnosis.

### Deprecated: per-model color table

`WF_MODEL_COLORS` is no longer used for turn bars or overview minimap. It may be retained solely for the Agent Card color bar (2px left border) if desired, but is no longer a scaling concern since it doesn't affect the main timeline encoding.

**Spawn connectors:** 0.5px gray (#30363d) vertical lines from parent turn to child lane's first turn. Subtle — spatial alignment on time axis is the primary signal (unchanged).

**Lane labels (240px, same width as Agent Card):** `agent-name` + `model  ctxWindowK` directly integrated. Selected lane: `▶` prefix + 2px blue left bar + subtle blue background (unchanged).

## Context Threshold Reference Lines

On the Agent Card minimap:
- **40%** — green dashed line, labeled "40%" — smart zone ceiling
- **80%** — red dashed line, labeled "80%" — danger threshold, shows ⚠ warning if peak exceeds

## Agent Card Charts (unified X axis)

Three charts stacked vertically in the Agent Card, all sharing turn-index X axis:

1. **Context minimap** — **Moved to always-visible minimap column (see P10/P16)**. Agent Card shows text-only context stats (peak %, current %, window size).
2. **Cache hit sparkline** (14px height) — bar chart, green (#3fb950), dim when < 50%
3. **Cost sparkline** (14px height) — bar chart, orange (#ffa657)

Click any chart → select nearest turn → accent cursor rect appears on all three → Timeline Steps scrolls to that turn.

## Timeline Vertical Scrolling

When agents exceed the visible height (common with Workflow spawning 10+ subagents), the timeline area scrolls vertically. Lane labels scroll with the timeline (they are part of the SVG). The minimap always shows all lanes regardless of scroll position.

## Workflow Collapse/Expand

Dynamic Workflow (`Workflow` tool) subagent turns can be collapsed into a single summary lane:

```
Collapsed:
  main   ▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕
  ▸ wf: issue-priority-planning  2 phases · 8 agents · 147 turns  ████████████

Expanded (click ▸):
  main   ▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕
  ▾ wf: issue-priority-planning
    issue-48  ▕▕▕▕▕▕▕▕▕▕
    issue-64  ▕▕▕▕▕▕▕▕
    issue-82  ▕▕▕▕▕▕▕▕▕▕▕▕
    feature   ▕▕▕▕▕▕▕▕▕▕▕
    synth     ▕▕▕▕▕▕▕
```

### Data source for Workflow grouping

The Workflow `tool_use` input contains a `script` field with:
- `export const meta = { name, description, phases[] }` — workflow identity
- `agent()` calls with `label` and `phase` parameters — subagent structure
- `parallel()` / `pipeline()` calls — execution topology

The Workflow `tool_result` returns: Task ID, Summary, Run ID, Transcript dir. **No per-agent completion status** — that information only exists in Claude Code's internal harness (task-notifications), not in the API traffic ccxray captures.

### Collapse heuristic
1. Parse `meta.name` and `meta.phases[]` from the Workflow tool_use input script
2. Group all subagent turns that fall within the Workflow's time window (from Workflow tool_use to the next orchestrator turn after all subagents complete)
3. Show collapsed by default when subagent count > 4
4. Click ▸/▾ to toggle

## Subagent Lane Inference (revised after prototype iteration)

### Cross-session join (critical for production)

Subagent API calls run in their own `session_id`, separate from the parent orchestrator.
Real data: 751 sessions, 612 are ≤10-turn subagent sessions. They MUST be joined back to the parent session for the workflow view to work.

**Production requirement:** `scripts/extract-fixture.js` (and server-side store) must:
1. Parse spawn records from parent session turns (`agentSpawns[]`)
2. Match spawned agent name → subagent `session_id` (via temporal proximity + model matching)
3. Merge subagent turns into parent session as separate lanes
4. Subagent sessions viewed alone have no value — always show in parent context

**Prototype status:** Uses placeholder lanes (`◇ spawned` marker) because fixture has no cross-session data.

### Heuristic (within a single session's turns)

Turns assigned to lanes using priority order:
1. **Model mismatch** (strongest signal): if `turn.model !== mainLane.model`, the turn is a subagent — no time limit on spawn matching
2. **Context % drop** (secondary): `contextPercent < orchCtx * 0.5 AND < 25%` with 120s time window
3. **Orphan lane**: if model mismatches but no spawn matches at all, assign to `subagent-{model}` catch-all lane
4. **Placeholder lanes**: spawns with no matched turns (subagent in separate session) get empty lanes with spawn marker
5. Main lane gets everything else
6. Lane model = dominant model across turns

### Prototype changes from original spec
- Model mismatch removes the `orchCtx > 20` gate that blocked all separation for low-context sessions
- No time window for model-mismatched turns (haiku turn in opus session is always a subagent)
- Orphan lane prevents model-mismatched turns from polluting main even without a spawn match
- Placeholder lanes show spawn topology even when subagent turns are in separate sessions

## Design Amendments (from prototype evaluation)

### P1: Content-Driven Timeline Height (score 9.2)

Timeline section height adapts to content instead of fixed `max-height: 45vh`:
```
timelineH = clamp(MIN_H, laneCount × LANE_H + AXIS_H + PAD, 45vh)
```
- Single-lane: ~54px, detail gets maximum space
- Multi-lane: grows proportionally, capped at 45vh
- Overview bar always visible (useful for zoom even on single-lane 319t sessions)
- CSS `transition: max-height 200ms ease` for smooth spawn-time growth
- Resize handle override preserved — user drag takes priority

### P2: Charts Inline in Selected Lane (score 9.1, revised)

Cache hit and cost charts render **inside the selected lane's SVG**, not in a separate header:
- **Unselected lanes**: 12px — turn bars (8px) + gap (4px). No sparkline — context zone is encoded in turn bar color.
- **Selected lane**: 52px — turn bars (8px) + cache hit row (20px) + cost row (20px) + gap (4px)
- Charts share the same time axis as the lane's turn bars — no separate X axis or viewport mapping
- Selecting a different lane collapses the previous and expands the new (SVG height recalculated per render)
- Agent Card is text-only summary (context stats, cache %, cost total, tool frequency)

### P5: Bidirectional Selection Sync (spec clarification)

All views sync on turn selection — click any one, all others update:
- Click **turn bar** in lane SVG → selectTurn → steps panel highlights + scrolls, agent card updates
- Click **step row** in steps panel → selectTurn → lane SVG highlights turn bar, overview updates
- Click **lane label** → select lane, steps panel shows that lane's turns, agent card updates
- Keyboard **j/k** → navigate turns within selected lane with full sync
- **Zoom/pan** → steps outside viewport dimmed (opacity 0.4)

### P6: Lane Label Tooltip

SVG `<title>` element on lane label text shows full `name · model · ctxWindowK` on hover.

### P7: Streaming State (score 9.2)

Active/in-progress turns have distinct visual treatment:
- **Turn bar**: ghost bar — zone color at 30% opacity + dashed right border, width grows 1fps via rAF (streaming turns use dim green until ctx% is known)
- **Sparkline**: gap (no point until response completes)
- **Steps Panel**: pulsing green dot (●) replaces ☆, tools appear incrementally, elapsed timer ticks
- **Thinking**: `>3s` no content_block_start → show `🧠 thinking...`
- **Charts**: pulsing green vertical line at rightmost X position
- **Lane spawn**: label at 50% opacity, pulsing ● in empty bars area
- **Completion**: immediate on SSE `message_stop` (bypasses rAF throttle), 200ms CSS transition to solid

### P9: iPad/Touch Experience (score 9.4)

All changes behind `@media (pointer: coarse)` or `touchstart` detection — zero desktop impact:
- **Resize handle**: 4px → 16px visual + grip icon (≡) + 44px touch hit zone via `::before`
- **Timeline pan/zoom**: `touch-action: pan-y` on SVGs, 1-finger horizontal drag = pan, 2-finger pinch = zoom, double-tap = reset
- **Direction lock**: 6px dead zone, `{ passive: false }` on touchmove
- **Overview bar**: zone-based hit-test replaces cursor affordances; edges light up 3px on touch-down; visible 🔍 button replaces hidden long-press brush-to-zoom
- **Tooltip**: tap = select + tooltip 40px above touch point; tap elsewhere = dismiss
- **Small targets**: snap-to-nearest bar within 22px radius (O(log n) binary search)
- **No `navigator.vibrate()`** (not supported in Safari)

### P10: Context Minimap — B++ Design (score 9.3)

Full-height Zed-inspired minimap with inline step labels, always visible alongside the step list. Addresses problems #11 and #12 simultaneously.

#### Core metaphor

Minimap total height = model's context window. Filled portion = consumed tokens. Each step's height ∝ its token count. Empty space = remaining capacity.

```
┌─── 60-70px ────┐
│▓ sys prompt   ▓│  ← thick: system prompt is biggest overhead
│▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│
│▓ #1 user      ▓│  ← inline label: step identity visible without hover
│▓ #2 Monitor   ▓│
│▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│  ← thick: large tool result
│▓ #3 asst      ▓│
│▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│
│▓ #4 Read      ▓│
│▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│
│                │  ← empty = remaining capacity
│ - - - - - - - -│  dumb zone threshold (40%)
│                │
│ - - - - - - - -│  danger zone threshold (80%)
│                │
│           200K │  ← context window size label
└────────────────┘
```

#### Design decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Primary role** | Health indicator (context fill) | ccxray's core value is context visibility; navigation is secondary since users already have step list, keyboard nav, and section nav |
| **Height basis** | Percentage (all minimaps same pixel height) | Absolute scaling (1M = 5× 200K height) breaks layout; zone coloring already encodes risk relative to window size |
| **Step height** | Token-proportional, min 3px | Step thickness directly shows "which step ate the most context" — no numbers needed |
| **Step labels** | Inline small text (8-9px) on each step block: `sys prompt`, `#24 Read`, `×5 Bash` | Eliminates hover-to-discover; step identity is preattentive, not attentive |
| **Width** | 60-70px (was 36-48px) | Wider to accommodate inline text; acceptable trade — on 1440px screen, Steps+Detail still gets ~950px |
| **Empty space** | Zone threshold dashed lines + labels | Prevents "broken UI" perception; empty space becomes information ("this much room left") |
| **Low-fill coalescence**（design intent — not yet implemented） | Adjacent same-type steps merge when individual height < 3px, show `×N` label inline | Preserves height=tokens metaphor; inline label (e.g. `×5 Read`) compensates for per-step granularity loss |

#### Zone threshold lines

Drawn in empty space as dashed lines with small labels:

| Threshold | Position | Style |
|-----------|----------|-------|
| Smart ceiling | 40% of minimap height | Green dashed, label "smart" |
| Danger | 80% of minimap height | Red dashed, label "danger" |

These match the existing turn bar zone colors (green <40%, yellow 40-80%, red ≥80%).

#### Interaction

| Action | Result |
|--------|--------|
| Hover step | Highlight + tooltip with token count: `"3200t"` (step identity already visible via inline label) |
| Click step | Detail panel scrolls to that step |
| Scroll detail | Viewport indicator (semi-transparent overlay) tracks visible region |
| First hover on minimap | One-time tooltip: `"高度 = context window (200K)"` — dismissed permanently |
| Cursor | `pointer` on steps, `default` on empty space |

> **Status:** hover/click/viewport are implemented (`renderMinimapHtml`); the one-time
> first-hover onboarding tooltip is design intent, not yet implemented.

#### Placement

**Always visible** in the workflow detail area (no focused mode toggle needed — see P16). Minimap renders as a 60-70px column on the **left edge** of the step list pane — adjacent to the Agent Card's context stats, forming a visual unit with all context information on the left side. (Zed puts its minimap on the right because it's navigation-first; ours is health-first, so it belongs next to the context numbers.)

Agent Card retains its existing text-only context stats (peak %, cache rate, cost) as the numeric complement to the minimap's visual.

#### Step coalescence（design intent — not yet implemented）

When a burst of small tool calls would render as <3px each:

```
Before coalescence:          After:
│ ▓ Read 120t   │  (1px)     │ ▓▓▓▓▓▓▓▓▓▓▓▓ │
│ ▓ Read 80t    │  (1px)     │ ×5 Read       │  ← inline label on merged block
│ ▓ Read 150t   │  (1px)     │ ▓▓▓▓▓▓▓▓▓▓▓▓ │
│ ▓ Read 90t    │  (1px)     hover → tooltip shows 5 individual steps
│ ▓ Read 110t   │  (1px)
```

Rules:
- Only merge adjacent steps of same tool type
- Merged block height = sum of individual token heights (metaphor preserved)
- Badge shows `×N`
- Hover expands to show individual step labels

#### Ceiling and tradeoffs

**Score: 9.3/10** (revised from 9.7 after P16 changes). Inline text labels are designed to recover most of the coalescence granularity loss — merged blocks would show `×5 Read` instead of requiring hover (coalescence itself is not yet implemented). The remaining 0.7 gap is: at 50+ steps with small fonts, labels may crowd — but this is the exact scenario where coalescence would trigger, reducing label count.

The upgrade path if this becomes a real pain: add a keyboard shortcut (e.g. `m`) to toggle between "proportional mode" (height=tokens, current) and "equal mode" (all steps same height, pure navigation). But YAGNI until user feedback says otherwise.

#### Edge cases

**Compaction:** A turn after auto-compaction shows reduced context (e.g. 95% → 20%). No special handling — P14 (follow attention) means the minimap shows cumulative state at the selected turn, so selecting the post-compaction turn simply shows 20% fill. The visual "shrink" when scrubbing past a compaction turn IS the information.

**System prompt / tools tokens:** Not yet rendered as a dedicated block — `buildMinimapBlocks()` currently builds only from the selected turn's step/message token blocks. Rendering the system prompt + tool definitions overhead as the first (thickest) block at the top remains the design intent; deferred until the fixed-tax token data is exposed per turn.

**Model switch mid-session:** Use the selected turn's model's `contextWindow` as the 100% reference. Bottom label updates (e.g. `1M` → `200K`). Zone thresholds are percentages, so they adapt automatically. Pixel height stays fixed (P11). No special handling needed — P14 + P11 + existing turn data cover it.

**Streaming turn:** Use current known token counts (input_tokens from request + output_tokens accumulated so far). Step height grows as output tokens accumulate — this is informative, not a bug. Visual treatment matches P7: 30% opacity + dashed top border on the streaming step. Completes to solid on `message_stop`.

### P12: Zone Color Consistency — Semantic Unity + Form Distinction (score 10.0)

All three zone-colored elements use the **same hex values and thresholds**. Identity is conveyed by form, not color variation.

#### Single color constant

```js
const ZONE = {
  smart:  { color: '#3fb950', threshold: 0.40 },
  dumb:   { color: '#d29922', threshold: 0.80 },
  danger: { color: '#f85149', threshold: 1.00 },
};
```

Overview, swimlane turn bars, and minimap fill all reference this one object.

**v8 amendment (2026-07-04):** swimlane turn bars no longer use zone *hue* — they encode ctx% via height against the same 40/80 thresholds, drawn as dashed lines in the bar area. The ZONE object still drives the overview minimap, context minimap fill, step-list ctx% column, and the swimlane's threshold-line colors (gray/red). Semantic unity holds: the same thresholds appear everywhere; the swimlane expresses them by position, the others by color.

#### Form distinction (why they won't be confused)

| Element | Direction | Selection marker | Additional signals |
|---------|-----------|------------------|--------------------|
| Overview | Horizontal, 2-6px micro blocks | Viewport rect + 1px selected-turn indicator line (#111) | Scale labels, duration badge |
| Swimlane turn bar | Horizontal, 44px × width∝duration, height∝ctx% (v8) | Semi-transparent accent position cursor rect | Threshold dashed lines, cost track, event tracks |
| Minimap fill | **Vertical**, height∝tokens, 60-70px wide | Hover highlight | Zone threshold dashed lines, bottom size label, **inline step labels** |

The vertical vs horizontal orientation is the strongest differentiator — minimap is the only vertical element. Overview and swimlane are both horizontal but differ in scale (micro vs readable), selection marker (indicator line vs cursor rect), and reading distance (global positioning vs time navigation).

#### Design principle

Color speaks semantics (green = safe, yellow = degrading, red = danger). Form speaks identity (where am I looking). Never use color to distinguish elements from each other — that overloads the color channel and breaks the semantic mapping.

### P16: Remove Focused Mode — Always Side-by-Side with Draggable Resize (score 9.5)

Steps list and Step Detail are always visible side-by-side. No focused mode to enter/exit. A draggable resize handle between Steps and Detail lets users adjust the ratio.

#### Why remove focused mode

The workflow layout (Agent Card + minimap + Steps + Detail) already shows all information simultaneously. Focused mode added a binary toggle (normal ↔ expanded detail) that:
- Required learning a concept ("what is focused mode?")
- Required mode switching (Enter to enter, Escape to exit)
- Created code complexity (`isFocusedMode` guards, CSS overrides, `wfDeferRender` re-renders)
- Was only useful for expanding Detail width — solved more simply by a draggable handle

#### Draggable resize handle

| Behavior | Detail |
|----------|--------|
| Default width | Steps 360px (or persisted from last drag, clamped 360–500px) |
| Drag | Adjusts steps pane pixel width, live resize, no layout reflow outside the two panels |
| Min widths | Steps ≥ 360px (includes 64px minimap), Detail ≥ 280px (CSS `min-width`) |
| Persist | Save pixel width to `localStorage` key `ccxray-steps-width` on drag end |
| Keyboard | No keyboard equivalent needed — j/k navigate steps, content appears in Detail |

#### Impact on existing code

Workflow mode **bypasses** focused mode rather than removing it: `enterFocusedMode()` returns early when `wfState` is active, and `isFocusedMode` / `exitFocusedMode()` / `.focused` remain in place for classic (non-workflow) sessions. `inSplitView()` covers both states. The existing `#wf-resize` handle (between timeline and detail area) stays; this adds a second handle within the detail area.

#### Layout (always-on)

```
┌──────────┬──────────┬──────────┬──┬────────────────┬─────────────────────┐
│ Projects │ Sessions │ Agent    │mm│ Steps          │ Step Detail          │
│          │          │ Card     │ii│                │                      │
│          │          │          │nn│ #1 user    ✓   │ [content of          │
│          │          │ Context  │ii│ #2 Monitor ✓ 🏷│  selected step]      │
│          │          │ Peak 18% │mm│ #3 asst    ✓   │                      │
│          │          │ Win 1M   │aa│ #4 Read    ✓ 🏷│                      │
│          │          │ ...      │pp│ ...             │                      │
│          │          │          │  │         ↕ drag  │                      │
└──────────┴──────────┴──────────┴──┴────────────────┴─────────────────────┘
                                                ↑
                                          resize handle
```

### P15: Minimap ↔ Overview Selection Sync (score 9.5)

Minimap participates in the existing bidirectional selection sync (P5). No new sync mechanism needed.

| Action in minimap | Result |
|-------------------|--------|
| **Hover** step | Tooltip only (step label + token count). No global sync — hover is preview, not commit. |
| **Click** step | Calls `selectTurn` → overview indicator line moves, swimlane position cursor moves, detail panel scrolls. Standard P5 flow. |

This matches swimlane behavior: hover shows tooltip, click triggers sync. Consistent across all three elements.

#### Overview indicator line (implemented — #111)

A 1px bright vertical line is drawn on the overview canvas at the selected turn's position (`workflow-timeline.js` overview render), keeping the overview and swimlane selection in sync.

### P14: Minimap Follows Selected Turn (score 9.2)

Minimap displays cumulative context state up to the **selected turn**, not the latest turn. Selecting turn #20 shows steps from turn 1-20; selecting turn #54 shows steps from turn 1-54.

#### Why follow selection

The user's core question is "what was the context state at this turn?" Fixed-latest minimap (always showing the final turn) can't answer this — it breaks the mapping between selection and display, scoring 4.9/10.

#### Behavior

- Select turn → minimap redraws with steps from turn 1 to selected turn
- Fill height = cumulative token usage up to that turn
- Zone coloring reflects the context % at that turn (green/yellow/red)
- Zone threshold lines stay fixed (they're percentages of the window, not of the content)
- Switching turns causes a visual "grow/shrink" of the fill — this IS the information (context growing over time)

#### Implementation note

Each turn selection triggers a minimap redraw. Step list is derived from `allEntries.filter(e => e.receivedAt <= selectedTurn.receivedAt && e.sessionId matches)`. Token breakdown per step is already available from `input_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens` fields in turn data.

### P13: No Lane-Level Context Gauge in Swimlane (score 9.2)

Swimlane lanes do NOT get a context fill bar or gauge. Context health is the minimap's job (P10). The swimlane focuses exclusively on time navigation.

#### Why not

Turn bar zone colors already encode per-turn context state. Adding a lane-level aggregate gauge creates functional overlap with the minimap and introduces a vertical axis that conflicts with the horizontal time axis.

#### Impact on existing code

**Zero changes.** `wfRenderLaneSvg` in `workflow-timeline.js` already renders only turn bars + cache row + cost row for selected lanes. No context gauge exists to add or remove.

#### Implicit bridge

Turn bar zone colors serve as the bridge between swimlane and minimap: user sees a yellow turn bar in swimlane → looks at minimap → sees the fill level and zone threshold proximity. No explicit bridge element needed.

### P11: Minimap Height Basis — Equal Height + Window Size Label (score 9.3)

All minimaps render at the **same pixel height** regardless of model context window size (1M, 200K, etc.). Fill ratio is percentage-based. Absolute window size shown as a numeric label at bottom.

#### Why not proportional height

Proportional (1M = 5× the height of 200K) was evaluated and scored 6.7/10. Fatal flaw: switching between agents causes minimap to jump from ~80px to ~400px, breaking layout stability. Also, small-window agents (200K) get minimaps too short to read.

#### Three-layer risk communication

No single layer carries the full picture — they stack:

| Layer | Type | What it tells | Speed |
|-------|------|---------------|-------|
| Fill ratio | Preattentive (area) | How full is this agent's context | Instant |
| Zone coloring | Preattentive (color) | Is this dangerous *for this window size* | Instant |
| Bottom label | Attentive (text) | Absolute window size (`200K`, `1M`) | On demand |

Zone thresholds are the same percentage for all window sizes (40% smart, 80% danger), so color already encodes "risk relative to this agent's capacity." Users don't need to mentally convert between window sizes — a yellow minimap means degradation regardless of whether it's 200K or 1M.

#### Switching behavior

Agent switch changes: fill ratio, zone color, bottom label, step content. Does NOT change: minimap pixel height, threshold line positions, overall layout. Zero layout reflow.

## Compromises

| What | Compromise | Upgrade path |
|------|-----------|-------------|
| Cross-session join | Placeholder lanes with `◇ spawned` marker | Fixture extractor does session_id → spawn name matching |
| Task lifecycle (#6) | Not addressed in v1 | Gantt-style Task track as separate view |
| Multi-layer spawn (#4) | Inference only handles 1 layer reliably | Explicit parent chain from server |
| Fork subagents | Share parent's cache fingerprint, hard to distinguish | Need session ID from subagent headers |
| Summary-only entries | `toolCalls` is `{name: count}`, no Agent descriptions | Load full `req.messages` for spawn labels |
| Context % accuracy | `input_tokens + cache_read + cache_create` may exceed window for 1M models | Validate against actual model context limits |
| Cost estimates | Rough pricing ($3/M in, $0.30/M cache, $15/M out) | Use ccxray's `server/pricing.js` for accurate rates |
| Touch step rows | 24px height below 44pt HIG | Full-width tap area adequate for dev tool audience |
| Chart on narrow screen | Scroll fallback at <2px/bar | Binning trades fidelity, not worth it |
| Detail width (P16) | No focused mode — detail limited to ~60% of right area | Draggable resize handle; full-screen detail view if resize proves insufficient |
| Minimap label crowding (P10) | Inline labels may crowd at 50+ steps | Coalescence（not yet implemented）would merge small steps, reducing label count at exactly the point crowding would occur |
| Overview indicator (P15) | Implemented (#111) — 1px bright line at selected turn | — |

## Test Data

10 sessions in `prototype-fixture.json`:

12 sessions extracted from real ccxray logs via `scripts/extract-fixture.js`:

| Session | Turns | Lanes | Model | Pattern |
|---------|------:|------:|-------|---------|
| `0df173ba` Simple baseline | 14 | 1 | opus-4-6 | Monotonic context growth |
| `9e8cfc3f` Compaction | 30 | 1 | sonnet-4-6 | Peak 88%, compaction drop |
| `00b05c48` Spawn-heavy | 83 | 1 | opus-4-6 | 48 subagents |
| `e80743c5` Workflow | 88 | **18** | opus+haiku | Multi-phase workflow |
| `84895640` Long session | 319 | 1 | opus-4-6 | Peak 100%, 5 idle gaps |
| `d4cc4b15` Fable ceiling | 44 | 1 | fable-5 | Peak 99%, edit-heavy |
| `1085045f` Opus-4-8 marathon | 154 | 4 | opus-4-8 | TaskUpdate-heavy, 5 idle gaps |
| `89e613a0` Model upgrade | 133 | 32 | opus-4-6→4-8 | Window shrink+expand |
| `b14c6bba` Low-context | 30 | 1 | opus-4-6 | Never exceeds 15% |
| `c609059b` Tiny compaction | 10 | 1 | sonnet-4-6 | 83→100→20% in 3 turns |
| `e0ef3ad0` Medium Bash | 41 | 1 | opus-4-8 | Debugging, peak 61% |
| `1bd91918` Haiku stress | 72 | 6 | opus+haiku | 10 Agent spawns |

## File Map

- Prototype: `prototype/tufte/index.html` + `tufte.js`
- Fixture: `prototype-fixture.json` (extracted from real logs)
- Fixture generator: `scripts/extract-fixture.js` (re-run to refresh from latest logs)
- Production target: `public/miller-columns.js` (replace Turns column), `public/workflow-timeline.js` (new), `public/messages.js` (reuse detail rendering)
- Server: no changes needed for v1 (all data already captured)
