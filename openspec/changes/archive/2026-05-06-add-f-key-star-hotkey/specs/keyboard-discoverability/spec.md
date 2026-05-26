## ADDED Requirements

### Requirement: f-star cmd bar entry
Every `getCmdBarState()` context branch that currently shows hints SHALL also include an `f` entry with a dynamic star label.

- The entry SHALL be `{ key: 'f', label: _fStarLabel(), id: 'f-star', clickKey: 'f' }`
- `_fStarLabel()` SHALL return `'★ star'` if the current target is not starred, `'☆ unstar'` if it is starred, falling back to `'★ star'` when there is no target
- `isEnabled('f-star')` SHALL return `getStarTargetFromSelection() !== null`
- The entry SHALL appear in all six contexts: projects column, sessions column, turns column, sections column, focused mode (non-timeline), focused mode timeline row1
- `rerenderColumnsAfterStar()` SHALL call `renderCmdBar()` at its end (after column re-render) so the label syncs immediately after toggle

#### Scenario: Unstarred turn shows star label
- **WHEN** `focusedCol === 'turns'` and selected turn is not starred
- **THEN** cmd bar row1 includes `f ★ star`

#### Scenario: Starred session shows unstar label
- **WHEN** `focusedCol === 'sessions'` and selected session is starred
- **THEN** cmd bar row1 includes `f ☆ unstar`

#### Scenario: Label syncs after toggle
- **WHEN** user presses `f` to star a turn
- **THEN** after `rerenderColumnsAfterStar()` completes, cmd bar label changes from `★ star` to `☆ unstar`

#### Scenario: f entry disabled on sentinel
- **WHEN** selected session is `'direct-api'`
- **THEN** `f ★ star` renders with `disabled` class (opacity 0.3)

#### Scenario: Clicking f label triggers star
- **WHEN** user clicks the `f ★ star` button in the cmd bar
- **THEN** a synthetic `KeyboardEvent` with `key: 'f'` is dispatched and the star handler fires
