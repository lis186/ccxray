'use strict';

// #168: CLAUDE.md's module tables and docs/env-vars.md drifted from the tree
// twice. These checks are the mechanical guard against a third time.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// First backticked path of each table row between two headings.
function tablePaths(markdown, startHeading, endHeading) {
  const start = markdown.indexOf(startHeading);
  const end = markdown.indexOf(endHeading, start + 1);
  assert.ok(start >= 0 && end > start, `CLAUDE.md must contain "${startHeading}" followed by "${endHeading}"`);
  return markdown.slice(start, end).split('\n')
    .map(line => /^\| `([^`]+)`/.exec(line))
    .filter(Boolean)
    .map(m => m[1]);
}

function listFiles(dir, filter) {
  return fs.readdirSync(path.join(ROOT, dir))
    .filter(filter)
    .map(name => `${dir}/${name}`);
}

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

describe('CLAUDE.md module tables match the tree', () => {
  const claude = read('CLAUDE.md');
  const server = tablePaths(claude, '### Server (`server/`)', '### Client (`public/`)');
  const client = tablePaths(claude, '### Client (`public/`)', '### Hub Mode');

  it('every listed path exists', () => {
    const missing = [...server, ...client].filter(p => !fs.existsSync(path.join(ROOT, p)));
    assert.deepEqual(missing, [], 'CLAUDE.md lists paths that do not exist');
  });

  it('every server/*.js and server/routes/*.js has a row', () => {
    const files = [
      ...listFiles('server', n => n.endsWith('.js')),
      ...listFiles('server/routes', n => n.endsWith('.js')),
    ];
    const rows = new Set(server);
    assert.deepEqual(files.filter(f => !rows.has(f)), [], 'add a row to the Server table');
  });

  it('server subdirectories are described as directories', () => {
    const dirs = fs.readdirSync(path.join(ROOT, 'server'), { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name !== 'routes')
      .map(d => `server/${d.name}/`);
    const rows = new Set(server);
    assert.deepEqual(dirs.filter(d => !rows.has(d)), [], 'add a directory row to the Server table');
  });

  it('every public/*.js, index.html and style.css has a row', () => {
    const files = [
      ...listFiles('public', n => n.endsWith('.js')),
      'public/index.html',
      'public/style.css',
    ];
    const rows = new Set(client);
    assert.deepEqual(files.filter(f => !rows.has(f)), [], 'add a row to the Client table');
  });
});

describe('docs/env-vars.md covers every variable name under server/', () => {
  it('lists every CCXRAY_/ANTHROPIC_/OPENAI_/CHATGPT_ name, plus PORT and AUTH_TOKEN', () => {
    const doc = read('docs/env-vars.md');
    const names = new Set(['PORT', 'AUTH_TOKEN']);
    for (const file of walk(path.join(ROOT, 'server'))) {
      const text = fs.readFileSync(file, 'utf8');
      for (const m of text.matchAll(/\b(?:CCXRAY|ANTHROPIC|OPENAI|CHATGPT)_[A-Z_]+/g)) names.add(m[0]);
    }
    const missing = [...names].filter(name => !new RegExp(`\`${name}\``).test(doc)).sort();
    assert.deepEqual(missing, [], 'document these in docs/env-vars.md');
  });
});
