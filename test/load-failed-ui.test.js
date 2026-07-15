const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('load-failed UI indicator (#244)', () => {
  // Mirrors the condition pattern used in miller-columns.js renderSectionsCol and renderDetailCol
  function renderIndicator(entry) {
    if (entry.reqLoaded) return 'content';
    return entry._loadFailed ? 'turn data could not be loaded' : '⏳ Loading…';
  }

  it('shows loading spinner when fetch is pending', () => {
    assert.equal(renderIndicator({ reqLoaded: false }), '⏳ Loading…');
  });

  it('shows error text when fetch failed', () => {
    assert.equal(renderIndicator({ reqLoaded: false, _loadFailed: true }), 'turn data could not be loaded');
  });

  it('shows content when loaded successfully', () => {
    assert.equal(renderIndicator({ reqLoaded: true }), 'content');
  });

  it('reqLoaded takes precedence over _loadFailed', () => {
    // Edge case: if a retry succeeds after a failure, reqLoaded wins
    assert.equal(renderIndicator({ reqLoaded: true, _loadFailed: true }), 'content');
  });
});
