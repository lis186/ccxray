## ADDED Requirements

### Requirement: Contextual command bar

A bar SHALL be permanently present at the bottom of the dashboard, showing the keyboard shortcuts available in the current UI state. It replaces the column-header hints and topbar hotkeys button.

#### Layout

`#app` SHALL use `display:flex; flex-direction:column; height:100vh; overflow:hidden`. The bar SHALL be a `flex-shrink:0` child at the bottom — NOT `position:fixed`. `#columns` SHALL have `min-height:0` so it yields space to the bar. This ensures column content never scrolls under the bar.

The bar contains two rows:
- `#cmd-bar-row1`: always rendered, 28px tall
- `#cmd-bar-row2`: always present in DOM, height controlled by `max-height` transition

```css
#cmd-bar-row2 {
  max-height: 0;
  overflow: hidden;
  transition: max-height 0.2s ease;
}
#cmd-bar-row2.visible {
  max-height: 24px;
}
```

Row2 SHALL never be removed from the DOM. `renderCmdBar()` SHALL update `row1.innerHTML` and `row2.innerHTML` independently, then toggle `row2.classList.toggle('visible', ...)`. This preserves the transition state on every render.

#### Rendering architecture

`getCmdBarState()` reads all relevant state variables and returns a data structure:

```
{
  row1: [ { key, label, enabled }, ..., { type: 'toggle' } ],
  row2: [ { key, label, enabled }, ... ] | null,
  row2Visible: boolean
}
```

`renderCmdBar()` iterates this structure to build innerHTML. Keys with `enabled:false` SHALL render at `opacity:0.3; color:var(--dim)`.

`getCmdBarState()` determines `enabled` via a centralised `isEnabled(keyId)` function. All key availability conditions are defined in this one function.

#### State table

| State | Row 1 content |
|-------|---------------|
| `_loading === true` | *(bar hidden — see Loading state)* |
| `currentTab !== 'dashboard'` | *(bar hidden)* |
| any `[data-hides-cmdbar]` overlay visible | *(bar opacity:0 — see Overlay)* |
| `focusedCol = 'projects'` | `↑↓` select · `→` open · `1` Dashboard · `2` Usage · `3` Sys Prompt |
| `focusedCol = 'sessions'` | `↑↓` select · `←` back · `→` open · `1` `2` `3` tabs |
| `focusedCol = 'turns'` | `↑↓` select · `←` back · `→` sections · `Enter` focus |
| `focusedCol = 'sections'` | `↑↓` select · `←` back · `Enter` focus detail |
| Focused Mode, section ≠ `timeline` | `↑↓` switch section · `Esc` exit |
| Focused Mode, `tlFilterActive` | `Esc` close filter |
| Focused Mode, `selectedSection = 'timeline'` | `↑↓` steps · `/` filter · `Esc` exit + toggle button |

#### Timeline second row

When `selectedSection = 'timeline'` and `!tlFilterActive`, row2 content is: `e` next error · `E` prev error · `t` thinking · `h` human · `]` text.

Row2 visibility is driven by a module-level variable `_timelineExpanded` (runtime source of truth). Initialised once from `localStorage.getItem('kbar-timeline-expanded') !== 'false'` (default: `true`).

On screens with `window.innerHeight ≤ 900px`, row2 SHALL be forced hidden regardless of `_timelineExpanded`. The stored preference is preserved but overridden view-only.

The toggle button in row1 SHALL:
- Display text `less ∧` when expanded, `more ∨` when collapsed
- Have `min-width:44px; height:100%` for touch target (WCAG AA)
- Have `tabindex="-1"` (excluded from tab order)
- Have `aria-label="collapse timeline shortcuts"` / `"expand timeline shortcuts"` and `aria-expanded` updated on every render
- On click: toggle `_timelineExpanded`, write `localStorage`, call `renderCmdBar()`

#### Enabled key conditions (`isEnabled`)

