'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ENV_KEYS = [
  'CCXRAY_EXPORT_DISABLE',
  'NODE_TEST_CONTEXT',
  'CCXRAY_EXPORT_CONFIG_DIRS',
  'CCXRAY_EXPORT_GCS_BUCKET',
  'CCXRAY_IMPORT_HOMES',
  'CCXRAY_IMPORT_CODEX_HOMES',
  'CCXRAY_HOME',
];
const originalEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
const originalImportDisable = process.env.CCXRAY_IMPORT_DISABLE;
const tempHomes = new Set();
const bootstrapHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-config-status-bootstrap-'));
tempHomes.add(bootstrapHome);
fs.mkdirSync(path.join(bootstrapHome, 'logs'), { recursive: true });
fs.writeFileSync(path.join(bootstrapHome, 'logs', 'index.ndjson'), '');
process.env.CCXRAY_HOME = bootstrapHome;
process.env.CCXRAY_IMPORT_DISABLE = '1';

const exportSync = require('../server/export-sync');
const importer = require('../server/importer');

function withAmbientEnv(ambient, fn) {
  const saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  try {
    for (const key of ENV_KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(ambient || {})) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return fn();
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

function makeHome(cursor) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-config-status-'));
  tempHomes.add(home);
  if (cursor !== undefined) {
    fs.writeFileSync(path.join(home, 'export-cursor.json'), cursor);
  }
  return home;
}

function cursorExpected(home, fields) {
  return {
    home,
    cursorPath: path.join(home, 'export-cursor.json'),
    ...fields,
  };
}

after(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (originalImportDisable === undefined) delete process.env.CCXRAY_IMPORT_DISABLE;
  else process.env.CCXRAY_IMPORT_DISABLE = originalImportDisable;
  for (const home of tempHomes) fs.rmSync(home, { recursive: true, force: true });
});

