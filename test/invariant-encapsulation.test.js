'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Structural invariant: no raw store.entries.push or store.entryIndex.set
// outside store.js. All mutations go through store.registerEntry().
// See docs/decisions/0003-entry-index-map.md

function collectJsFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules') {
      results.push(...collectJsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      results.push(full);
    }
  }
  return results;
}

function scanFor(files, pattern, label) {
  const violations = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (pattern.test(lines[i]) && !/^\s*\/\//.test(lines[i])) {
        violations.push(`${path.relative(serverDir, f)}:${i + 1}: ${lines[i].trim()}`);
      }
    }
  }
  return violations;
}

const serverDir = path.join(__dirname, '..', 'server');
const files = collectJsFiles(serverDir).filter(f => path.basename(f) !== 'store.js');

describe('ADR 0003 encapsulation', () => {
  it('no raw store.entries.push outside store.js', () => {
    const v = scanFor(files, /store\.entries\.push\b/, 'store.entries.push');
    assert.strictEqual(v.length, 0,
      `Found ${v.length} raw store.entries.push:\n${v.join('\n')}`);
  });

  it('no raw store.entryIndex.set outside store.js', () => {
    const v = scanFor(files, /store\.entryIndex\.set\b/, 'store.entryIndex.set');
    assert.strictEqual(v.length, 0,
      `Found ${v.length} raw store.entryIndex.set:\n${v.join('\n')}`);
  });

  it('no destructured entries import that could bypass registerEntry', () => {
    const v = scanFor(files, /(?:const|let|var)\s*\{[^}]*\bentries\b[^}]*\}\s*=\s*require\s*\(\s*['"]\..*store/, 'destructured entries');
    assert.strictEqual(v.length, 0,
      `Found ${v.length} destructured entries import:\n${v.join('\n')}`);
  });
});
