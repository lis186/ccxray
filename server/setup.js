'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const readline = require('readline');
const childProcess = require('child_process');

const paths = require('./paths');
const providers = require('./providers');
const winLaunch = require('./win-launch');
const credentials = require('./export-credentials');
const exportSync = require('./export-sync');
const status = require('./status');
const exportDiagnostics = require('./export-diagnostics');
const { runBounded } = require('./bounded-run');

const START_MARKER = '# >>> ccxray setup >>>';
const END_MARKER = '# <<< ccxray setup <<<';
const WRAPPER_MARKER = 'ccxray-wrapper-v1';
const SETUP_TIMEOUT_MS = 10_000;
const SETUP_LOCK_TIMEOUT_MS = 10_000;
const CHECK_IDS = new Set([
  'node-version', 'claude-resolvable', 'shell-target', 'rc-block', 'conflict-scan',
  'execution-policy',
  'env-anthropic-base-url', 'claude-account', 'account-count', 'adc',
  'invoking-shell', 'running-exporter', 'enrollment', 'cursor', 'last-attempt',
  'last-lock-loss', 'last-fail-open', 'coverage', 'shell-probe',
]);

function usageLine() {
  return 'Usage: ccxray setup [--remove | --check | --browser on|off] [--dry-run] [--yes] [--shell zsh|bash|pwsh|powershell] [--no-probe] [--bucket B] [--domains D] [--prefix P] [--cwd-allowlist L] [--retention-days N]';
}

function parseArgs(argv) {
  const options = {
    remove: false, check: false, browser: null, dryRun: false, yes: false,
    shell: null, noProbe: false,
    flags: Object.create(null),
  };
  const valued = new Set([
    '--shell', '--browser', '--bucket', '--domains', '--prefix',
    '--cwd-allowlist', '--retention-days',
  ]);
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--remove') options.remove = true;
    else if (arg === '--check') options.check = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--yes') options.yes = true;
    else if (arg === '--no-probe') options.noProbe = true;
    else if (valued.has(arg)) {
      if (seen.has(arg) || argv[i + 1] === undefined || argv[i + 1].startsWith('--')) {
        return { error: usageLine() };
      }
      seen.add(arg);
      const value = argv[++i];
      if (arg === '--shell') options.shell = value;
      else if (arg === '--browser') options.browser = value;
      else options.flags[arg] = value;
    } else return { error: usageLine() };
  }

  const writeFlags = options.remove || Boolean(options.browser)
    || Object.keys(options.flags).length > 0 || options.dryRun;
  if (options.check && writeFlags) return { error: usageLine() };
  if (options.remove && options.browser) return { error: usageLine() };
  if (options.dryRun && options.browser) return { error: usageLine() };
  if (options.noProbe && !options.check) return { error: usageLine() };
  if (options.browser && options.browser !== 'on' && options.browser !== 'off') return { error: usageLine() };
  if (options.shell && !['zsh', 'bash', 'pwsh', 'powershell'].includes(options.shell)) return { error: usageLine() };
  return { options };
}

function shellKind(shell) {
  return shell === 'pwsh' || shell === 'powershell' ? 'powershell' : 'posix';
}

function normalizeDomains(value) {
  const parts = String(value ?? '').split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
  return [...new Set(parts)].sort();
}

function validateValues(values) {
  const failures = [];
  if (values.bucket !== undefined && !/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(values.bucket)) {
    failures.push('--bucket must match the GCS bucket sanity format');
  }
  if (values.domains !== undefined) {
    if (!values.domains.length || values.domains.some(domain => !/^[a-z0-9.-]+$/.test(domain))) {
      failures.push('--domains must be a comma-separated list of domains');
    }
  }
  if (values.prefix !== undefined && !/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(values.prefix)) {
    failures.push('--prefix contains an invalid path segment');
  }
  if (values.cwdAllowlist !== undefined
      && values.cwdAllowlist !== ''
      && values.cwdAllowlist.split(',').some(name => !/^[A-Za-z0-9._-]+$/.test(name.trim()))) {
    failures.push('--cwd-allowlist entries may contain only letters, digits, dot, underscore, and hyphen');
  }
  if (values.retentionDays !== undefined
      && (!Number.isInteger(values.retentionDays) || values.retentionDays < 1 || values.retentionDays > 3650)) {
    failures.push('--retention-days must be an integer from 1 through 3650');
  }
  for (const [name, value] of Object.entries(values)) {
    if (typeof value === 'string' && /[\r\n\0]/.test(value)) failures.push(`${name} contains a line break or NUL`);
  }
  return failures;
}

function decodeRc(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    const text = new TextDecoder('utf-16le', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(2));
    if (text.includes('\0')) throw new TypeError('NUL bytes are not valid shell startup-file text');
    return { text, encoding: 'utf16le', bom: Buffer.from([0xff, 0xfe]) };
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(3));
    if (text.includes('\0')) throw new TypeError('NUL bytes are not valid shell startup-file text');
    return { text, encoding: 'utf8', bom: Buffer.from([0xef, 0xbb, 0xbf]) };
  }
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  if (text.includes('\0')) throw new TypeError('NUL bytes are not valid shell startup-file text');
  return { text, encoding: 'utf8', bom: Buffer.alloc(0) };
}

function encodeRc(text, decoded) {
  const body = decoded.encoding === 'utf16le'
    ? Buffer.from(text, 'utf16le')
    : Buffer.from(text, 'utf8');
  return Buffer.concat([decoded.bom, body]);
}

function dominantNewline(text, fallback = '\n') {
  const crlf = (text.match(/\r\n/g) || []).length;
  const bareLf = (text.match(/(?<!\r)\n/g) || []).length;
  const bareCr = (text.match(/\r(?!\n)/g) || []).length;
  if (!crlf && !bareLf && !bareCr) return fallback;
  if (crlf >= bareLf && crlf >= bareCr) return '\r\n';
  if (bareCr > bareLf) return '\r';
  return '\n';
}

function lineRanges(text) {
  const rows = [];
  let start = 0;
  while (start < text.length) {
    const lf = text.indexOf('\n', start);
    const cr = text.indexOf('\r', start);
    const separator = lf < 0 ? cr : cr < 0 ? lf : Math.min(lf, cr);
    const contentEnd = separator < 0 ? text.length : separator;
    const end = separator < 0
      ? text.length
      : separator + (text[separator] === '\r' && text[separator + 1] === '\n' ? 2 : 1);
    rows.push({ start, end, contentEnd, text: text.slice(start, contentEnd) });
    start = end;
  }
  if (!text.length) return rows;
  if (text.endsWith('\n') || text.endsWith('\r')) {
    rows.push({ start: text.length, end: text.length, contentEnd: text.length, text: '' });
  }
  return rows;
}

function isCommentLine(line, powershell) {
  return powershell ? /^\s*#/.test(line) : /^\s*#/.test(line);
}

function functionBlocks(text, powershell) {
  const rows = lineRanges(text);
  const found = [];
  const startPattern = powershell
    ? /^\s*function\s+((?:global|script):)?(claude[A-Za-z0-9_-]*)\b/i
    : /^\s*(?:function\s+)?(claude[A-Za-z0-9_-]*)\s*(?:\(\s*\)|\{)/;
  for (let i = 0; i < rows.length; i++) {
    const match = rows[i].text.match(startPattern);
    if (!match) continue;
    const name = powershell ? match[2] : match[1];
    const open = rows[i].text.indexOf('{');
    let depth = 0;
    let end = i;
    let complete = false;
    for (; end < rows.length; end++) {
      const line = rows[end].text;
      const scanFrom = end === i ? open : 0;
      if (scanFrom < 0) break;
      const delta = braceDelta(line.slice(scanFrom), powershell);
      depth += delta;
      if (depth < 0) break;
      if (depth === 0) {
        complete = end > i && line.trim() === '}';
        break;
      }
    }
    if (!complete) end = Math.min(end, rows.length - 1);
    const body = rows.slice(i, end + 1).map(row => row.text).join('\n');
    found.push({
      name, start: rows[i].start, end: rows[end].contentEnd, body, line: i + 1,
      complete, header: rows[i].text,
    });
  }
  return found;
}

function braceDelta(line, powershell) {
  let delta = 0;
  let quote = null;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quote) {
      if (powershell && quote === '"' && char === '`') { index++; continue; }
      if (!powershell && quote === '"' && char === '\\') { index++; continue; }
      if (char === quote) {
        if (powershell && quote === "'" && line[index + 1] === "'") { index++; continue; }
        quote = null;
      }
      continue;
    }
    if (char === '#' || (!powershell && char === '#')) break;
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === '{') delta++;
    else if (char === '}') delta--;
  }
  return delta;
}

function braceRegionIsBalanced(text, powershell) {
  let depth = 0;
  for (const row of lineRanges(text)) {
    depth += braceDelta(row.text, powershell);
    if (depth < 0) return false;
  }
  return depth === 0;
}

