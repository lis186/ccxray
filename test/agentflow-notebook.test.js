'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseStamp, paragraphs, parseNotebook, loadNotebook } = require('../server/agentflow/notebook');

describe('parseStamp', () => {
  it('uses the stamp\'s own offset, not the machine timezone', () => {
    assert.equal(parseStamp('* _2026-06-01 18:00:05 +0800 (claude/unknown)_').at, Date.UTC(2026, 5, 1, 10, 0, 5));
    assert.equal(parseStamp('* _2026-06-01 05:30:00 -0430 (gpt/high)_').at, Date.UTC(2026, 5, 1, 10, 0, 0));
    assert.equal(parseStamp('* _2026-06-01 18:00:05 +0800 (claude/unknown)_').identity, 'claude/unknown');
    assert.equal(parseStamp('2026-06-01 18:00 claude'), null);
  });
});

describe('paragraphs', () => {
  it('splits like format_owner_input and normalises pasted-content tags and whitespace', () => {
    assert.deepEqual(paragraphs('one\n\n+ two\n  wrapped\n \n<pasted_content>\n\n<pasted_content id="1">three</pasted_content>'),
      ['one', 'two wrapped', '', 'three']);
  });
});

describe('parseNotebook', () => {
  const text = [
    '# STATUS', '', '+ not in an Ask', '',
    '# → Ask / A-001 (Some Author)', '', '+ first prompt', '', '+ second', '  continued', '', 'hand note, not a bullet', '',
    '## [RUN-001] Event — 2026-06-01 10:00:00 +0000 (A-001)', '', '+ inside a record',
    '', '# ← Reply / A-001', '', '* _2026-06-01 10:05:00 +0000 (claude/unknown)_', '', '+ inside the reply',
    '', '# → Ask / A-002', '', '```', '# ← Reply / A-002', '```', '+ fenced? no, after the fence', '',
    '## Reply / A-002', '', '2026-06-01 10:20 handwritten stamp',
    '', '# → Ask / A-003', '', '+', '',
  ].join('\n');
  const asks = parseNotebook(text);

  it('reads Asks with an author suffix, bullets before the first record, and stamps', () => {
    assert.deepEqual(asks.map(a => a.id), ['A-001', 'A-002', 'A-003']);
    assert.deepEqual(asks[0].bullets, ['first prompt', 'second continued']);
    assert.equal(asks[0].stamp, Date.UTC(2026, 5, 1, 10, 5, 0));
  });

  it('ignores headings inside fences and accepts the legacy `## Reply /` heading', () => {
    assert.deepEqual(asks[1].bullets, ['fenced? no, after the fence']);
    assert.equal(asks[1].hasReply, true);
    assert.equal(asks[1].stampUnreadable, true);
    assert.equal(asks[1].stamp, null);
  });

  it('W1 skips a bullet holding only a pasted-content tag (F8)', () => {
    const [a] = parseNotebook(['# → Ask / A-001', '', '+ <pasted_content id="1"></pasted_content>', '', '+ one', ''].join('\n'));
    assert.deepEqual(a.bullets, ['one']);
  });

  it('treats the bare `+` scaffold as an empty, open Ask', () => {
    assert.deepEqual(asks[2], { id: 'A-003', bullets: [], hasReply: false, stamp: null, identity: null, stampUnreadable: false, replyText: null });
  });

  it('keeps each Reply\'s raw text, from its heading to the next Ask', () => {
    assert.equal(asks[0].replyText, '# ← Reply / A-001\n\n* _2026-06-01 10:05:00 +0000 (claude/unknown)_\n\n+ inside the reply\n');
  });
});

describe('loadNotebook', () => {
  it('reads the archive first and takes a round present in both from the live notebook', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-agentflow-nb-'));
    process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
    fs.writeFileSync(path.join(dir, 'devlog.archive.md'), '# → Ask / A-001\n\n+ old\n\n# → Ask / A-002\n\n+ archived copy\n');
    fs.writeFileSync(path.join(dir, 'devlog.md'), '# → Ask / A-002\n\n+ live copy\n\n# → Ask / A-003\n\n+\n');
    const asks = loadNotebook(path.join(dir, 'devlog.md'), path.join(dir, 'devlog.archive.md'));
    assert.deepEqual(asks.map(a => [a.id, a.bullets[0]]), [['A-001', 'old'], ['A-002', 'live copy'], ['A-003', undefined]]);
  });
});
