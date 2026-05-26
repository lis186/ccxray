## 1. Server — entries API response shape

- [x] 1.1 In `server/routes/api.js`, build `sessionTitles` map from `store.sessionMeta`: collect all `[sid, meta.title]` pairs where `meta.title` is non-null
- [x] 1.2 Change `/_api/entries` handler response from bare array to `{ entries: [...], sessionTitles }` JSON object

## 2. Client — parse new response shape

- [x] 2.1 In `public/entry-rendering.js`, update the `fetch('/_api/entries')` callback to destructure `{ entries, sessionTitles }` from the parsed JSON (handle missing `sessionTitles` gracefully for backwards compat)
- [x] 2.2 After the entries loop (sessionsMap fully populated), iterate `sessionTitles` entries: for each sid set `sess.title` on the matching `sessionsMap` entry
- [x] 2.3 For each sid with a title, call `document.getElementById('sess-' + sid.slice(0, 8))` and if non-null re-render via `sessEl.innerHTML = renderSessionItem(sess, sid)`

## 3. Tests

- [x] 3.1 Update any existing test that asserts `/_api/entries` returns a bare array — expect the new `{ entries, sessionTitles }` envelope instead
- [x] 3.2 Add test: when `store.sessionMeta` has titled sessions, `/_api/entries` includes them in `sessionTitles`
- [x] 3.3 Add test: when no sessions are titled, `sessionTitles` is `{}`