| Key ID | Enabled when |
|--------|-------------|
| `→-projects` | `projectsMap.size > 0` |
| `→-sessions` | `selectedSessionId != null` OR `visibleSessions.length > 0` |
| `→-turns` | `selectedTurnIdx >= 0` |
| `→-sections` | `selectedSection != null` |
| `enter-sections` | `selectedSection != null` |
| All others | always `true` |

#### Trigger points

`renderCmdBar()` SHALL be called from: `setFocus()`, `enterFocusedMode()`, `exitFocusedMode()`, `selectSection()`, `openTlFilter()`, `closeTlFilter()`. Additionally, the `keydown` handler SHALL call `renderCmdBar()` at its very end as a catch-all safety net.

#### Loading state

`getCmdBarState()` returns `null` when `_loading === true`. The bar renders as hidden (`display:none`). After `/_api/entries` resolves and `_loading` is set to `false`, `renderCmdBar()` SHALL be called once to show the bar.

#### Overlay state

Any element with `data-hides-cmdbar` attribute that is currently visible SHALL cause the bar to render as `opacity:0; pointer-events:none` (NOT `display:none`, to preserve flex layout space and prevent `#columns` height shift). Visibility is detected via `el.offsetParent !== null || el.style.display === 'flex'`.

All overlays that should hide the bar (`#kbd-overlay`, `#diff-overlay`) SHALL have `data-hides-cmdbar` in their HTML.

#### Scenarios

- **WHEN** `focusedCol` changes → bar content updates in the same render cycle
- **WHEN** user enters timeline Focused Mode for the first time → row2 visible (default `_timelineExpanded = true`)
- **WHEN** user collapses row2 and re-enters timeline → row2 remains collapsed
- **WHEN** `tlFilterActive` becomes true → bar shows only `Esc  close filter`
- **WHEN** `window.innerHeight ≤ 900` → row2 hidden regardless of preference
- **WHEN** kbd-overlay opens → bar becomes `opacity:0`, `#columns` height unchanged
- **WHEN** non-dashboard tab is active → bar hidden (`display:none`)
- **WHEN** `_loading === true` → bar hidden (`display:none`)
- **WHEN** `→` is shown but no turn is selected → `→ sections` key renders at `opacity:0.3`

---

### Requirement: Column focus visual indicator

The focused column SHALL have `border-top: 2px solid var(--accent)`. Non-focused columns SHALL have no top border.

#### Scenario: Accent border on focused column
- **WHEN** `focusedCol` changes
- **THEN** only the newly focused column has the accent top border
- **AND** all others have no top border

---

### Requirement: Keyboard shortcuts overlay

Pressing `?` outside an `INPUT` or `TEXTAREA` SHALL toggle a full-screen overlay listing all shortcuts. Dismissible via `Escape` or `?`. Overlay element has `data-hides-cmdbar`.

All text in English. Three sections:

- **Navigation**: `↑↓` select item · `←→` move between columns · `Esc` go left · `1/2/3` switch tab
- **Focused Mode**: `Enter` enter · `Esc` exit · `↑↓` switch section
- **Timeline**: `/` filter · `e/E` next/prev error · `t` thinking · `h` human · `]` text step

No topbar button. The command bar provides always-visible discoverability; `?` overlay provides the full reference.

#### Scenarios
- **WHEN** `?` pressed outside input → overlay appears
- **WHEN** overlay visible and `Escape` pressed → overlay dismissed
- **WHEN** `?` pressed inside `INPUT`/`TEXTAREA` → no-op

---

### Requirement: Escape navigates left in main mode

In main mode (not Focused Mode, not in input), `Escape` moves `focusedCol` one column left. No-op at `'projects'`.

#### Scenarios
- **WHEN** `focusedCol = 'sessions'` and `Escape` pressed → `focusedCol` becomes `'projects'`
- **WHEN** `focusedCol = 'projects'` and `Escape` pressed → no change