function hasGeneratedWrapperShape(fn, powershell) {
  if (!fn.complete) return false;
  const expectedHeader = powershell ? /^\s*function\s+claude\s*\{\s*$/i : /^\s*claude\s*\(\s*\)\s*\{\s*$/i;
  if (!expectedHeader.test(fn.header)) return false;
  // Here-documents and PowerShell here-strings have their own brace rules. Refuse
  // those shapes instead of guessing where the owned function ends.
  if (powershell ? /@['"]/.test(fn.body) : /<<-?\s*['"]?[A-Za-z_]/.test(fn.body)) return false;
  const body = fn.body.split('\n').slice(1, -1).map(line => line.trim());
  return body.length > 0 && body[0] === (powershell ? `# ${WRAPPER_MARKER}` : `: ${WRAPPER_MARKER}`);
}

function parseRcBlock(text, powershell) {
  const rows = lineRanges(text);
  const starts = rows.filter(row => row.text.trim() === START_MARKER);
  const ends = rows.filter(row => row.text.trim() === END_MARKER);
  if (!starts.length && !ends.length) return { kind: 'absent', text, values: null };
  if (starts.length !== 1 || ends.length !== 1) {
    return { kind: 'malformed', reason: 'duplicate or unmatched setup markers', text };
  }
  const start = starts[0];
  const end = ends[0];
  if (start.start >= end.start) return { kind: 'malformed', reason: 'reversed setup markers', text };
  const inner = text.slice(start.end, end.start);
  if (inner.includes(START_MARKER) || inner.includes(END_MARKER)) {
    return { kind: 'malformed', reason: 'nested setup markers', text };
  }
  if (!braceRegionIsBalanced(inner, powershell)) {
    return { kind: 'malformed', reason: 'setup block has unbalanced braces', text };
  }
  const innerFunctions = functionBlocks(inner, powershell).filter(fn => fn.name.toLowerCase() === 'claude');
  if (innerFunctions.length !== 1 || !hasGeneratedWrapperShape(innerFunctions[0], powershell)) {
    return { kind: 'malformed', reason: 'setup block does not own its claude wrapper', text };
  }
  const blockText = text.slice(start.start, end.end);
  const values = Object.create(null);
  const valuePattern = powershell
    ? /^\s*\$env:([A-Z0-9_]+)\s*=\s*'((?:''|[^'])*)'\s*$/i
    : /^\s*export\s+([A-Z0-9_]+)='((?:'\\''|[^'])*)'\s*$/;
  for (const row of lineRanges(blockText)) {
    const match = row.text.match(valuePattern);
    if (!match) continue;
    let value = match[2];
    if (powershell) value = value.replace(/''/g, "'");
    else value = value.replace(/'\\''/g, "'");
    values[match[1]] = value;
  }
  const resolved = {
    bucket: values.CCXRAY_EXPORT_GCS_BUCKET,
    domains: values.CCXRAY_EXPORT_DOMAINS === undefined ? undefined : normalizeDomains(values.CCXRAY_EXPORT_DOMAINS),
    prefix: values.CCXRAY_EXPORT_GCS_PREFIX,
    retentionDays: values.LOG_RETENTION_DAYS === undefined ? undefined : Number(values.LOG_RETENTION_DAYS),
    cwdAllowlist: values.CCXRAY_EXPORT_CWD_ALLOWLIST,
  };
  return {
    kind: 'owned',
    text,
    blockText,
    start: start.start,
    end: end.end,
    newline: dominantNewline(text),
    values: resolved,
  };
}

function quotePosix(value) { return `'${String(value).replace(/'/g, "'\\''")}'`; }
function quotePowerShell(value) { return `'${String(value).replace(/'/g, "''")}'`; }

function renderRcBlock(values, powershell, newline = '\n') {
  const q = powershell ? quotePowerShell : quotePosix;
  const lines = [START_MARKER];
  const settings = [
    ['CCXRAY_EXPORT_GCS_BUCKET', values.bucket],
    ['CCXRAY_EXPORT_GCS_PREFIX', values.prefix],
    ['CCXRAY_EXPORT_DOMAINS', values.domains.join(',')],
    ['LOG_RETENTION_DAYS', String(values.retentionDays)],
  ];
  if (values.cwdAllowlist !== undefined && values.cwdAllowlist !== '') {
    settings.push(['CCXRAY_EXPORT_CWD_ALLOWLIST', values.cwdAllowlist]);
  }
  settings.push(['CCXRAY_IMPORT_DISABLE', '1']);
  for (const [name, value] of settings) {
    lines.push(powershell ? `$env:${name} = ${q(value)}` : `export ${name}=${q(value)}`);
  }
  if (powershell) {
    lines.push(
      'function claude {',
      `  # ${WRAPPER_MARKER}`,
      '  $claudeApp = (Get-Command claude -CommandType Application | Select-Object -First 1).Source',
      "  $bypass = @('--version','--help','-h','mcp','doctor','agents','plugin','auth','attach','respawn')",
      '  if ($args.Count -gt 0 -and $bypass -contains $args[0]) { & $claudeApp @args; return }',
      '  if (Get-Command ccxray -ErrorAction SilentlyContinue) { ccxray claude @args } else { & $claudeApp @args }',
      '}',
    );
  } else {
    lines.push(
      'claude() {',
      `  : ${WRAPPER_MARKER}`,
      '  case "$1" in --version|--help|-h|mcp|doctor|agents|plugin|auth|attach|respawn)',
      '    command claude "$@"; return ;; esac',
      '  if command -v ccxray >/dev/null 2>&1; then ccxray claude "$@"; else command claude "$@"; fi',
      '}',
    );
  }
  lines.push(END_MARKER);
  return lines.join(newline) + newline;
}

function spliceRc(text, parsed, block, newline, newFile = false) {
  if (parsed.kind === 'owned') return text.slice(0, parsed.start) + block + text.slice(parsed.end);
  if (parsed.kind !== 'absent') throw new Error(parsed.reason || 'malformed setup block');
  if (!text) return block;
  const separator = /(?:\r\n|\n|\r)$/.test(text) ? '' : newline;
  return text + separator + block;
}

function scanConflicts(text, powershell, file, ownedBlock = null) {
  const rows = lineRanges(text);
  const conflicts = [];
  const notScanned = [];
  const ownedWrapperHeaders = new Set();
  if (ownedBlock) {
    const blockText = text.slice(ownedBlock.start, ownedBlock.end);
    for (const fn of functionBlocks(blockText, powershell)) {
      if (fn.name.toLowerCase() === 'claude' && fn.body.includes(WRAPPER_MARKER)) {
        ownedWrapperHeaders.add(ownedBlock.start + fn.start);
      }
    }
  }
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (ownedWrapperHeaders.has(row.start)) continue;
    const line = row.text;
    if (!line.trim() || isCommentLine(line, powershell)) continue;
    let match;
    if (powershell) {
      if ((match = line.match(/^\s*function\s+((?:global|script):)?(claude[A-Za-z0-9_-]*)\b/i))) {
        conflicts.push({ line: index + 1, kind: 'function', name: match[2] });
      } else if ((match = line.match(/^\s*(?:Set|New)-Alias\s+(?:-Name\s+)?(claude\S*)\b/i))) {
        conflicts.push({ line: index + 1, kind: 'alias', name: match[1] });
      } else if (/^\s*\$env:ANTHROPIC_BASE_URL\s*=/.test(line)) {
        conflicts.push({ line: index + 1, kind: 'environment', name: 'ANTHROPIC_BASE_URL' });
      }
      if ((match = line.match(/^\s*\.\s+(\S+)/))) notScanned.push(match[1]);
    } else {
      if ((match = line.match(/^\s*(?:function\s+)?(claude[A-Za-z0-9_-]*)\s*\(\s*\)/))
          || (match = line.match(/^\s*function\s+(claude[A-Za-z0-9_-]*)\b/))) {
        conflicts.push({ line: index + 1, kind: 'function', name: match[1] });
      } else if ((match = line.match(/^\s*alias\s+(claude[^=\s]*)=/))) {
        conflicts.push({ line: index + 1, kind: 'alias', name: match[1] });
      } else if (/^\s*export\s+ANTHROPIC_BASE_URL=/.test(line)
          || /^\s*ANTHROPIC_BASE_URL=.*;\s*export\b/.test(line)) {
        conflicts.push({ line: index + 1, kind: 'environment', name: 'ANTHROPIC_BASE_URL' });
      }
      if ((match = line.match(/^\s*(?:source|\.)\s+(\S+)/))) notScanned.push(match[1]);
    }
  }
  return {
    conflicts: conflicts.map(item => `${file}:${item.line}: ${item.kind} ${item.name}`),
    notScanned: [...new Set(notScanned)],
    detail: conflicts.length
      ? conflicts.map(item => `${file}:${item.line}: ${item.kind} ${item.name}`).join('; ')
      : 'not detected',
  };
}

function snapshotComparable(snapshot) {
  return JSON.stringify({
    chain: snapshot.chain.map(item => ({
      path: item.path, kind: item.kind, target: item.target ?? null,
      dev: item.dev ?? null, ino: item.ino ?? null, size: item.size ?? null,
      mtimeMs: item.mtimeMs ?? null, nlink: item.nlink ?? null,
    })),
    parentMissing: snapshot.parentMissing === true,
  });
}

function resolveChain(logicalPath, io = fs, { allowCreateParent = false, pathApi = path } = {}) {
  const rawLogical = String(logicalPath);
  const logical = pathApi.resolve(rawLogical);
  const rawAbsolute = pathApi.isAbsolute(rawLogical)
    ? rawLogical
    : `${process.cwd()}${pathApi.sep}${rawLogical}`;
  const splitPath = absolute => {
    const parsed = pathApi.parse(absolute);
    const parts = absolute.slice(parsed.root.length).split(pathApi.sep).filter(Boolean);
    return { root: parsed.root, parts };
  };
  const initial = splitPath(rawAbsolute);
  let pending = initial.parts.map(value => ({ value, fromLinkTarget: false }));
  let current = initial.root;
  const chain = [];
  const visited = new Set();
  let linkCount = 0;
  for (let index = 0; index < pending.length; index++) {
    const component = pending[index];
    if (component.value === '.' || component.value === '') continue;
    if (component.value === '..') {
      if (component.fromLinkTarget && !current) throw new Error(`invalid symlink target for ${logical}`);
      current = pathApi.dirname(current);
      continue;
    }
    const absolute = pathApi.resolve(pathApi.join(current, component.value));
    let stat;
    try { stat = io.lstatSync(absolute); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (component.fromLinkTarget) {
        throw new Error(`${logical} → ${absolute} does not exist; fix the link first`);
      }
      if (index === pending.length - 1) {
        chain.push({ path: absolute, kind: 'absent' });
        return { logicalPath: logical, realPath: absolute, chain, kind: 'absent', fingerprint: null, parentMissing: false };
      }
      const missing = pending.slice(index);
      if (!allowCreateParent) throw new Error(`parent directory for ${logical} does not exist`);
      if (missing.some(item => item.fromLinkTarget)) {
        throw new Error(`${logical} → ${absolute} does not exist; fix the link first`);
      }
      if (missing.some(item => item.value === '..')) {
        throw new Error(`parent directory for ${logical} cannot be created through a missing path component`);
      }
      for (const directory of missing.slice(0, -1)) {
        current = pathApi.resolve(pathApi.join(current, directory.value));
        chain.push({ path: current, kind: 'absent-directory' });
      }
      const filePath = pathApi.resolve(pathApi.join(current, missing[missing.length - 1].value));
      chain.push({ path: filePath, kind: 'absent' });
      return { logicalPath: logical, realPath: filePath, chain, kind: 'absent', fingerprint: null, parentMissing: true };
    }
    if (stat.isSymbolicLink()) {
      const state = `${absolute}\0${pending.slice(index).map(item => `${item.fromLinkTarget ? 'L' : 'P'}:${item.value}`).join('/')}`;
      if (visited.has(state)) throw new Error(`symlink loop at ${absolute}`);
      visited.add(state);
      if (++linkCount > 40) throw new Error(`symlink chain exceeds 40 hops at ${absolute}`);
      const target = io.readlinkSync(absolute);
      chain.push({ path: absolute, kind: 'symlink', target, dev: stat.dev, ino: stat.ino });
      const targetPath = pathApi.isAbsolute(target)
        ? target
        : `${pathApi.dirname(absolute)}${pathApi.sep}${target}`;
      const resolvedTarget = splitPath(targetPath);
      pending = resolvedTarget.parts.map(value => ({ value, fromLinkTarget: true }))
        .concat(pending.slice(index + 1));
      current = resolvedTarget.root;
      index = -1;
      continue;
    }
    const isFinal = index === pending.length - 1;
    if (isFinal) {
      if (!stat.isFile()) throw new Error(`${absolute} is not a regular file`);
      const fingerprint = { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, nlink: stat.nlink };
      chain.push({ path: absolute, kind: 'file', mode: stat.mode, ...fingerprint });
      if (typeof io.realpathSync?.native !== 'function') {
        throw new Error('filesystem does not expose realpathSync.native for target verification');
      }
      const nativePath = io.realpathSync.native(rawLogical);
      const canonicalResolvedPath = io.realpathSync.native(absolute);
      const comparable = value => {
        let normalized = pathApi.normalize(value);
        if (pathApi === path.win32 || pathApi.sep === '\\') {
          normalized = normalized.replace(/^\\\\\?\\/, '').toLowerCase();
        }
        return normalized;
      };
      if (comparable(nativePath) !== comparable(canonicalResolvedPath)) {
        throw new Error(`path resolver disagrees with realpathSync.native for ${logical}: ${absolute} versus ${nativePath}`);
      }
      return { logicalPath: logical, realPath: absolute, chain, kind: 'file', fingerprint, parentMissing: false };
    }
    if (!stat.isDirectory()) throw new Error(`${absolute} is not a directory`);
    chain.push({ path: absolute, kind: 'directory', dev: stat.dev, ino: stat.ino });
    current = absolute;
  }
  throw new Error(`cannot resolve target file ${logical}`);
}

function chainIsStale(prepared, current) {
  return snapshotComparable(prepared) !== snapshotComparable(current);
}

function parseShellValueFlag(options, flag, transform = value => value) {
  return Object.prototype.hasOwnProperty.call(options.flags, flag)
    ? transform(options.flags[flag])
    : undefined;
}

function parseDomainFlag(value) { return normalizeDomains(value); }

function resolveValues(options, targets) {
  const explicit = {
    bucket: parseShellValueFlag(options, '--bucket'),
    domains: parseShellValueFlag(options, '--domains', parseDomainFlag),
    prefix: parseShellValueFlag(options, '--prefix'),
    retentionDays: parseShellValueFlag(options, '--retention-days', Number),
    cwdAllowlist: parseShellValueFlag(options, '--cwd-allowlist'),
  };
  const names = {
    bucket: 'CCXRAY_EXPORT_GCS_BUCKET',
    domains: 'CCXRAY_EXPORT_DOMAINS',
    prefix: 'CCXRAY_EXPORT_GCS_PREFIX',
    retentionDays: 'LOG_RETENTION_DAYS',
    cwdAllowlist: 'CCXRAY_EXPORT_CWD_ALLOWLIST',
  };
  const agreed = Object.create(null);
  const conflicts = [];
  for (const field of Object.keys(explicit)) {
    const values = [];
    for (const target of targets) {
      if (target.parsed?.kind !== 'owned') continue;
      const value = target.parsed.values[field];
      values.push({ file: target.snapshot.realPath, value });
    }
    const unique = new Map(values.map(item => [JSON.stringify(item.value), item]));
    if (unique.size > 1 && explicit[field] === undefined) {
      conflicts.push(`${field}: ${[...unique.values()].map(item => `${item.file}=${JSON.stringify(item.value)}`).join(', ')}`);
    }
    agreed[field] = unique.size === 1 ? [...unique.values()][0].value : undefined;
  }
  const resolved = {
    bucket: explicit.bucket ?? agreed.bucket,
    domains: explicit.domains ?? agreed.domains,
    prefix: explicit.prefix ?? agreed.prefix ?? 'summaries',
    retentionDays: explicit.retentionDays ?? agreed.retentionDays ?? 30,
    cwdAllowlist: explicit.cwdAllowlist !== undefined ? explicit.cwdAllowlist : agreed.cwdAllowlist,
  };
  if (resolved.domains !== undefined) resolved.domains = normalizeDomains(resolved.domains);
  return { explicit, agreed, resolved, conflicts };
}

function findExecutable(bin, env, deps = {}) {
  const io = deps.fs || fs;
  const platform = deps.platform || process.platform;
  const pathApi = platform === 'win32' ? path.win32 : (deps.path || path);
  const separator = platform === 'win32' ? ';' : pathApi.delimiter;
  const extensions = platform === 'win32'
    ? String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  const dirs = String(env.PATH || '').split(separator).filter(Boolean);
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = pathApi.join(dir, platform === 'win32' && !pathApi.extname(bin) ? `${bin}${extension}` : bin);
      try {
        const stat = io.statSync(candidate);
        if (!stat.isFile()) continue;
        if (platform !== 'win32') io.accessSync(candidate, io.constants.X_OK);
        return candidate;
      } catch {}
    }
  }
  return null;
}

