## ADDED Requirements

### Requirement: Entries API returns session titles
The `/_api/entries` endpoint SHALL return a JSON object with shape `{ entries: Array, sessionTitles: Object }` where `sessionTitles` is a map of session ID to title string, containing only sessions that have a non-null title in `store.sessionMeta`.

#### Scenario: Response includes known titles
- **WHEN** the client fetches `/_api/entries`
- **THEN** the response body is `{ "entries": [...], "sessionTitles": { "<sid>": "<title>", ... } }`
- **THEN** `sessionTitles` contains every session whose title is non-null in `store.sessionMeta`

#### Scenario: No session titles exist
- **WHEN** no sessions have been titled yet
- **THEN** `sessionTitles` is an empty object `{}`

### Requirement: Client applies session titles after entries load
After populating `sessionsMap` from the entries array, the client SHALL iterate `sessionTitles` and apply each title to the corresponding session, then re-render any visible session card element.

#### Scenario: Title applied to known session
- **WHEN** `sessionTitles` contains a sid present in `sessionsMap`
- **THEN** `sess.title` is set to the title value
- **THEN** the session card element is re-rendered if it exists in the DOM

#### Scenario: Title for session not in DOM is skipped
- **WHEN** `sessionTitles` contains a sid whose card element does not exist in the DOM
- **THEN** no DOM mutation occurs, but `sess.title` is still updated in `sessionsMap`

#### Scenario: Subsequent SSE title update overwrites initial-load title
- **WHEN** a `session_title_update` SSE event arrives after initial load
- **THEN** the SSE handler applies the new title using the existing `titleReqTs` comparison logic
- **THEN** the live title takes precedence over the initial-load title