describe('hub-owned config status value producers', () => {
  it('D1: iterates the five exportState/exportReason outcomes with pinned precedence', () => {
    exportSync._setUploader(null);
    const outcomes = [
      {
        name: 'unconfigured',
        env: {},
        suppressionReason: null,
        expected: { exportState: 'unconfigured', exportReason: null },
      },
      {
        name: 'suppressed explicitly-disabled',
        env: {
          CCXRAY_EXPORT_DISABLE: '1',
          CCXRAY_EXPORT_CONFIG_DIRS: '.claude',
        },
        suppressionReason: 'explicitly-disabled',
        expected: { exportState: 'suppressed', exportReason: 'explicitly-disabled' },
      },
      {
        name: 'suppressed test-run',
        env: {
          NODE_TEST_CONTEXT: '1',
          CCXRAY_EXPORT_CONFIG_DIRS: '.claude',
        },
        suppressionReason: 'test-run',
        expected: { exportState: 'suppressed', exportReason: 'test-run' },
      },
      {
        name: 'refused config-dirs-retired',
        env: {
          CCXRAY_EXPORT_CONFIG_DIRS: '',
          CCXRAY_EXPORT_GCS_BUCKET: 'status-test-bucket',
        },
        suppressionReason: null,
        expected: { exportState: 'refused', exportReason: 'config-dirs-retired' },
      },
      {
        name: 'enabled',
        env: { CCXRAY_EXPORT_GCS_BUCKET: 'status-test-bucket' },
        suppressionReason: null,
        expected: { exportState: 'enabled', exportReason: null },
      },
    ];

    for (const outcome of outcomes) {
      withAmbientEnv({}, () => {
        assert.equal(exportSync.exportSuppressionReason(outcome.env), outcome.suppressionReason,
          `${outcome.name}: suppression reason`);
        assert.deepEqual(exportSync.exportStatus(outcome.env), outcome.expected, outcome.name);
      });
    }
  });

  it('D2: iterates both configured import-root variables through one coded producer', () => {
    const cases = [
      {
        variable: 'CCXRAY_IMPORT_HOMES',
        argument: { CCXRAY_IMPORT_HOMES: 'relative-one, /absolute-root, relative-two' },
        expected: [{
          code: 'relative-import-root',
          args: { variable: 'CCXRAY_IMPORT_HOMES', values: ['relative-one', 'relative-two'] },
        }],
      },
      {
        variable: 'CCXRAY_IMPORT_CODEX_HOMES',
        argument: { CCXRAY_IMPORT_CODEX_HOMES: 'relative-codex, /absolute-root, another-codex' },
        expected: [{
          code: 'relative-import-root',
          args: { variable: 'CCXRAY_IMPORT_CODEX_HOMES', values: ['relative-codex', 'another-codex'] },
        }],
      },
    ];

    for (const row of cases) {
      withAmbientEnv({ [row.variable]: 'ambient-relative-root' }, () => {
        assert.deepEqual(importer.relativeRootComplaints(row.argument), row.expected, row.variable);
      });
    }
  });

  it('D3: one injection table proves every env/home argument beats conflicting ambient state', () => {
    exportSync._setUploader(null);
    const ambientHome = makeHome(JSON.stringify({ lastId: 'ambient-id', partial: false, cutoffDt: '2026-01-01' }));
    const argumentHome = makeHome(JSON.stringify({ lastId: 'argument-id', partial: true, cutoffDt: '2026-08-29' }));
    const argumentCursorMtimeMs = fs.statSync(path.join(argumentHome, 'export-cursor.json')).mtimeMs;
    const cases = [
      {
        name: 'exportSuppressionReason',
        fn: exportSync.exportSuppressionReason,
        ambientValue: { CCXRAY_EXPORT_DISABLE: '1' },
        argumentValue: {},
        expected: null,
      },
      {
        name: 'isExportSuppressed',
        fn: exportSync.isExportSuppressed,
        ambientValue: { CCXRAY_EXPORT_DISABLE: '1' },
        argumentValue: {},
        expected: false,
      },
      {
        name: 'configDirsRefusal',
        fn: exportSync.configDirsRefusal,
        ambientValue: { CCXRAY_EXPORT_CONFIG_DIRS: 'ambient-refusal' },
        argumentValue: {},
        expected: null,
      },
      {
        name: 'exportStatus',
        fn: exportSync.exportStatus,
        ambientValue: { CCXRAY_EXPORT_CONFIG_DIRS: 'ambient-refusal' },
        argumentValue: { CCXRAY_EXPORT_GCS_BUCKET: 'argument-bucket' },
        expected: { exportState: 'enabled', exportReason: null },
      },
      {
        name: 'relativeRootComplaints',
        fn: importer.relativeRootComplaints,
        ambientValue: { CCXRAY_IMPORT_HOMES: 'ambient-relative-root' },
        argumentValue: { CCXRAY_IMPORT_CODEX_HOMES: 'argument-relative-root' },
        expected: [{
          code: 'relative-import-root',
          args: { variable: 'CCXRAY_IMPORT_CODEX_HOMES', values: ['argument-relative-root'] },
        }],
      },
      {
        name: 'readExportCursorFacts',
        fn: exportSync.readExportCursorFacts,
        ambientValue: { CCXRAY_HOME: ambientHome },
        argumentValue: argumentHome,
        expected: cursorExpected(argumentHome, {
          present: true,
          mtimeMs: argumentCursorMtimeMs,
          lastId: 'argument-id',
          partial: true,
          cutoffDt: '2026-08-29',
          unreadable: false,
        }),
      },
    ];

    for (const row of cases) {
      withAmbientEnv(row.ambientValue, () => {
        assert.deepEqual(row.fn(row.argumentValue), row.expected, row.name);
      });
    }
  });

  it('D4: iterates absent, present-valid, and present-corrupt cursor facts without renaming', () => {
    const cases = [
      {
        name: 'absent',
        body: undefined,
        expected: {
          present: false, mtimeMs: null, lastId: null, partial: null, cutoffDt: null, unreadable: false,
        },
      },
      {
        name: 'present-valid',
        body: JSON.stringify({ lastId: 'valid-id', partial: false, cutoffDt: '2026-08-29' }),
        expected: {
          present: true, mtimeMs: 'file', lastId: 'valid-id', partial: false,
          cutoffDt: '2026-08-29', unreadable: false,
        },
      },
      {
        name: 'present-corrupt',
        body: '{not-json\n',
        expected: {
          present: true, mtimeMs: 'file', lastId: null, partial: null, cutoffDt: null, unreadable: true,
        },
      },
    ];

    for (const row of cases) {
      const home = makeHome(row.body);
      const before = fs.readdirSync(home).sort();
      const stat = row.body === undefined
        ? null
        : fs.statSync(path.join(home, 'export-cursor.json'));
      const expected = cursorExpected(home, {
        ...row.expected,
        ...(row.expected.mtimeMs === 'file' ? { mtimeMs: stat.mtimeMs } : {}),
      });
      assert.deepEqual(exportSync.readExportCursorFacts(home), expected, row.name);
      const after = fs.readdirSync(home).sort();
      assert.deepEqual(after, before, `${row.name}: cursor read must not change directory entries`);
      if (row.name === 'present-corrupt') {
        assert.equal(fs.existsSync(path.join(home, 'export-cursor.json')), true,
          'corrupt cursor must remain at its original path');
        assert.equal(after.some(name => name.startsWith('export-cursor.json.corrupt-')), false,
          'corrupt cursor must not be renamed aside');
      }
    }
  });

  it('renders known and unknown warnings, while preserving the existing importer call-site string', () => {
    const warning = importer.relativeRootComplaints({
      CCXRAY_IMPORT_HOMES: 'relative-root',
    })[0];
    assert.equal(importer.renderConfigWarning(warning), 'CCXRAY_IMPORT_HOMES: "relative-root"');
    const legacyCallSiteOutput = `[ccxray] ignoring non-absolute scan root — ${warning}`;
    assert.equal(legacyCallSiteOutput,
      '[ccxray] ignoring non-absolute scan root — CCXRAY_IMPORT_HOMES: "relative-root"');

    assert.equal(importer.renderConfigWarning({
      code: 'future-warning',
      args: { rawValue: 'keep-me', count: 2 },
    }), 'future-warning: {"rawValue":"keep-me","count":2}');
  });
});
