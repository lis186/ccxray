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
| **Timeline (v1.9.2)** | — (inside Steps Panel) | Reuses the full v1.9.2 timeline renderer (`renderStepListHtml`): human messages, thinking blocks with duration, tool calls with name/preview/status, star buttons, minimap, and focused split-pane mode. Replaces the earlier flat turn list. |
| **Focused Mode** | `.focused.wf-active` | Enter key or step click enters split-pane view (left: step list + minimap, right: step detail). `#col-turns` stays visible (CSS override). SVG/canvas re-renders at new width via `wfDeferRender`. `selectTurn` skips focused-mode exit when `wfState` is active. Keyboard nav (↑↓ steps, e/E/s/S/a/A/m/M jump) queries `#wf-steps-content` instead of `colDetail`. |
| **Position Cursor** | `#wf-cursor` | Semi-transparent accent-colored rect in swimlane (`position:absolute`, `z-index:10`) spanning the selected turn's time range (`receivedAt` to `receivedAt + elapsed`). Overview canvas draws a matching `fillRect`. Both use `_wfFindTurn` to resolve the turn object. Min width 3px; overview clamps to canvas bounds. Updated by `wfHighlightTurn`, `wfDeferRender` (pan/zoom), and `selectStep` (step navigation). All three areas (overview, swimlane, step list) stay in sync. |
| **Step Row** | `.tl-step-summary` | One step's display in the focused timeline. Row number + tool name/preview + status (✓/✗) + star + optional source badge. |
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
│          │               │  ↑↓ steps  Esc exit  ⌘scroll zoom  drag pan   │
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

### v1.10 — Context-Zone Turn Coloring (replaces per-model color)

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

1. **Context minimap** (48px height) — area chart with threshold lines
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