function nonce(deps) {
  if (typeof deps.nonce === 'function') return deps.nonce();
  if (typeof deps.nonce === 'string') return deps.nonce;
  return crypto.randomBytes(8).toString('hex');
}

function parseFrame(stdout, frameNonce) {
  const lines = String(stdout).split(/\r?\n/);
  const endMarker = `<</ccxray-probe:${frameNonce}>>`;
  const beginMarker = `<<ccxray-probe:${frameNonce}>>`;
  for (let end = lines.length - 1; end >= 0; end--) {
    if (lines[end].trim() !== endMarker) continue;
    for (let start = end - 1; start >= 0; start--) {
      if (lines[start].trim() !== beginMarker) continue;
      const values = Object.create(null);
      for (const line of lines.slice(start + 1, end)) {
        const split = line.indexOf('=');
        if (split > 0) values[line.slice(0, split).trim()] = line.slice(split + 1).trim();
      }
      return values;
    }
  }
  return null;
}

function powershellEncoded(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function powershellDiscoveryScript(frameNonce) {
  return [
    `Write-Output '<<ccxray-probe:${frameNonce}>>'`,
    `Write-Output "allHosts=$($PROFILE.CurrentUserAllHosts)"`,
    `Write-Output "currentHost=$($PROFILE.CurrentUserCurrentHost)"`,
    `Write-Output "edition=$($PSVersionTable.PSEdition)"`,
    `Write-Output "host=$($Host.Name)"`,
    '$executionPolicy = Get-ExecutionPolicy',
    '$profileSignature = try { if (Test-Path -LiteralPath $PROFILE.CurrentUserAllHosts -PathType Leaf) { (Get-AuthenticodeSignature -LiteralPath $PROFILE.CurrentUserAllHosts).Status.ToString() } else { "Missing" } } catch { "Unknown" }',
    'Write-Output "executionPolicy=$executionPolicy"',
    'Write-Output "profileSignature=$profileSignature"',
    `Write-Output '<</ccxray-probe:${frameNonce}>>'`,
  ].join('\n');
}

function powershellProbeScript(frameNonce) {
  return [
    `Write-Output '<<ccxray-probe:${frameNonce}>>'`,
    '$c = Get-Command claude -ErrorAction SilentlyContinue',
    "$k = if ($null -eq $c) { 'none' } else { switch ($c.CommandType.ToString()) { 'Function' { 'function' } 'Filter' { 'function' } 'Alias' { 'alias' } 'Application' { 'command' } 'ExternalScript' { 'command' } 'Cmdlet' { 'builtin' } default { \"other($($c.CommandType))\" } } }",
    'Write-Output "kind=$k"',
    `if ($k -eq 'function') { if ($c.Definition -match '${WRAPPER_MARKER}') { 'owned=1' } else { 'owned=0' } }`,
    'Write-Output "edition=$($PSVersionTable.PSEdition)"',
    'Write-Output "host=$($Host.Name)"',
    `Write-Output '<</ccxray-probe:${frameNonce}>>'`,
  ].join('\n');
}

async function runSetupProcess(file, args, env, cwd, deps, overrides = {}) {
  const runner = deps.runBounded || ((opts) => runBounded(opts, {
    spawn: deps.spawn || childProcess.spawn,
    terminate: deps.terminate,
    platform: deps.platform || process.platform,
  }));
  return runner({ file, args, env, cwd, ...overrides });
}

async function discoverPowerShell(exe, env, deps, frameNonce = nonce(deps)) {
  const result = await runSetupProcess(exe, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    powershellEncoded(powershellDiscoveryScript(frameNonce)),
  ], env, env.HOME || undefined, deps, { deadlineMs: SETUP_TIMEOUT_MS });
  const frame = result.status === 'exited' && result.exitCode === 0
    ? parseFrame(result.stdout, frameNonce)
    : null;
  if (!frame || !frame.allHosts) {
    return { kind: 'unknown', reason: result.status === 'exited' ? 'no-frame' : result.status, result };
  }
  return {
    kind: 'ok',
    result,
    allHosts: frame.allHosts,
    currentHost: frame.currentHost || null,
    edition: frame.edition || 'unknown',
    host: frame.host || 'unknown',
    executionPolicy: frame.executionPolicy || null,
    profileSignature: frame.profileSignature || null,
  };
}

