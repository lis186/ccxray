# Design Principles

Extracted from P10-P16 context minimap and layout design decisions (2026-06-27/28). Applicable to all ccxray UI work.

## Principle Hierarchy

```
 ┌─ Decision ──────────────────────────────────────────────┐
 │  Information Colocation                                 │
 │  Put info where the user needs it at this stage.        │
 │  Accept only when gain > cost (visual + rendering).     │
 └────────┬────────────────────────────────────────────────┘
          │ constrained by
 ┌────────▼────────────────────────────────────────────────┐
 │  Channel Discipline    one channel = one semantic       │
 │  Layout Stability      containers don't jump            │
 │  Rendering Budget      no frame drops at max dataset    │
 └────────┬────────────────────────────────────────────────┘
          │ governs
 ┌────────▼────────────────────────────────────────────────┐
 │  Follow Attention      display tracks user selection    │
 └────────┬────────────────────────────────────────────────┘
          │ implemented via
 ┌────────▼────────────────────────────────────────────────┐
 │  Implicit Bridging     shared encoding connects areas   │
 │  Structured Emptiness  empty space carries information  │
 └─────────────────────────────────────────────────────────┘
```

## Principles

### 1. Information Colocation (decision layer)

Place the information the user needs at their current workflow stage where they can see it. Each additional dimension has two costs: visual complexity and rendering cost. Accept only when **information gain > total cost**.

This is the top-level decision. All other principles are constraints on how to execute it.

**Test:** "If I remove this element, can the user still answer their question from this view?" If yes, the element isn't earning its keep.

Origin: P10 accepted dual-purpose minimap (gain > cost). P13 rejected lane gauge (gain < cost because turn bar zone color already provides sufficient context awareness).

### 2. Channel Discipline (constraint)

One visual channel carries one semantic dimension. Don't overload.

| Channel | Semantic | Example |
|---------|----------|---------|
| Color (zone fill) | Risk level | Green = safe, yellow = degrading, red = danger |
| Color (lane hue) | Agent identity | Each lane gets a distinct color from the WCAG-contrast pool |
| Form | Element identity | Overview = micro blocks + indicator line, swimlane = bars + cursor, minimap = vertical fill + threshold lines |
| Horizontal position | Time | Turn bar X position = wall-clock time |
| Vertical height | Quantity | Minimap step height = token count |

**Test:** "Is this color encoding zone, or is it also encoding element identity?" If two semantics share a channel, one of them is wrong.

Origin: P12 — same hex values everywhere, form distinguishes elements.

### 3. Layout Stability (constraint)

Containers don't change size on state transitions. Content inside containers may change freely.

- Minimap pixel height stays fixed when switching agents (P11)
- Swimlane lane height stays fixed per selection state (v8: 64px unselected, 88px selected)
- Overview bar height scales adaptively: `min(innerHeight × 0.20, max(28, laneCount × 7 + 6))`. Selecting agents/turns never resizes it.
- **Exception — mode switch:** Birdseye overview (user-initiated toggle) expands the overview to ~80% viewport. This is a deliberate mode transition, not a state-change side effect, so it is allowed.

**Test:** "If the user clicks rapidly between agents/turns, does any container resize?" If yes, the layout is unstable.

Origin: P11 — equal-height percentage basis rejected proportional scaling because 1M vs 200K would cause minimap height to jump 5×.

### 4. Rendering Budget (constraint)

Design-caused frame drops are design problems, not implementation problems. Every visual decision must render smoothly on the largest known dataset.

Current ceiling: 471-turn session (fable-161), 32-lane session (89e613a0).

Applies to both the colocation decision ("adding this element costs N redraws per interaction") and follow-attention execution ("debounce/virtualize/cache if per-selection redraw exceeds frame budget").

**Test:** "On fable-161, does j/k key-repeat through 50 turns feel smooth?" If not, either reduce redraw scope or debounce.

Origin: P14 — minimap redraws on every turn selection. Acceptable for typical sessions, needs verification at scale.

### 5. Follow Attention (behavior)

Display state reflects what the user selected, not some default. If the user selected turn #20, all dependent views show the state at turn #20.

Constrained by rendering budget: if following attention requires expensive redraws on every selection change, use debounce, transition animations, or caching to stay within frame budget.

Interaction follows a two-level drill-down with explicit exit:

- **L1 (lane selected):** Tab / ▲▼ cycles lanes. All dependent views show the selected lane's aggregate state.
- **L2 (turn selected):** j/k cycles turns within the lane. All views drill into that specific turn.
- **Esc** walks back L2 → L1 → deselect.
- **Hover** is still preview only (no global sync).

**Test:** "The user selected turn #20. Does every view answer questions about turn #20, or is something showing turn #54?" If mismatched, the view isn't following attention.

Origin: P14 — minimap shows cumulative context up to selected turn. P15 — click syncs, hover doesn't.

### 6. Implicit Bridging (implementation technique)

Areas connect through shared encoding rather than explicit bridge elements. This only works when channel discipline is maintained — the shared encoding must mean the same thing everywhere.

The shared 40/80 thresholds are the bridge between swimlane and minimap (v8): user sees a bar top crossing the red dashed line → knows context is near danger → looks at minimap for the same red threshold with fill detail. Before v8 the bridge was turn-bar zone *color*; v8 moved it to threshold *position* — the bridge survived an encoding change because the semantic (same thresholds, same red/gray) stayed shared. No explicit gauge needed in the swimlane.

**Prerequisite:** Channel discipline. If swimlane thresholds sat at different percentages than minimap thresholds, or swimlane colors encoded "model type" while minimap colors encoded "zone," the bridge would be broken.

**Test:** "Can the user connect what they see in area A to area B without an explicit link element?" If yes, the bridge works.

Origin: P13 — rejected lane gauge because turn bar zone color already bridges swimlane ↔ minimap.

### 7. Structured Emptiness (implementation technique)

Empty space is information (remaining capacity), not broken UI. Give it structure so users read it as intentional.

Techniques: threshold lines with labels, zone background tinting, size annotations.

**Test:** "A first-time user sees 85% empty minimap. Do they think it's broken, or do they read 'lots of room left'?" If broken, add structure.

Origin: P10 — zone threshold dashed lines (smart/dumb/danger) in minimap empty space. First-hover tooltip explains the metaphor.

## Applying the Principles

When making a new UI decision:

1. **Start with colocation:** does the user need this info here? What's the gain? What's the cost (visual + rendering)?
2. **Check constraints:** which channel? Does the container stay stable? Can the largest dataset handle it?
3. **Define behavior:** does it follow attention? Hover preview or click commit?
4. **Choose technique:** can shared encoding bridge it implicitly? Can empty space carry it?

If a decision scores below 9.0 on the weighted evaluation, iterate until it passes or reject the addition.
