'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { extractTitleGenPayload, parseSSEEvents } = require('../server/helpers');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'title-gen');

function makeDeltaEvents(chunks) {
  return chunks.map(text => ({
    type: 'content_block_delta',
    delta: { type: 'text_delta', text },
  }));
}

describe('extractTitleGenPayload', () => {
  it('returns null for falsy or empty input', () => {
    assert.equal(extractTitleGenPayload(null), null);
    assert.equal(extractTitleGenPayload(undefined), null);
    assert.equal(extractTitleGenPayload([]), null);
    assert.equal(extractTitleGenPayload(''), null);
  });

  it('parses well-formed JSON across multiple text_delta chunks', () => {
    const events = makeDeltaEvents(['{"title": "Fix', ' login button on mobile"}']);
    assert.equal(
      extractTitleGenPayload(events),
      'Fix login button on mobile',
    );
  });

  it('parses well-formed JSON in a string body', () => {
    assert.equal(
      extractTitleGenPayload('{"title": "Add OAuth flow"}'),
      'Add OAuth flow',
    );
  });

  it('handles CJK and emoji titles without corruption', () => {
    const t = '修復登入按鈕 🔐';
    const events = makeDeltaEvents([JSON.stringify({ title: t })]);
    assert.equal(extractTitleGenPayload(events), t);
  });

  it('falls back to regex for truncated JSON', () => {
    const events = makeDeltaEvents(['{"title": "Add OA']);
    assert.equal(extractTitleGenPayload(events), 'Add OA');
  });

  it('handles escaped quotes in regex fallback', () => {
    const events = makeDeltaEvents(['{"title": "Fix the \\"login\\" bug"']);
    assert.equal(extractTitleGenPayload(events), 'Fix the "login" bug');
  });

  it('returns null when title field is missing', () => {
    assert.equal(extractTitleGenPayload('{"foo": "bar"}'), null);
  });

  it('returns null when title is non-string', () => {
    assert.equal(extractTitleGenPayload('{"title": 123}'), null);
    assert.equal(extractTitleGenPayload('{"title": null}'), null);
    assert.equal(extractTitleGenPayload('{"title": ["a", "b"]}'), null);
  });

  it('returns null when title is empty or whitespace', () => {
    assert.equal(extractTitleGenPayload('{"title": ""}'), null);
    assert.equal(extractTitleGenPayload('{"title": "   "}'), null);
  });

  it('returns null when response has no text deltas', () => {
    const events = [
      { type: 'message_start', message: {} },
      { type: 'message_stop' },
    ];
    assert.equal(extractTitleGenPayload(events), null);
  });

  it('accepts response object with content blocks', () => {
    const res = { content: [{ type: 'text', text: '{"title": "Refactor API client"}' }] };
    assert.equal(extractTitleGenPayload(res), 'Refactor API client');
  });

  it('caps titles at 200 characters', () => {
    const long = 'x'.repeat(500);
    const out = extractTitleGenPayload(`{"title": "${long}"}`);
    assert.equal(out.length, 200);
    assert.equal(out, 'x'.repeat(200));
  });

  it('respects CCXRAY_DISABLE_TITLES kill switch', () => {
    const prev = process.env.CCXRAY_DISABLE_TITLES;
    process.env.CCXRAY_DISABLE_TITLES = '1';
    try {
      assert.equal(
        extractTitleGenPayload('{"title": "Should be ignored"}'),
        null,
      );
    } finally {
      if (prev === undefined) delete process.env.CCXRAY_DISABLE_TITLES;
      else process.env.CCXRAY_DISABLE_TITLES = prev;
    }
  });

  it('extracts correctly from real captured title-gen response fixture', () => {
    const raw = fs.readFileSync(path.join(FIXTURE_DIR, 'good_res.json'), 'utf8');
    let events;
    try { events = JSON.parse(raw); } catch { events = parseSSEEvents(raw); }
    const title = extractTitleGenPayload(events);
    assert.ok(typeof title === 'string' && title.length > 0, 'should extract non-empty title');
    assert.ok(!title.startsWith('{'), 'should strip JSON envelope');
    assert.ok(!title.includes('"title"'), 'should not contain raw JSON key');
  });

  it('extracts Grok session_title from Responses function_call SSE events', () => {
    const events = [
      {
        type: 'response.function_call_arguments.delta',
        data: {
          type: 'response.function_call_arguments.delta',
          delta: '{"session_title":"User Query Requiring Exact Ok Reply"}',
        },
      },
      {
        type: 'response.function_call_arguments.done',
        data: {
          type: 'response.function_call_arguments.done',
          arguments: '{"session_title":"User Query Requiring Exact Ok Reply"}',
        },
      },
      {
        type: 'response.completed',
        data: {
          type: 'response.completed',
          response: {
            model: 'grok-build',
            status: 'completed',
            output: [
              {
                type: 'function_call',
                name: 'session_title',
                arguments: '{"session_title":"User Query Requiring Exact Ok Reply"}',
                status: 'completed',
              },
            ],
          },
        },
      },
    ];
    assert.equal(extractTitleGenPayload(events), 'User Query Requiring Exact Ok Reply');
  });

  it('extracts Grok session_title from completed response object', () => {
    const res = {
      model: 'grok-build',
      status: 'completed',
      output: [
        {
          type: 'function_call',
          name: 'session_title',
          arguments: '{"session_title":"Fix login button"}',
        },
      ],
    };
    assert.equal(extractTitleGenPayload(res), 'Fix login button');
  });
});
