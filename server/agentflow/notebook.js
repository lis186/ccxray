'use strict';

// agentflow notebook parsing (docs/agentflow-integration.md, "agentflow concepts"
// and Ask windows W1). The patterns mirror upstream agentflow 8.4.14
// (notebook-write.js, round-linter.js, local-time.js) rather than approximating.

const fs = require('fs');

const ASK = /^# → Ask \/ (A-\d+)(?: \([^)\r\n]*\))?[ \t]*\r?$/u;
const REPLY = /^(?:# ← Reply \/ (A-\d+)(?: \([^)\r\n]*\))?[ \t]*|## Reply \/ (A-\d+)\b[^\r\n]*)\r?$/u;
const STAMP = /^\* _(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2}) \(([^)\r\n]*)\)_/u;
const FENCE = /^\s*(?:`{3,}|~{3,})/u;
// Where agf inserts owner input: before the first record of the Ask (agf.js).
const RECORD = /^(?:---[ \t]*\r?$|## \[(?:RUN|WIP)-\d+\])/u;

// agentflow's local-time format carries its own offset; parse it without the
// machine's timezone (upstream parse_numeric_timestamp).
function parseStamp(line) {
  const m = STAMP.exec(line);
  if (!m) return null;
  const [y, mo, d, h, mi, s, sign, oh, om] = m.slice(1, 10).map((v, i) => i === 6 ? v : Number(v));
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59 || oh > 23 || om > 59) return null;
  const offset = (sign === '-' ? -1 : 1) * (oh * 60 + om) * 60000;
  return { at: Date.UTC(y, mo - 1, d, h, mi, s) - offset, identity: m[10] };
}

// W1/W2 normalisation, shared by bullets and owner submissions.
function normalize(text) {
  return text.replace(/<\/?pasted_content\b[^>]*>/gu, ' ').replace(/\s+/gu, ' ').trim();
}

// Paragraphs exactly as agentflow's format_owner_input splits them; a leading
// `+ ` is dropped there too. Empty paragraphs are kept so indices stay stable.
function paragraphs(text) {
  return text.replace(/\r\n?/gu, '\n').trim().split(/\n(?:[\t ]*\n)+/u)
    .map(p => normalize(p.replace(/^\+ /u, '')));
}

function parseNotebook(text) {
  const asks = [];
  let ask = null, part = null, para = null, fenced = false;
  const endPara = () => {
    if (para && ask && part === 'body') {
      const t = normalize(para.join('\n'));
      if (t) ask.bullets.push(t);
    }
    para = null;
  };
  for (const line of text.split('\n')) {
    if (FENCE.test(line)) { endPara(); fenced = !fenced; continue; }
    if (fenced) continue;
    const a = ASK.exec(line);
    if (a) {
      endPara();
      ask = { id: a[1], bullets: [], hasReply: false, stamp: null, identity: null, stampUnreadable: false };
      asks.push(ask);
      part = 'body';
      continue;
    }
    if (!ask) continue;
    if (REPLY.test(line)) {
      endPara();
      ask.hasReply = true;
      part = 'reply-head';
      continue;
    }
    if (part === 'reply-head') {
      if (!line.trim()) continue;
      const st = parseStamp(line);
      if (st) { ask.stamp = st.at; ask.identity = st.identity; }
      else ask.stampUnreadable = true;
      part = 'reply';
      continue;
    }
    if (part !== 'body') continue;
    if (RECORD.test(line)) { endPara(); part = 'records'; continue; }
    if (!line.trim()) { endPara(); continue; }
    if (para) para.push(line);
    else if (/^\+(?: |$)/u.test(line)) para = [line.replace(/^\+ ?/u, '')];
  }
  endPara();
  return asks;
}

// The live notebook and its compaction archive, archive rounds first; a round
// present in both is taken from the live notebook.
function loadNotebook(notebookPath, archivePath = null) {
  const live = parseNotebook(fs.readFileSync(notebookPath, 'utf8'));
  const archived = archivePath ? parseNotebook(fs.readFileSync(archivePath, 'utf8')) : [];
  const liveIds = new Set(live.map(a => a.id));
  return [...archived.filter(a => !liveIds.has(a.id)), ...live];
}

module.exports = { parseStamp, normalize, paragraphs, parseNotebook, loadNotebook };