function normalizedTargetKey(file, platform) {
  const resolved = path.resolve(file);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function resolveTargets(options, deps) {
  const env = deps.env;
  const platform = deps.platform;
  const fsApi = deps.fs;
  const pathApi = platform === 'win32' ? path.win32 : deps.path;
  const out = { targets: [], issues: [], notices: [] };
  const addPosix = shell => {
    const base = shell === 'zsh' ? (env.ZDOTDIR || env.HOME) : env.HOME;
    if (!base) throw new Error(`cannot resolve ${shell} target without ${shell === 'zsh' ? 'HOME/ZDOTDIR' : 'HOME'}`);
    const rawBase = String(base);
    const filename = shell === 'zsh' ? '.zshrc' : '.bashrc';
    const hasTrailingSeparator = platform === 'win32'
      ? /[\\/]$/.test(rawBase)
      : rawBase.endsWith(pathApi.sep);
    const logicalPath = rawBase + (hasTrailingSeparator ? '' : pathApi.sep) + filename;
    out.targets.push({ shell, kind: 'posix', logicalPath, label: shell });
  };
  const addPowerShell = async (edition, exe) => {
    if (!exe) {
      out.issues.push({ shell: edition, status: 'failed', detail: `${edition} was not found on PATH` });
      return;
    }
    const discovery = await discoverPowerShell(exe, env, deps);
    if (discovery.kind !== 'ok') {
      out.targets.push({ shell: edition, kind: 'powershell', exe, unknown: discovery.reason, label: edition });
      return;
    }
    out.targets.push({
      shell: edition,
      kind: 'powershell',
      exe,
      logicalPath: discovery.allHosts,
      currentHostPath: discovery.currentHost,
      label: `${edition}/${discovery.edition}, ${discovery.host}`,
      executionPolicy: discovery.executionPolicy,
      profileSignature: discovery.profileSignature,
    });
    const target = out.targets[out.targets.length - 1];
    if (target.currentHostPath) {
      const currentHost = pathApi.resolve(target.currentHostPath);
      const allHosts = pathApi.resolve(target.logicalPath);
      const sameFile = platform === 'win32'
        ? currentHost.toLowerCase() === allHosts.toLowerCase()
        : currentHost === allHosts;
      if (!sameFile) {
        try {
          fsApi.statSync(target.currentHostPath);
          out.notices.push('present, not scanned: ' + target.currentHostPath);
        } catch (error) {
          if (error.code !== 'ENOENT') out.notices.push('unreadable, not scanned: ' + target.currentHostPath);
        }
      }
    }
  };

  try {
    if (platform === 'win32') {
      if (options.shell && ['zsh', 'bash'].includes(options.shell)) {
        throw new Error('zsh and bash are unsupported on Windows; Git Bash is out of scope');
      }
      const requested = options.shell;
      const pathPwsh = findExecutable('pwsh', env, { fs: fsApi, platform });
      const pathPowerShell = findExecutable('powershell', env, { fs: fsApi, platform });
      const systemWindowsPowerShell = env.SystemRoot
        ? pathApi.join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
        : null;
      const systemFound = systemWindowsPowerShell && (() => {
        try { return fsApi.statSync(systemWindowsPowerShell).isFile() ? systemWindowsPowerShell : null; }
        catch { return null; }
      })();
      if (requested === 'pwsh') await addPowerShell('pwsh', pathPwsh);
      else if (requested === 'powershell') await addPowerShell('powershell', pathPowerShell || systemFound);
      else {
        if (pathPwsh) await addPowerShell('pwsh', pathPwsh);
        if (pathPowerShell || systemFound) await addPowerShell('powershell', pathPowerShell || systemFound);
        if (!out.targets.length) out.issues.push({ shell: 'PowerShell', status: 'failed', detail: 'no supported PowerShell edition found' });
      }
      return out;
    }

    if (options.shell === 'powershell') throw new Error('powershell is supported only on Windows; use pwsh explicitly on POSIX');
    if (options.shell === 'pwsh') {
      const exe = findExecutable('pwsh', env, { fs: fsApi, platform });
      await addPowerShell('pwsh', exe);
      return out;
    }
    if (options.shell) addPosix(options.shell);
    else {
      const shell = pathApi.basename(env.SHELL || '');
      if (shell !== 'zsh' && shell !== 'bash') throw new Error('pass --shell zsh or --shell bash');
      addPosix(shell);
    }
    if (platform === 'darwin' && out.targets.some(target => target.shell === 'bash')) {
      const profile = pathApi.join(env.HOME || '', '.bash_profile');
      try {
        const profileText = fsApi.readFileSync(profile, 'utf8');
        if (!/(^|[;&|\s])(?:source|\.)\s+(?:"?\$HOME|~)\/\.bashrc/.test(profileText)) {
          out.notices.push(`present, not scanned: ${profile} does not source ~/.bashrc`);
        } else out.notices.push(`present, not scanned: ${profile}`);
      } catch (error) {
        if (error.code !== 'ENOENT') out.notices.push(`unreadable, not scanned: ${profile}`);
      }
    }
    if (out.targets.some(target => target.shell === 'zsh')) {
      for (const name of ['.zshenv', '.zprofile']) {
        const candidate = pathApi.join(env.ZDOTDIR || env.HOME || '', name);
        try { fsApi.statSync(candidate); out.notices.push(`present, not scanned: ${candidate}`); }
        catch (error) { if (error.code !== 'ENOENT') out.notices.push(`unreadable, not scanned: ${candidate}`); }
      }
    }
    return out;
  } catch (error) {
    out.issues.push({ shell: options.shell || 'shell', status: 'failed', detail: error.message });
    return out;
  }
}

function prepareTarget(target, deps) {
  if (target.unknown) return target;
  const snapshot = resolveChain(target.logicalPath, deps.fs, {
    allowCreateParent: target.kind === 'powershell',
    pathApi: target.kind === 'powershell' && deps.platform === 'win32' ? path.win32 : deps.path,
  });
  if (snapshot.fingerprint?.nlink > 1) {
    throw new Error(`${target.logicalPath} is hard-linked (nlink=${snapshot.fingerprint.nlink}); ccxray setup refuses to replace it. Copy it to a regular file first.`);
  }
  let raw = Buffer.alloc(0);
  if (snapshot.kind === 'file') raw = deps.fs.readFileSync(snapshot.realPath);
  const decoded = decodeRc(raw);
  const parsed = parseRcBlock(decoded.text, target.kind === 'powershell');
  return { ...target, snapshot, raw, decoded, parsed };
}

function dedupeTargets(targets, platform) {
  const byPath = new Map();
  const result = [];
  for (const target of targets) {
    if (!target.snapshot) { result.push(target); continue; }
    const key = normalizedTargetKey(target.snapshot.realPath, platform);
    const existing = byPath.get(key);
    if (existing) {
      existing.labels.push(target.label);
      existing.shells.push(target.shell);
      existing.logicalTargets.push({ ...target });
      continue;
    }
    target.labels = [target.label];
    target.shells = [target.shell];
    target.logicalTargets = [{ ...target }];
    byPath.set(key, target);
    result.push(target);
  }
  return result;
}

function targetProbeDescriptors(target) {
  const descriptors = target.logicalTargets || [target];
  return descriptors.map(descriptor => ({
    ...target,
    ...descriptor,
    parsed: target.parsed,
    decoded: target.decoded,
    snapshot: target.snapshot,
    canonicalTarget: target,
  }));
}

function targetDescription(target) {
  if (target.unknown) return `${target.label}: unknown(${target.unknown})`;
  if (target.error) return `${target.label}: unresolved (${target.error.message})`;
  if (!target.snapshot) return `${target.label}: unresolved`;
  const chain = target.snapshot.chain.map(item => item.kind === 'symlink'
    ? `${item.path} -> ${item.target}`
    : `${item.path} (${item.kind})`).join(' -> ');
  return `${(target.labels || [target.label]).join(' + ')}: ${target.logicalPath} => ${chain}`;
}

function statusLine(id, state, detail) {
  if (!CHECK_IDS.has(id)) throw new Error(`unknown setup check id: ${id}`);
  return { id, status: state, detail: String(detail) };
}

function printChecks(checks, io = console) {
  for (const check of checks) {
    io.log(`${check.id}: ${check.status} — ${check.detail}`);
  }
  const counts = { ok: 0, warning: 0, failed: 0, unknown: 0, skipped: 0 };
  for (const check of checks) counts[check.status]++;
  io.log(`checks: ${counts.ok} ok, ${counts.warning} warning, ${counts.failed} failed, ${counts.unknown} unknown, ${counts.skipped} skipped`);
}

function emailDomain(email) {
  if (typeof email !== 'string') return null;
  const at = email.lastIndexOf('@');
  return at < 0 ? null : email.slice(at + 1).toLowerCase();
}

function localDayStart(nowMs) {
  const date = new Date(nowMs);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function readExpectedTranscripts(claudeHome, start, end, io) {
  const expected = new Set();
  const projectsPath = path.join(claudeHome, 'projects');
  let projects;
  try { projects = io.readdirSync(projectsPath); }
  catch (error) {
    if (error.code === 'ENOENT') return { expected, error: null };
    return { expected, error };
  }
  for (const project of projects) {
    const projectPath = path.join(projectsPath, project);
    let entries;
    try { entries = io.readdirSync(projectPath); }
    catch (error) {
      if (error.code === 'ENOENT') continue;
      return { expected, error };
    }
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      const file = path.join(projectPath, entry);
      let stat;
      try { stat = io.statSync(file); }
      catch (error) {
        if (error.code === 'ENOENT') continue;
        return { expected, error };
      }
      if (stat.mtimeMs >= start && stat.mtimeMs <= end) expected.add(entry.slice(0, -6));
    }
  }
  return { expected, error: null };
}

async function scanIndexPopulation(logsDir, domains, window, io) {
  const indexPath = path.join(logsDir, 'index.ndjson');
  const accounts = new Set();
  const captured = new Set();
  let skippedRows = 0;
  let stream;
  try { stream = io.createReadStream(indexPath); }
  catch (error) {
    return { kind: error.code === 'ENOENT' ? 'missing' : 'unreadable', error, accounts, captured, skippedRows };
  }
  try {
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const text of rl) {
      if (!text) continue;
      let row;
      try { row = JSON.parse(text); } catch { continue; }
      if (!row || typeof row !== 'object') continue;
      const domain = emailDomain(row.accountEmail);
      if (domain && domains.includes(domain)) accounts.add(row.accountEmail.toLowerCase());
      if (typeof row.receivedAt !== 'number' || !Number.isFinite(row.receivedAt)) {
        skippedRows++;
        continue;
      }
      if (row.receivedAt < window.start || row.receivedAt > window.end) continue;
      if (row.sessionInferred === true || row.imported === true) continue;
      if (row.provider !== undefined && row.provider !== 'anthropic') continue;
      if (!domain || !domains.includes(domain)) continue;
      if (typeof row.sessionId === 'string' && row.sessionId.length) captured.add(row.sessionId);
    }
    return { kind: 'ok', accounts, captured, skippedRows };
  } catch (error) {
    return { kind: error.code === 'ENOENT' ? 'missing' : 'unreadable', error, accounts, captured, skippedRows };
  }
}

async function inspectPopulation(population, domains, claudeHome, nowMs, io) {
  if (!domains.length) return { population, kind: 'no-domains' };
  const start = localDayStart(nowMs);
  const data = await scanIndexPopulation(population.logsDir, domains, { start, end: nowMs }, io);
  const expected = readExpectedTranscripts(claudeHome, start, nowMs, io);
  const match = [...expected.expected].filter(sessionId => data.captured.has(sessionId)).length;
  const unmatched = [...data.captured].filter(sessionId => !expected.expected.has(sessionId)).length;
  return {
    population,
    kind: data.kind === 'unreadable' || expected.error ? 'unreadable' : 'ok',
    indexKind: data.kind === 'unreadable' ? 'unreadable' : 'ok',
    expectedError: expected.error || null,
    error: data.error || null,
    accountCount: data.accounts.size,
    expectedCount: expected.expected.size,
    capturedCount: match,
    unmatchedCount: unmatched,
    skippedRows: data.skippedRows,
    percent: expected.expected.size ? Math.round((match / expected.expected.size) * 100) : null,
  };
}

function coverageDetail(result) {
  if (result.kind === 'no-domains') return 'unknown(no-domains)';
  if (result.kind === 'unreadable') return `unknown(unreadable: ${result.expectedError?.code || result.error?.code || 'read error'})`;
  if (result.expectedCount === 0) return `unknown(expected=0) skippedRows=${result.skippedRows}`;
  return `captured=${result.capturedCount} expected=${result.expectedCount} (${result.percent}%) unmatched=${result.unmatchedCount} skippedRows=${result.skippedRows} — heuristic: expected counts transcripts modified today (mtime), including sessions with no requests; captured counts live allowed-domain turns`;
}

function populationsFor(report, env, storagePathsFn, pathApi) {
  const selected = storagePathsFn(report, env);
  const hubLogs = pathApi.resolve(selected.logsDir);
  const shellLogs = pathApi.resolve(paths.resolveLogsDir(env));
  if (selected.named && hubLogs !== shellLogs) {
    return [
      { label: 'hub', logsDir: hubLogs, provenance: 'named by hub' },
      { label: 'shell', logsDir: shellLogs, provenance: 'from this shell' },
    ];
  }
  return [{ label: selected.named ? 'hub' : 'shell', logsDir: hubLogs, provenance: selected.named ? 'named by hub' : 'from this shell' }];
}

function enrollmentText(enrollment) {
  if (enrollment === null) return 'absent';
  if (enrollment?.state === 'invalid') return `invalid (${enrollment.reason}: ${enrollment.detail})`;
  if (enrollment?.state === 'removed') return `removed${enrollment.removedAt ? ` at ${enrollment.removedAt}` : ''}`;
  return enrollment?.state || String(enrollment);
}

function attemptState(attempt) {
  if (attempt === 'none') return 'none';
  if (!attempt || typeof attempt !== 'object' || attempt.error) return 'unreadable';
  return attempt.outcome || 'unknown';
}

function checkReport(checks) {
  return checks.some(check => check.status === 'failed') ? 1 : 0;
}

async function shellProbe(target, deps, blockStatus) {
  const frameNonce = nonce(deps);
  let file;
  let args;
  if (target.kind === 'powershell') {
    file = target.exe;
    args = ['-NoLogo', '-NonInteractive', '-EncodedCommand', powershellEncoded(powershellProbeScript(frameNonce))];
  } else {
    file = findExecutable(target.shell, deps.env, { fs: deps.fs, platform: deps.platform, path: deps.path });
    if (!file) return { status: 'unknown', detail: 'unknown(spawn-error: shell executable not found)' };
    const script = [
      'printf \'<<ccxray-probe:%s>>\\n\' "$1"',
      'if [ -n "$ZSH_VERSION" ]; then raw=$(whence -w claude 2>/dev/null); raw=${raw#*: }; else raw=$(type -t claude 2>/dev/null); [ -z "$raw" ] && raw=none; fi',
      'case "$raw" in alias|function|builtin) k=$raw ;; file|command|hashed) k=command ;; keyword|reserved) k=keyword ;; none) k=none ;; *) k="other($raw)" ;; esac',
      'printf \'kind=%s\\n\' "$k"',
      'if [ "$k" = function ]; then if typeset -f claude | grep -q \'ccxray-wrapper-v1\'; then printf \'owned=1\\n\'; else printf \'owned=0\\n\'; fi; fi',
      'printf \'<</ccxray-probe:%s>>\\n\' "$1"',
    ].join('\n');
    args = ['-i', '-c', script, 'ccxray-probe', frameNonce];
  }
  const result = await runSetupProcess(file, args, { ...deps.env, HISTFILE: '/dev/null' }, deps.env.HOME || undefined, deps, {
    deadlineMs: SETUP_TIMEOUT_MS,
  });
  if (result.status !== 'exited' || result.exitCode !== 0) {
    return { status: 'unknown', detail: `unknown(${result.status === 'exited' ? `exit ${result.exitCode}` : result.status})` };
  }
  if (!result.drainComplete) return { status: 'unknown', detail: 'unknown(drain-incomplete)' };
  const frame = parseFrame(result.stdout, frameNonce);
  if (!frame) return { status: 'unknown', detail: 'unknown(no-frame)' };
  const kind = frame.kind || 'other(unknown)';
  const owned = frame.owned === '1';
  if (kind === 'function' && owned) return { status: 'ok', detail: `${target.label}: ok — function, owned` };
  if (['command', 'none'].includes(kind)) {
    if (blockStatus === 'absent') return { status: 'warning', detail: `${target.label}: ${kind}; no owned wrapper installed` };
    if (blockStatus === 'owned') return { status: 'failed', detail: `${target.label}: ${kind}; startup file did not load the owned wrapper` };
  }
  return { status: 'failed', detail: `${target.label}: ${kind}${kind === 'function' && !owned ? ', shadowed' : ''}` };
}

function makeDeps(overrides = {}) {
  return {
    fs: overrides.fs || fs,
    path: overrides.path || path,
    os: overrides.os || os,
    env: overrides.env || process.env,
    platform: overrides.platform || process.platform,
    spawn: overrides.spawn || childProcess.spawn,
    terminate: overrides.terminate,
    runBounded: overrides.runBounded,
    nonce: overrides.nonce,
    now: overrides.now || (() => Date.now()),
    sleep: overrides.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms))),
    input: overrides.input,
    output: overrides.output,
    prompt: overrides.prompt,
    isTTY: overrides.isTTY,
    logger: overrides.logger || console,
    providers: overrides.providers || providers,
    winLaunch: overrides.winLaunch || winLaunch,
    credentials: overrides.credentials || credentials,
    exportSync: overrides.exportSync || exportSync,
    exportDiagnostics: overrides.exportDiagnostics || exportDiagnostics,
    status: overrides.status || status,
    paths: overrides.paths || paths,
    hooks: overrides.hooks || {},
  };
}

