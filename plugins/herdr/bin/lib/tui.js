'use strict';

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

function stripAnsi(value) {
  return String(value ?? '').replace(ANSI_RE, '');
}

function codePointWidth(codePoint) {
  if (codePoint === 0 || codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  if (
    codePoint >= 0x1100 && (
      codePoint <= 0x115f
      || codePoint === 0x2329
      || codePoint === 0x232a
      || (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f)
      || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
      || (codePoint >= 0xf900 && codePoint <= 0xfaff)
      || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
      || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
      || (codePoint >= 0xff00 && codePoint <= 0xff60)
      || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
      || (codePoint >= 0x1f300 && codePoint <= 0x1faff)
      || (codePoint >= 0x20000 && codePoint <= 0x3fffd)
    )
  ) return 2;
  return 1;
}

function displayWidth(value) {
  let width = 0;
  for (const char of stripAnsi(value)) width += codePointWidth(char.codePointAt(0));
  return width;
}

function takeWidth(value, maxWidth) {
  const max = Math.max(0, Number(maxWidth) || 0);
  let width = 0;
  let output = '';
  for (const char of String(value ?? '')) {
    const charWidth = codePointWidth(char.codePointAt(0));
    if (width + charWidth > max) break;
    output += char;
    width += charWidth;
  }
  return output;
}

function truncateText(value, maxWidth, suffix = '~') {
  const text = String(value ?? '');
  const max = Math.max(0, Number(maxWidth) || 0);
  if (displayWidth(text) <= max) return text;
  const suffixWidth = displayWidth(suffix);
  if (max <= suffixWidth) return takeWidth(suffix, max);
  return `${takeWidth(text, max - suffixWidth)}${suffix}`;
}

function wrapText(value, maxWidth, opts = {}) {
  const max = Math.max(1, Number(maxWidth) || 1);
  const initialIndent = String(opts.initialIndent || '');
  const subsequentIndent = String(opts.subsequentIndent ?? initialIndent);
  const words = String(value ?? '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [initialIndent];

  const lines = [];
  let indent = initialIndent;
  let line = indent;
  const pushLine = () => {
    lines.push(line.trimEnd());
    indent = subsequentIndent;
    line = indent;
  };

  for (const word of words) {
    const separator = line === indent ? '' : ' ';
    if (displayWidth(`${line}${separator}${word}`) <= max) {
      line += `${separator}${word}`;
      continue;
    }
    if (line !== indent) pushLine();

    let remainder = word;
    while (displayWidth(`${line}${remainder}`) > max) {
      const available = Math.max(1, max - displayWidth(line));
      // INVARIANT: every iteration must consume at least one glyph. takeWidth
      // returns '' when the next glyph is wider than the space available — a
      // width-2 CJK character or an emoji against a one-column budget — and
      // that left both `line` and `remainder` untouched, so the loop pushed
      // empty lines forever (`wrapText('中', 1)` threw RangeError, and
      // `wrapText('a 中 b', 1)` hung the process outright). A glyph that cannot
      // fit is emitted anyway: overflowing by one column is strictly better
      // than never terminating.
      const chunk = takeWidth(remainder, available) || [...remainder][0] || '';
      if (!chunk) break;
      line += chunk;
      remainder = remainder.slice(chunk.length);
      pushLine();
    }
    line += remainder;
  }
  if (line !== indent || !lines.length) lines.push(line.trimEnd());
  return lines;
}

function listViewport(total, selectedIndex, height, previousStart = 0) {
  const count = Math.max(0, Number(total) || 0);
  const size = Math.max(1, Math.min(Number(height) || 1, count || 1));
  if (!count) return { start: 0, end: 0 };
  const selected = Math.min(Math.max(Number(selectedIndex) || 0, 0), count - 1);
  const maxStart = Math.max(0, count - size);
  let start = Math.min(Math.max(Number(previousStart) || 0, 0), maxStart);
  if (selected < start) start = selected;
  if (selected >= start + size) start = selected - size + 1;
  start = Math.min(Math.max(start, 0), maxStart);
  return { start, end: Math.min(count, start + size) };
}

function budgetedListViewport(total, selectedIndex, lineBudget, previousStart = 0) {
  const count = Math.max(0, Number(total) || 0);
  const budget = Math.max(1, Number(lineBudget) || 1);
  const showOverflow = count > budget && budget >= 2;
  const viewport = listViewport(count, selectedIndex, budget - (showOverflow ? 1 : 0), previousStart);
  const hiddenBefore = viewport.start;
  const hiddenAfter = Math.max(0, count - viewport.end);
  const overflow = showOverflow
    ? [hiddenBefore ? `↑ ${hiddenBefore}` : null, hiddenAfter ? `↓ ${hiddenAfter}` : null].filter(Boolean).join(' · ') + ' more'
    : null;
  return {
    ...viewport,
    overflow,
    overflowBefore: Boolean(overflow && hiddenBefore),
  };
}

function writeFrame(lines, opts = {}) {
  if (opts.clear) process.stdout.write('\x1b[2J\x1b[H');
  process.stdout.write(lines.join('\n'));
  if (!opts.interactive) process.stdout.write('\n');
}

function restoreFrameCursor(stream = process.stdout) {
  stream.write('\n\x1b[?25h');
}

module.exports = {
  budgetedListViewport,
  displayWidth,
  listViewport,
  restoreFrameCursor,
  stripAnsi,
  takeWidth,
  truncateText,
  writeFrame,
  wrapText,
};