async function fetchDiagnostics(deps) {
  let hubResult;
  try { hubResult = await deps.exportDiagnostics.fetchHubReport({ statusCommand: true }); }
  catch (error) {
    hubResult = { kind: 'unresponsive', report: null, reason: error.code || 'query-failed', error };
  }
  const report = hubResult?.kind === 'ok' ? hubResult.report : null;
  const pathsFromHub = deps.status.storagePaths(report, deps.env);
  const home = deps.path.resolve(pathsFromHub.home);
  const logsDir = deps.path.resolve(pathsFromHub.logsDir);
  const diagnostics = deps.exportDiagnostics.collectExportDiagnostics({
    env: deps.env,
    report,
    reportReason: hubResult?.reason || hubResult?.kind || 'unknown',
    nowMs: deps.now(),
  });
  const populations = populationsFor(report, deps.env, deps.status.storagePaths, deps.path);
  return {
    hubResult,
    report,
    diagnostics,
    home,
    logsDir,
    named: Boolean(pathsFromHub.named),
    populations,
  };
}

function fetchRemovalState(deps) {
  const homeRaw = deps.paths.resolveCcxrayHome(deps.env);
  if (!homeRaw) throw new Error('CCXRAY_HOME could not be resolved.');
  const home = deps.path.resolve(homeRaw);
  return {
    hubResult: { kind: 'skipped', reason: 'remove mode' },
    report: null,
    diagnostics: { durableHome: { enrollment: deps.exportSync.readEnrollment(home, deps.fs) } },
    home,
    logsDir: null,
    named: false,
    populations: [],
  };
}

async function prepareContext(options, deps) {
  const resolution = await resolveTargets(options, deps);
  const prepared = [];
  for (const target of resolution.targets) {
    if (target.unknown) { prepared.push(target); continue; }
    try { prepared.push(prepareTarget(target, deps)); }
    catch (error) { prepared.push({ ...target, error }); }
  }
  const targets = dedupeTargets(prepared, deps.platform);
  const valueResolution = resolveValues(options, targets);
  if (options.check && valueResolution.resolved.domains === undefined && deps.env.CCXRAY_EXPORT_DOMAINS) {
    valueResolution.resolved.domains = normalizeDomains(deps.env.CCXRAY_EXPORT_DOMAINS);
  }
  const diagnostic = options.remove ? fetchRemovalState(deps) : await fetchDiagnostics(deps);
  const claudeHome = deps.env.CLAUDE_CONFIG_DIR
    || deps.path.join(deps.env.HOME || deps.os.homedir(), '.claude');
  const populations = diagnostic.populations.map(population => ({
    ...population,
    home: diagnostic.home,
  }));
  return {
    ...diagnostic,
    resolution,
    targets,
    valueResolution,
    values: valueResolution.resolved,
    claudeHome,
    populations,
  };
}

function discoverCredential(context, deps) {
  if (context.credential) return context.credential;
  try {
    context.credential = deps.credentials.discoverCredentials({
      env: deps.env,
      platform: deps.platform,
      homedir: deps.os.homedir,
      readFile: file => deps.fs.readFileSync(file, 'utf8'),
    });
  } catch (error) {
    context.credential = { discovery: { state: 'error' }, parse: { state: 'error' }, error };
  }
  return context.credential;
}

function launchAccountEmail(deps) {
  return deps.providers.getClaudeLaunchAccountEmail(deps.env, {
    readFile: file => deps.fs.readFileSync(file, 'utf8'),
  });
}

function targetRcStatus(target) {
  if (target.unknown) return { status: 'unknown', detail: `unknown(${target.unknown})` };
  if (target.error) return { status: 'unknown', detail: target.error.message };
  if (target.parsed.kind === 'malformed') return { status: 'failed', detail: target.parsed.reason };
  if (target.parsed.kind === 'owned') return { status: 'ok', detail: `${target.label}: owned` };
  return { status: 'warning', detail: `${target.label}: absent` };
}

function conflictStatus(target) {
  if (target.unknown || target.error) return { status: 'unknown', detail: target.unknown || target.error.message, notScanned: [] };
  const scan = scanConflicts(
    target.decoded.text,
    target.kind === 'powershell',
    target.logicalPath,
    target.parsed.kind === 'owned' ? target.parsed : null,
  );
  return {
    status: scan.conflicts.length ? 'failed' : 'ok',
    detail: `${scan.detail}; notScanned=${scan.notScanned.length ? scan.notScanned.join(', ') : 'none'}`,
    notScanned: scan.notScanned,
    conflicts: scan.conflicts,
  };
}

function nodeVersionCheck() {
  const major = Number(process.versions.node.split('.')[0]);
  return statusLine('node-version', major >= 18 ? 'ok' : 'failed', `Node ${process.versions.node}; requires major >= 18`);
}

function executionPolicyCheck(target, { forInstall = false, values = null, deps = null } = {}) {
  if (target.kind !== 'powershell') return null;
  const policy = String(target.executionPolicy || '').trim();
  if (!policy || policy.toLowerCase() === 'undefined') {
    return statusLine('execution-policy', 'unknown', `${target.label}: Get-ExecutionPolicy did not return an effective policy`);
  }
  if (policy.toLowerCase() === 'restricted') {
    return statusLine('execution-policy', 'failed', `${target.label}: PowerShell ExecutionPolicy Restricted prevents profile loading (${target.logicalPath})`);
  }
  if (policy.toLowerCase() === 'allsigned') {
    const signature = String(target.profileSignature || 'Unknown');
    if (signature.toLowerCase() !== 'valid') {
      return statusLine('execution-policy', 'failed', `${target.label}: PowerShell ExecutionPolicy AllSigned prevents this profile from loading because its signature status is ${signature} (${target.logicalPath})`);
    }
    if (forInstall) {
      let rendered;
      try {
        if (!target.snapshot || !Buffer.isBuffer(target.raw)) throw new Error('profile bytes are unavailable');
        rendered = renderTargetRc(target, values, false, deps);
      } catch (error) {
        return statusLine('execution-policy', 'failed', `${target.label}: PowerShell ExecutionPolicy AllSigned cannot be preserved for this setup change (${error.message})`);
      }
      if (!rendered.equals(target.raw)) {
        return statusLine('execution-policy', 'failed', `${target.label}: PowerShell ExecutionPolicy AllSigned would prevent this modified unsigned profile from loading; setup cannot sign it (${target.logicalPath})`);
      }
    }
  }
  return statusLine('execution-policy', 'ok', `${target.label}: PowerShell ExecutionPolicy ${policy}; profile signature ${target.profileSignature || 'unknown'}`);
}

function resolveClaudeExecutable(deps) {
  if (deps.platform !== 'win32') return findExecutable('claude', deps.env, { fs: deps.fs, path: deps.path, platform: deps.platform });
  const resolver = deps.winLaunch.describeResolution || winLaunch.describeResolution;
  const provider = deps.providers.getAgentProvider?.('claude') || deps.providers.AGENT_PROVIDERS?.claude;
  const result = resolver('claude', deps.env, provider, {
    fs: deps.fs,
    path: path.win32,
    platform: 'win32',
  });
  return result.hit;
}

async function inspectPopulations(context, domains, deps) {
  const results = [];
  for (const population of context.populations) {
    results.push(await inspectPopulation(population, domains || [], context.claudeHome, deps.now(), deps.fs));
  }
  return results;
}

async function buildInstallChecks(context, options, deps) {
  const checks = [nodeVersionCheck()];
  let claudePath = null;
  try { claudePath = resolveClaudeExecutable(deps); }
  catch {}
  checks.push(statusLine('claude-resolvable', claudePath ? 'ok' : 'failed', claudePath || 'claude was not found on PATH'));

  for (const issue of context.resolution.issues) {
    checks.push(statusLine('shell-target', issue.status, `${issue.shell}: ${issue.detail}`));
  }
  for (const target of context.targets) {
    if (target.unknown) {
      checks.push(statusLine('shell-target', 'failed', `${target.label}: unknown(${target.unknown})`));
      continue;
    }
    if (target.error) checks.push(statusLine('shell-target', 'failed', `${target.label}: ${target.error.message}`));
    else checks.push(statusLine('shell-target', 'ok', targetDescription(target)));
  }

  for (const target of context.targets) {
    const rc = targetRcStatus(target);
    checks.push(statusLine('rc-block', rc.status, `${target.label}: ${rc.detail}`));
    const conflict = conflictStatus(target);
    checks.push(statusLine('conflict-scan', conflict.status, conflict.detail));
  }
  for (const target of context.targets.flatMap(targetProbeDescriptors)) {
    const policy = executionPolicyCheck(target, { forInstall: true, values: context.values, deps });
    if (policy) checks.push(policy);
  }

  const hubClient = Boolean(deps.env.CCXRAY_HUB_CLIENT_PID);
  checks.push(statusLine(
    'env-anthropic-base-url',
    hubClient ? 'skipped' : deps.env.ANTHROPIC_BASE_URL ? 'failed' : 'ok',
    hubClient ? 'skipped inside a ccxray-launched session'
      : deps.env.ANTHROPIC_BASE_URL ? 'ANTHROPIC_BASE_URL is set in this shell' : 'unset',
  ));

  const domains = context.values.domains || [];
  if (!domains.length) {
    checks.push(statusLine('claude-account', 'unknown', 'no allowed-domain set is known'));
  } else {
    const email = launchAccountEmail(deps);
    const domain = emailDomain(email);
    checks.push(statusLine(
      'claude-account',
      domain && domains.includes(domain) ? 'ok' : 'failed',
      domain && domains.includes(domain) ? `account domain ${domain} is allowed` : `account email missing or domain not allowed${domain ? ` (${domain})` : ''}`,
    ));
  }

  const populationResults = await inspectPopulations(context, domains, deps);
  if (!domains.length) {
    for (const population of context.populations) {
      checks.push(statusLine('account-count', 'skipped', `index[${population.label}]: no allowed-domain set`));
    }
  } else {
    for (const result of populationResults) {
      const count = result.accountCount;
      const state = result.indexKind === 'unreadable' ? 'failed' : count > 1 ? 'failed' : 'ok';
      checks.push(statusLine('account-count', state,
        `index[${result.population.label}]: ${result.kind === 'ok' ? `distinct allowed-domain accounts=${count}` : `unreadable (${result.error?.code || 'read error'})`}`));
    }
  }

  const record = discoverCredential(context, deps);
  if (record.discovery?.state === 'key-file') {
    checks.push(statusLine('adc', 'failed', 'unset CCXRAY_EXPORT_GCS_KEY_FILE in this shell; pilot machines use ADC'));
  } else if (record.discovery?.state === 'adc' && record.parse?.state === 'ok'
      && record.parse.type === 'authorized_user') {
    checks.push(statusLine('adc', 'ok', 'ADC authorized_user credential is readable and valid'));
  } else {
    const rendered = deps.credentials.credentialText(deps.credentials.describeCredentials(record));
    checks.push(statusLine('adc', 'failed', rendered));
  }

  const enrollment = deps.exportSync.readEnrollment(context.home, deps.fs);
  if (enrollment?.state === 'invalid') {
    checks.push(statusLine('enrollment', 'failed', `${enrollmentText(enrollment)}. Inspect it, delete it for a fresh install, or run ccxray setup --remove to replace it with a removed tombstone.`));
  } else checks.push(statusLine('enrollment', 'ok', enrollmentText(enrollment)));

  return { checks, populationResults };
}

async function buildCheckReport(context, options, deps) {
  const checks = [nodeVersionCheck()];
  if (!options.noProbe && context.targets.length) {
    deps.logger.log('The shell probe runs the selected startup files to check effective command resolution.');
  }
  let claudePath = null;
  try { claudePath = resolveClaudeExecutable(deps); } catch {}
  checks.push(statusLine('claude-resolvable', claudePath ? 'ok' : 'failed', claudePath || 'claude was not found on PATH'));

  for (const issue of context.resolution.issues) {
    checks.push(statusLine('shell-target', issue.status, `${issue.shell}: ${issue.detail}`));
  }
  for (const target of context.targets) {
    if (target.unknown) {
      checks.push(statusLine('shell-target', 'unknown', `${target.label}: unknown(${target.unknown})`));
    } else if (target.error) {
      checks.push(statusLine('shell-target', 'failed', `${target.label}: ${target.error.message}`));
    } else checks.push(statusLine('shell-target', 'ok', targetDescription(target)));
  }
  for (const target of context.targets.flatMap(targetProbeDescriptors)) {
    const policy = executionPolicyCheck(target);
    if (policy) checks.push(policy);
  }

  const rcStatuses = new Map();
  for (const target of context.targets) {
    const rc = targetRcStatus(target);
    rcStatuses.set(target, rc.status === 'warning' ? 'absent' : target.parsed?.kind);
    checks.push(statusLine('rc-block', rc.status, `${target.label}: ${rc.detail}`));
    const conflict = conflictStatus(target);
    checks.push(statusLine('conflict-scan', conflict.status, conflict.detail));
  }

  const hubClient = Boolean(deps.env.CCXRAY_HUB_CLIENT_PID);
  checks.push(statusLine(
    'env-anthropic-base-url',
    hubClient ? 'skipped' : deps.env.ANTHROPIC_BASE_URL ? 'failed' : 'ok',
    hubClient ? 'skipped inside a ccxray-launched session'
      : deps.env.ANTHROPIC_BASE_URL ? 'ANTHROPIC_BASE_URL is set in this shell' : 'unset',
  ));
  const domains = context.values.domains || [];
  if (!domains.length) checks.push(statusLine('claude-account', 'unknown', 'no allowed-domain set is known'));
  else {
    const email = launchAccountEmail(deps);
    const domain = emailDomain(email);
    checks.push(statusLine('claude-account', domain && domains.includes(domain) ? 'ok' : 'failed',
      domain && domains.includes(domain) ? `account domain ${domain} is allowed` : `account email missing or domain not allowed${domain ? ` (${domain})` : ''}`));
  }

  const populationResults = await inspectPopulations(context, domains, deps);
  for (const result of populationResults) {
    if (!domains.length) {
      checks.push(statusLine('account-count', 'skipped', `index[${result.population.label}]: no allowed-domain set`));
    } else {
      const state = result.indexKind === 'unreadable' ? 'unknown' : result.accountCount > 1 ? 'failed' : 'ok';
      checks.push(statusLine('account-count', state,
        `index[${result.population.label}]: ${result.kind === 'ok' ? `distinct allowed-domain accounts=${result.accountCount}` : `unreadable (${result.error?.code || result.kind})`}`));
    }
    const coverageStatus = result.kind === 'ok' && result.expectedCount > 0 ? 'ok' : 'unknown';
    checks.push(statusLine('coverage', coverageStatus, `coverage[${result.population.label}]: ${coverageDetail(result)}`));
  }

  const record = discoverCredential(context, deps);
  if (record.discovery?.state === 'adc' && record.parse?.state === 'ok'
      && record.parse.type === 'authorized_user') {
    checks.push(statusLine('adc', 'ok', 'ADC authorized_user credential is readable and valid'));
  } else if (record.discovery?.state === 'key-file'
      && record.parse?.state === 'ok'
      && record.parse.type === 'service_account') {
    checks.push(statusLine('adc', 'warning', `${deps.credentials.credentialText(deps.credentials.describeCredentials(record))} — not the pilot path`));
  } else {
    checks.push(statusLine('adc', 'failed', deps.credentials.credentialText(deps.credentials.describeCredentials(record))));
  }

  const shell = context.diagnostics.invokingShell;
  checks.push(statusLine('invoking-shell', 'ok', `${shell.exportState} hash=${shell.exportConfigHash} (${shell.provenance})`));
  const running = context.diagnostics.runningExporter;
  if (context.hubResult.kind !== 'ok') {
    checks.push(statusLine('running-exporter', 'unknown', `${context.hubResult.kind}: ${context.hubResult.reason || 'no reachable exporter'}`));
  } else if (context.diagnostics.configMatch === 'differs') {
    checks.push(statusLine('running-exporter', 'warning', `configuration differs; close every ccxray session and start again (${running.provenance})`));
  } else if (shell.exportState === 'enabled' && running.exportState !== 'enabled') {
    checks.push(statusLine('running-exporter', 'warning', `hub exportState=${running.exportState}; shell exportState=enabled`));
  } else if (context.diagnostics.configMatch === 'equal') {
    checks.push(statusLine('running-exporter', 'ok', `report ok; configMatch=equal; exportState=${running.exportState}`));
  } else checks.push(statusLine('running-exporter', 'unknown', 'hub did not report an export config hash'));

  const durable = context.diagnostics.durableHome;
  const enrollment = durable.enrollment;
  if (enrollment?.state === 'invalid' || (enrollment && typeof enrollment === 'object' && enrollment.error)) {
    checks.push(statusLine('enrollment', 'failed', `${enrollmentText(enrollment)}. Inspect it, delete it for a fresh install, or run ccxray setup --remove to replace it with a removed tombstone.`));
  } else if (enrollment === 'absent' || enrollment === null) {
    checks.push(statusLine('enrollment', 'warning', 'absent; first flush will enroll'));
  } else if (enrollment?.state === 'removed') {
    checks.push(statusLine('enrollment', 'warning', `${enrollmentText(enrollment)}; intentional, re-run ccxray setup to enroll`));
  } else checks.push(statusLine('enrollment', 'ok', enrollmentText(enrollment)));

  const cursor = durable.cursor;
  if (cursor?.present && !cursor.unreadable && !cursor.error) checks.push(statusLine('cursor', 'ok', `present at ${cursor.cursorPath}`));
  else if (cursor?.present && (cursor.unreadable || cursor.error)) checks.push(statusLine('cursor', 'warning', `unreadable (${cursor.error || 'read error'})`));
  else checks.push(statusLine('cursor', 'unknown', 'absent'));

  const attempt = durable.lastAttempt;
  const outcome = attemptState(attempt);
  const success = ['exported', 'nothing-new', 'no-data', 'removed'].includes(outcome);
  const historicalFailure = ['hard-failed', 'upload-failed', 'enrollment-invalid'].includes(outcome);
  if (outcome === 'none') checks.push(statusLine('last-attempt', 'unknown', 'none'));
  else if (success) checks.push(statusLine('last-attempt', 'ok', `${outcome} attemptedAt=${attempt.attemptedAt || 'unknown'}`));
  else if (historicalFailure) checks.push(statusLine('last-attempt', 'warning', `${outcome}${attempt.stage || attempt.category ? ` [${attempt.stage || 'unknown'}/${attempt.category || 'unknown'}]` : ''} attemptedAt=${attempt.attemptedAt || 'unknown'}`));
  else checks.push(statusLine('last-attempt', 'unknown', outcome));

  const lockLoss = durable.lastLockLoss;
  checks.push(statusLine('last-lock-loss', lockLoss === 'none' ? 'unknown' : 'ok', lockLoss === 'none' ? 'none' : `${lockLoss.ts || lockLoss.at || 'unknown time'} — ${lockLoss.text || lockLoss.phase || 'details unavailable'}`));
  const failOpen = durable.lastFailOpen;
  checks.push(statusLine('last-fail-open', failOpen === 'none' ? 'unknown' : 'ok', failOpen === 'none' ? 'none' : `${failOpen.ts || 'unknown time'} reason=${failOpen.reason || 'unknown'} version=${failOpen.version || 'unknown'} agent=${failOpen.agent || 'unknown'}`));

  if (options.noProbe) {
    for (const target of context.targets.flatMap(targetProbeDescriptors)) {
      checks.push(statusLine('shell-probe', 'skipped', `${target.label}: skipped with --no-probe`));
    }
  } else {
    for (const target of context.targets.flatMap(targetProbeDescriptors)) {
      if (target.unknown || target.error) {
        checks.push(statusLine('shell-probe', 'unknown', `${target.label}: unknown(no-frame)`));
        continue;
      }
      const result = await shellProbe(target, deps, rcStatuses.get(target.canonicalTarget || target));
      checks.push(statusLine('shell-probe', result.status, result.detail));
    }
  }
  return checks;
}

function isoNow(now) {
  const value = typeof now === 'function' ? now() : now;
  return new Date(value).toISOString();
}

function nextEnrollmentInstall(current, retentionDays, now) {
  if (current?.state === 'invalid') throw new Error('invalid enrollment cannot be installed');
  if (current?.state === 'enrolled') return { ...current, retentionDays };
  return exportSync.buildEnrollment(retentionDays, now);
}

function nextEnrollmentRemove(current, retentionDays, now) {
  return {
    state: 'removed',
    removedAt: isoNow(now),
    enrolledAt: current?.state === 'enrolled' || current?.state === 'removed'
      ? current.enrolledAt ?? null
      : null,
    retentionDays: Number.isInteger(current?.retentionDays) ? current.retentionDays : retentionDays,
  };
}

function readCursorSeedState(home, io, pathApi) {
  const cursorPath = pathApi.join(home, 'export-cursor.json');
  try { io.lstatSync(cursorPath); return { path: cursorPath, absent: false }; }
  catch (error) {
    if (error.code === 'ENOENT') return { path: cursorPath, absent: true };
    return { path: cursorPath, absent: false, error };
  }
}

function tempPathFor(file, deps, suffix) {
  const leaf = `${deps.path.basename(file)}.ccxray-${suffix}.${process.pid}.${nonce(deps)}`;
  return deps.path.join(deps.path.dirname(file), leaf);
}

function atomicWriteBrowser(home, setting, deps) {
  deps.fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = deps.path.join(home, 'auto-open-browser');
  let tmp = null;
  let fd = null;
  try {
    const candidate = tempPathFor(file, deps, 'browser-tmp');
    fd = deps.fs.openSync(candidate, 'wx', 0o600);
    tmp = candidate;
    deps.fs.writeFileSync(fd, `${setting}\n`);
    deps.fs.closeSync(fd);
    fd = null;
    deps.fs.renameSync(tmp, file);
    tmp = null;
  } finally {
    if (fd !== null) { try { deps.fs.closeSync(fd); } catch {} }
    if (tmp) { try { deps.fs.unlinkSync(tmp); } catch {} }
  }
  return file;
}

function targetNewline(target, deps) {
  if (target.parsed.kind === 'owned') return target.parsed.newline;
  if (target.snapshot.kind === 'file') return dominantNewline(target.decoded.text);
  return target.kind === 'powershell' ? '\r\n' : '\n';
}

function renderTargetRc(target, values, remove, deps) {
  const decoded = target.decoded;
  const newline = targetNewline(target, deps);
  if (remove) {
    if (target.parsed.kind !== 'owned') return null;
    return encodeRc(decoded.text.slice(0, target.parsed.start) + decoded.text.slice(target.parsed.end), decoded);
  }
  const block = renderRcBlock(values, target.kind === 'powershell', newline);
  const content = spliceRc(decoded.text, target.parsed, block, newline, target.snapshot.kind === 'absent');
  return encodeRc(content, decoded);
}

function verifyTargetSnapshot(target, deps) {
  const logicalTargets = target.logicalTargets || [target];
  for (const logicalTarget of logicalTargets) {
    const current = resolveChain(logicalTarget.logicalPath, deps.fs, {
      allowCreateParent: logicalTarget.kind === 'powershell',
      pathApi: logicalTarget.kind === 'powershell' && deps.platform === 'win32' ? path.win32 : deps.path,
    });
    let bytesStale = false;
    const expectedBytes = logicalTarget.raw ?? target.raw;
    if (!chainIsStale(logicalTarget.snapshot, current)
        && current.kind === 'file'
        && Buffer.isBuffer(expectedBytes)) {
      bytesStale = !deps.fs.readFileSync(current.realPath).equals(expectedBytes);
    }
    if (chainIsStale(logicalTarget.snapshot, current) || bytesStale) {
      return { current, stale: true, staleTarget: logicalTarget };
    }
  }
  return { current: target.snapshot, stale: false };
}

function commitRcTarget(target, bytes, deps) {
  let tmp = null;
  let fd = null;
  try {
    const checked = verifyTargetSnapshot(target, deps);
    if (checked.stale) return { kind: 'stale', error: new Error('stale preparation; re-run ccxray setup') };
    const targetPath = target.snapshot.realPath;
    if (target.snapshot.kind === 'absent') {
      if (target.kind === 'powershell') deps.fs.mkdirSync(deps.path.dirname(targetPath), { recursive: true });
      deps.fs.writeFileSync(targetPath, bytes, { flag: 'wx', mode: 0o600 });
      return { kind: 'committed' };
    }

    const fileNode = target.snapshot.chain[target.snapshot.chain.length - 1];
    const mode = (fileNode.mode ?? 0o600) & 0o777;
    const candidate = tempPathFor(targetPath, deps, 'rc-tmp');
    fd = deps.fs.openSync(candidate, 'wx', mode);
    tmp = candidate;
    deps.fs.writeFileSync(fd, bytes);
    deps.fs.closeSync(fd);
    fd = null;
    try { deps.fs.chmodSync(tmp, mode); } catch (error) { if (error.code !== 'ENOSYS') throw error; }
    const latest = verifyTargetSnapshot(target, deps);
    if (latest.stale) return { kind: 'stale', error: new Error('stale preparation; re-run ccxray setup') };
    deps.fs.renameSync(tmp, targetPath);
    tmp = null;
    return { kind: 'committed' };
  } catch (error) {
    if (error.code === 'EEXIST' && target.snapshot.kind === 'absent') {
      return { kind: 'stale', error: new Error('target appeared during setup; re-run ccxray setup') };
    }
    return { kind: 'failed', error };
  } finally {
    if (fd !== null) { try { deps.fs.closeSync(fd); } catch {} }
    if (tmp) {
      try { deps.fs.unlinkSync(tmp); } catch {}
    }
  }
}

function cursorSeed(home, enrollment, deps) {
  const cursorPath = deps.path.join(home, 'export-cursor.json');
  try {
    deps.fs.writeFileSync(cursorPath, `${JSON.stringify(exportSync.buildCursor(enrollment, deps.now()))}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    return { kind: 'seeded', path: cursorPath };
  } catch (error) {
    if (error.code === 'EEXIST') return { kind: 'preserved', path: cursorPath };
    return { kind: 'failed', path: cursorPath, error };
  }
}

function printDryRun(context, options, deps, nextEnrollment, cursorState, browserSetting) {
  const io = deps.logger;
  io.log('Dry run — no lock acquired and no files changed.');
  for (const target of context.targets) {
    io.log(targetDescription(target));
    for (const alias of targetAliases(target)) io.log(`Logical target: ${alias}`);
  }
  if (options.remove) {
    io.log(`Would write tombstone: ${deps.exportSync.enrollmentPath(context.home)} (${enrollmentText(context.diagnostics.durableHome.enrollment)} → removed)`);
    for (const target of context.targets) {
      if (target.parsed?.kind === 'owned') io.log(`Would remove setup block: ${target.logicalPath} → ${target.snapshot.realPath}`);
      else if (target.parsed?.kind === 'malformed') {
        io.log(`Would skip malformed setup block: ${target.logicalPath} (${target.parsed.reason}); tombstone will be written and cleanup reported incomplete.`);
      }
    }
    return;
  }
  io.log(`Would write enrollment: ${deps.exportSync.enrollmentPath(context.home)} (${enrollmentText(context.diagnostics.durableHome.enrollment)} → ${enrollmentText(nextEnrollment)})`);
  io.log(`Cursor seed: ${cursorState.absent ? `create ${cursorState.path}` : `preserve ${cursorState.path}`}`);
  for (const target of context.targets) {
    if (target.unknown || target.error || target.parsed.kind === 'malformed') continue;
    const block = renderRcBlock(context.values, target.kind === 'powershell', targetNewline(target, deps));
    io.log(`Would write setup block for ${targetAliases(target).join('; ')}:\n${block}`);
  }
  if (browserSetting) io.log(`Would write ${deps.path.join(context.home, 'auto-open-browser')}: ${browserSetting}`);
  else if (!options.yes) io.log(`First install will ask whether to write ${deps.path.join(context.home, 'auto-open-browser')}.`);
}

function targetAliases(target) {
  const logicalTargets = target.logicalTargets || [target];
  return logicalTargets.map(item => `${item.label || target.label}: ${item.logicalPath || target.logicalPath}`);
}

function isTty(deps) {
  if (typeof deps.isTTY === 'boolean') return deps.isTTY;
  return Boolean(deps.input?.isTTY ?? process.stdin.isTTY);
}

function ask(question, deps) {
  if (typeof deps.prompt === 'function') return deps.prompt(question);
  const input = deps.input || process.stdin;
  const output = deps.output || process.stdout;
  return new Promise(resolve => {
    const rl = readline.createInterface({ input, output });
    rl.question(question, answer => { rl.close(); resolve(answer); });
  });
}

async function askYesNo(question, deps) {
  const answer = String(await ask(question, deps)).trim().toLowerCase();
  return answer === 'y' || answer === 'yes';
}

async function showConsent(context, options, deps, changeLines) {
  for (const line of changeLines) deps.logger.log(`  ${line}`);
  if (options.yes) return true;
  if (!isTty(deps)) {
    deps.logger.error('Consent refused: non-TTY setup requires --yes. Nothing was written.');
    return false;
  }
  return askYesNo('Apply these ccxray setup changes? [y/N] ', deps);
}

async function acquireSetupLock(home, deps) {
  const started = deps.now();
  while (true) {
    let result;
    try { result = await deps.exportSync.acquireLock(home); }
    catch (error) { return { error: `could not start: ${error.message}` }; }
    if (result?.handle) return { handle: result.handle };
    const lost = result?.lost || { code: 'EUNKNOWN' };
    if (!deps.exportSync.isContention(lost)) {
      return { error: `could not start: ${deps.exportSync.describeLoss(home, lost)}` };
    }
    if (deps.now() - started >= SETUP_LOCK_TIMEOUT_MS) {
      return { error: `could not start: ${deps.exportSync.describeLoss(home, lost)}` };
    }
    await deps.sleep(500);
  }
}

function phaseA(context, isRemove, deps) {
  const enrollment = deps.exportSync.readEnrollment(context.home, deps.fs);
  if (!isRemove && enrollment?.state === 'invalid') {
    return { ok: false, error: `export-enrollment.json is ${enrollment.reason}: ${enrollment.detail}. Inspect it; then either delete it (a fresh install enrolls from today) or run ccxray setup --remove to replace it with a removed tombstone.` };
  }
  for (const target of context.targets) {
    if (target.unknown || target.error) return { ok: false, error: `${target.label}: target is unresolved; re-run ccxray setup` };
    try {
      if (verifyTargetSnapshot(target, deps).stale) return { ok: false, error: `${target.logicalPath} changed since preparation; re-run ccxray setup` };
    } catch (error) {
      return { ok: false, error: `${target.logicalPath}: ${error.message}; re-run ccxray setup` };
    }
  }
  return { ok: true, enrollment };
}

function changeLines(context, options, cursorState, browserSetting, nextEnrollment, deps) {
  const changes = [];
  const enrollmentPath = deps.exportSync.enrollmentPath(context.home);
  changes.push(`${enrollmentPath}: ${enrollmentText(context.diagnostics.durableHome.enrollment)} → ${enrollmentText(nextEnrollment)}`);
  if (!options.remove && cursorState) {
    changes.push(`${cursorState.path}: ${cursorState.absent ? 'will create (wx)' : 'will preserve existing cursor'}`);
  }
  for (const target of context.targets) {
    if (target.unknown || target.error) continue;
    const real = target.snapshot.realPath;
    const aliases = targetAliases(target);
    let create = '';
    if (target.snapshot.kind === 'absent') {
      create = ' (will create)';
      if (target.kind === 'powershell' && target.snapshot.parentMissing) {
        const pathApi = deps.platform === 'win32' ? path.win32 : deps.path;
        create = ` (will create directory ${pathApi.dirname(real)} and file)`;
      }
    }
    if (options.remove && target.parsed.kind === 'malformed') {
      changes.push(`skip malformed setup block after tombstone (cleanup incomplete): ${aliases.join('; ')}`);
      continue;
    }
    const action = options.remove ? 'remove owned setup block' : 'write setup block';
    if (options.remove && target.parsed.kind !== 'owned') continue;
    for (const alias of aliases) {
      const logicalPath = alias.slice(alias.indexOf(': ') + 2);
      const symlinkSuffix = logicalPath !== real ? ` → ${real}` : '';
      changes.push(`${action}: ${alias}${symlinkSuffix}${create}`);
    }
  }
  if (browserSetting) changes.push(`${deps.path.join(context.home, 'auto-open-browser')}: will write ${browserSetting}`);
  return changes;
}

function firstOwnedValues(context) {
  return context.targets.filter(target => target.parsed?.kind === 'owned');
}

async function runBrowserMode(options, deps) {
  const homeRaw = deps.paths.resolveCcxrayHome(deps.env);
  if (!homeRaw) {
    deps.logger.error('CCXRAY_HOME could not be resolved.');
    return 1;
  }
  const home = deps.path.resolve(homeRaw);
  const file = deps.path.join(home, 'auto-open-browser');
  const changes = [`${file}: will write ${options.browser}`];
  if (!await showConsent(null, options, deps, changes)) return 2;
  try {
    atomicWriteBrowser(home, options.browser, deps);
    deps.logger.log(`Browser preference set to ${options.browser}.`);
    return 0;
  } catch (error) {
    deps.logger.error(`Could not write ${file}: ${error.message}`);
    return 1;
  }
}

async function runRemove(context, options, deps) {
  if (context.resolution.issues.length) {
    for (const issue of context.resolution.issues) {
      deps.logger.error(`Cannot remove setup: ${issue.shell}: ${issue.detail}`);
    }
    return 1;
  }
  const invalidTarget = context.targets.find(target => target.unknown || target.error);
  if (invalidTarget) {
    deps.logger.error(`Cannot remove setup: ${invalidTarget.logicalPath || invalidTarget.label}: ${invalidTarget.unknown || invalidTarget.error?.message || invalidTarget.parsed?.reason}`);
    return 1;
  }
  if (options.dryRun) {
    const current = deps.exportSync.readEnrollment(context.home, deps.fs);
    const retention = parseShellValueFlag(options, '--retention-days', Number) ?? 30;
    printDryRun(context, options, deps, nextEnrollmentRemove(current, retention, deps.now()), null, null);
    return 0;
  }
  const current = deps.exportSync.readEnrollment(context.home, deps.fs);
  const retention = parseShellValueFlag(options, '--retention-days', Number) ?? 30;
  const next = nextEnrollmentRemove(current, retention, deps.now());
  const changeList = changeLines(context, options, null, null, next, deps);
  if (!await showConsent(context, options, deps, changeList)) return 2;

  await deps.hooks.beforeLock?.({ mode: 'remove', context, options });
  const acquired = await acquireSetupLock(context.home, deps);
  if (!acquired.handle) {
    deps.logger.error(acquired.error);
    return 1;
  }
  let failures = [];
  try {
    const validation = phaseA(context, true, deps);
    if (!validation.ok) {
      deps.logger.error(`${validation.error}; no files were written.`);
      return 1;
    }
    const tombstone = nextEnrollmentRemove(validation.enrollment, retention, deps.now());
    try { deps.exportSync.writeCursor(deps.exportSync.enrollmentPath(context.home), tombstone, deps.fs); }
    catch (error) {
      const actual = deps.exportSync.readEnrollment(context.home, deps.fs);
      deps.logger.error(`Could not write removal tombstone: ${error.message}. Durable enrollment on disk: ${enrollmentText(actual)}. No shell files were changed.`);
      return 1;
    }
    for (let index = 0; index < context.targets.length; index++) {
      const target = context.targets[index];
      if (target.parsed.kind === 'malformed') {
        failures.push({ target, error: new Error(target.parsed.reason || 'malformed setup block; left unchanged') });
        continue;
      }
      if (target.parsed.kind !== 'owned') continue;
      const bytes = renderTargetRc(target, context.values, true, deps);
      const result = commitRcTarget(target, bytes, deps);
      if (result.kind !== 'committed') failures.push({ target, error: result.error });
      else await deps.hooks.afterTargetCommit?.({ mode: 'remove', target, index, context });
    }
  } finally {
    try { await deps.exportSync.releaseLock(acquired.handle); } catch {}
  }

  if (failures.length) {
    for (const item of failures) {
      deps.logger.error(`export remains removed; shell cleanup incomplete: ${item.target.logicalPath} (${item.error?.message || 'write failed'})`);
    }
  } else deps.logger.log('Export removed.');
  deps.logger.log('After removal, run unset -f claude in existing POSIX shells or Remove-Item Function:claude in PowerShell; starting a new terminal also clears the wrapper.');
  return failures.length ? 1 : 0;
}

async function runInstall(context, options, deps) {
  const { resolved, conflicts } = context.valueResolution;
  if (conflicts.length) {
    deps.logger.error(`Conflicting owned setup values: ${conflicts.join('; ')}. Pass the matching flag to rewrite every target.`);
    return 2;
  }
  const valueFailures = validateValues(resolved);
  if (valueFailures.length) {
    for (const failure of valueFailures) deps.logger.error(failure);
    return 2;
  }
  if (!resolved.bucket) {
    deps.logger.error('first install needs --bucket');
    return 2;
  }
  if (!resolved.domains?.length) {
    deps.logger.error('first install needs --domains');
    return 2;
  }

  const preflight = await buildInstallChecks(context, options, deps);
  printChecks(preflight.checks, deps.logger);
  if (checkReport(preflight.checks)) {
    deps.logger.error('Setup preflight failed. Nothing was written.');
    return 1;
  }

  const firstInstall = firstOwnedValues(context).length === 0;
  if (firstInstall && resolved.cwdAllowlist === undefined) {
    deps.logger.log('\x1b[33mNotice: repository basenames export unmasked because --cwd-allowlist is not set.\x1b[0m');
  }
  const cursorState = readCursorSeedState(context.home, deps.fs, deps.path);
  const browserPath = deps.path.join(context.home, 'auto-open-browser');
  let browserSetting = null;
  let browserExists = false;
  try { deps.fs.lstatSync(browserPath); browserExists = true; }
  catch (error) { if (error.code !== 'ENOENT') { deps.logger.error(`Cannot read ${browserPath}: ${error.message}`); return 1; } }
  if (firstInstall && !browserExists && !options.yes && isTty(deps)) {
    browserSetting = await askYesNo('Open the dashboard automatically when ccxray starts? [y/n] ', deps) ? 'on' : 'off';
  }
  const current = context.diagnostics.durableHome.enrollment === 'absent'
    ? null
    : context.diagnostics.durableHome.enrollment;
  const next = nextEnrollmentInstall(current, resolved.retentionDays, deps.now());
  if (options.dryRun) {
    printDryRun(context, options, deps, next, cursorState, browserSetting);
    return 0;
  }
  const changeList = changeLines(context, options, cursorState, browserSetting, next, deps);
  if (!await showConsent(context, options, deps, changeList)) return 2;

  await deps.hooks.beforeLock?.({ mode: 'install', context, options });
  const acquired = await acquireSetupLock(context.home, deps);
  if (!acquired.handle) {
    deps.logger.error(acquired.error);
    return 1;
  }
  const partialFailures = [];
  let enrollment = null;
  try {
    const validation = phaseA(context, false, deps);
    if (!validation.ok) {
      deps.logger.error(`${validation.error}; no files were written.`);
      return 1;
    }
    enrollment = nextEnrollmentInstall(validation.enrollment, resolved.retentionDays, deps.now());
    try { deps.exportSync.writeCursor(deps.exportSync.enrollmentPath(context.home), enrollment, deps.fs); }
    catch (error) {
      const actual = deps.exportSync.readEnrollment(context.home, deps.fs);
      deps.logger.error(`Could not write enrollment: ${error.message}. Durable enrollment on disk: ${enrollmentText(actual)}. No cursor, shell, or browser files were changed.`);
      return 1;
    }

    const cursorBeforeSeed = readCursorSeedState(context.home, deps.fs, deps.path);
    if (cursorBeforeSeed.error) {
      partialFailures.push({ file: cursorBeforeSeed.path, error: cursorBeforeSeed.error });
    } else if (cursorBeforeSeed.absent) {
      const seed = cursorSeed(context.home, enrollment, deps);
      if (seed.kind === 'failed') partialFailures.push({ file: seed.path, error: seed.error });
    }

    for (let index = 0; index < context.targets.length; index++) {
      const target = context.targets[index];
      const bytes = renderTargetRc(target, resolved, false, deps);
      const result = commitRcTarget(target, bytes, deps);
      if (result.kind !== 'committed') partialFailures.push({ file: target.logicalPath, error: result.error });
      else await deps.hooks.afterTargetCommit?.({ mode: 'install', target, index, context });
    }

    if (browserSetting) {
      try { atomicWriteBrowser(context.home, browserSetting, deps); }
      catch (error) { partialFailures.push({ file: browserPath, error }); }
    }
  } finally {
    try { await deps.exportSync.releaseLock(acquired.handle); } catch {}
  }

  if (partialFailures.length) {
    for (const failure of partialFailures) {
      deps.logger.error(`enrollment is ACTIVE (state: enrolled) — an already-running exporter with export settings may upload; ${failure.file} was not updated. Re-run ccxray setup, or ccxray setup --remove to un-enroll. (${failure.error?.message || 'write failed'})`);
    }
    return 1;
  }
  deps.logger.log('ccxray setup complete. Restart Claude Code sessions to activate the wrapper.');
  return 0;
}

async function runSetup(argv = process.argv.slice(3), overrides = {}) {
  const deps = makeDeps(overrides);
  const parsed = parseArgs(argv);
  if (parsed.error) {
    deps.logger.error(parsed.error);
    return 2;
  }
  const options = parsed.options;
  const explicit = {
    bucket: parseShellValueFlag(options, '--bucket'),
    domains: parseShellValueFlag(options, '--domains', parseDomainFlag),
    prefix: parseShellValueFlag(options, '--prefix'),
    retentionDays: parseShellValueFlag(options, '--retention-days', Number),
    cwdAllowlist: parseShellValueFlag(options, '--cwd-allowlist'),
  };
  const invalidValues = validateValues(explicit);
  if (invalidValues.length) {
    for (const failure of invalidValues) deps.logger.error(failure);
    return 2;
  }

  if (options.browser) return runBrowserMode(options, deps);

  const context = await prepareContext(options, deps);
  for (const notice of context.resolution.notices || []) deps.logger.log(notice);
  if (options.check) {
    const checks = await buildCheckReport(context, options, deps);
    printChecks(checks, deps.logger);
    return checkReport(checks);
  }
  if (options.remove) return runRemove(context, options, deps);
  return runInstall(context, options, deps);
}

module.exports = {
  START_MARKER,
  END_MARKER,
  WRAPPER_MARKER,
  usageLine,
  parseArgs,
  normalizeDomains,
  validateValues,
  decodeRc,
  encodeRc,
  parseRcBlock,
  renderRcBlock,
  spliceRc,
  scanConflicts,
  resolveChain,
  chainIsStale,
  resolveValues,
  resolveTargets,
  dedupeTargets,
  targetProbeDescriptors,
  findExecutable,
  parseFrame,
  powershellEncoded,
  powershellDiscoveryScript,
  powershellProbeScript,
  runSetupProcess,
  readExpectedTranscripts,
  scanIndexPopulation,
  inspectPopulation,
  buildCheckReport,
  buildInstallChecks,
  executionPolicyCheck,
  printDryRun,
  changeLines,
  verifyTargetSnapshot,
  commitRcTarget,
  cursorSeed,
  runSetup,
};





