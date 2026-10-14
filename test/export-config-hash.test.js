'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { exportConfigHash, exportConfigObject } = require('../server/export-sync');

const BASE = Object.freeze({
  CCXRAY_EXPORT_DISABLE: '0',
  NODE_TEST_CONTEXT: undefined,
  CCXRAY_EXPORT_CONFIG_DIRS: undefined,
  CCXRAY_EXPORT_GCS_BUCKET: 'bucket-a',
  CCXRAY_EXPORT_GCS_PREFIX: 'daily',
  CCXRAY_EXPORT_DOMAINS: 'example.com',
  CCXRAY_TEAM: 'team-a',
  CCXRAY_USER_EMAIL: 'person@example.com',
  CCXRAY_AGENT_ID: 'agent-a',
  CCXRAY_EXPORT_CWD_ALLOWLIST: 'repo-a',
  CCXRAY_EXPORT_GCS_KEY_FILE: undefined,
  CLOUDSDK_CONFIG: '/fixture/gcloud-a',
});

const hash = overrides => exportConfigHash({ ...BASE, ...overrides });

describe('export config fingerprint', () => {
  it('is deterministic and includes only the canonical object keys in fixed order', () => {
    const first = exportConfigObject({ ...BASE });
    const second = exportConfigObject({ ...BASE });
    assert.deepEqual(first, second);
    assert.deepEqual(Object.keys(first), [
      'v', 'disabled', 'testContext', 'configDirsRefused', 'bucket', 'prefix',
      'domains', 'team', 'userEmailHash', 'agentIdHash', 'cwdFilter', 'credentialSelector',
    ]);
    assert.equal(exportConfigHash({ ...BASE }), crypto.createHash('sha256')
      .update(JSON.stringify(first)).digest('hex'));
  });

  it('changes when each enumerated environment setting changes', () => {
    const changes = [
      { CCXRAY_EXPORT_DISABLE: '1' },
      { NODE_TEST_CONTEXT: 'child-v8' },
      { CCXRAY_EXPORT_CONFIG_DIRS: '' },
      { CCXRAY_EXPORT_GCS_BUCKET: 'bucket-b' },
      { CCXRAY_EXPORT_GCS_PREFIX: 'other-prefix' },
      { CCXRAY_EXPORT_DOMAINS: 'other.test' },
      { CCXRAY_TEAM: 'team-b' },
      { CCXRAY_USER_EMAIL: 'other@example.com' },
      { CCXRAY_AGENT_ID: 'agent-b' },
      { CCXRAY_EXPORT_CWD_ALLOWLIST: 'repo-b' },
      { CLOUDSDK_CONFIG: '/fixture/gcloud-b' },
      { CCXRAY_EXPORT_GCS_KEY_FILE: '/fixture/key-b.json' },
    ];
    for (const change of changes) assert.notEqual(hash(change), hash({}), JSON.stringify(change));
  });

  it('normalizes domain order, case, whitespace, and duplicates', () => {
    const a = hash({ CCXRAY_EXPORT_DOMAINS: ' Example.com,other.test,EXAMPLE.COM ' });
    const b = hash({ CCXRAY_EXPORT_DOMAINS: 'other.test,example.com' });
    assert.equal(a, b);
    assert.deepEqual(exportConfigObject({
      ...BASE, CCXRAY_EXPORT_DOMAINS: ' Example.com,other.test,EXAMPLE.COM ',
    }).domains, ['example.com', 'other.test']);
  });

  it('distinguishes empty, whitespace-only, and configured list values', () => {
    const absent = exportConfigObject({ ...BASE, CCXRAY_EXPORT_CWD_ALLOWLIST: undefined });
    const empty = exportConfigObject({ ...BASE, CCXRAY_EXPORT_CWD_ALLOWLIST: '' });
    const spaces = exportConfigObject({ ...BASE, CCXRAY_EXPORT_CWD_ALLOWLIST: '  ' });
    const values = exportConfigObject({ ...BASE, CCXRAY_EXPORT_CWD_ALLOWLIST: 'repo-a, repo-b,repo-a' });
    assert.deepEqual(absent.cwdFilter, { configured: false, values: [] });
    assert.deepEqual(empty.cwdFilter, { configured: false, values: [] });
    assert.deepEqual(spaces.cwdFilter, { configured: true, values: [] });
    assert.deepEqual(values.cwdFilter, { configured: true, values: ['repo-a', 'repo-b'] });
    assert.equal(hash({ CCXRAY_EXPORT_CWD_ALLOWLIST: '' }), hash({ CCXRAY_EXPORT_CWD_ALLOWLIST: undefined }));
    assert.notEqual(hash({ CCXRAY_EXPORT_CWD_ALLOWLIST: '  ' }), hash({ CCXRAY_EXPORT_CWD_ALLOWLIST: '' }));
  });

  it('uses boolean disable semantics, key-file selector precedence, and the default prefix', () => {
    assert.notEqual(hash({ CCXRAY_EXPORT_DISABLE: '0' }), hash({ CCXRAY_EXPORT_DISABLE: '1' }));
    assert.equal(hash({ CCXRAY_EXPORT_GCS_PREFIX: '' }), hash({ CCXRAY_EXPORT_GCS_PREFIX: undefined }));
    const selected = exportConfigObject({
      ...BASE,
      CCXRAY_EXPORT_GCS_KEY_FILE: '/fixture/key.json',
      CLOUDSDK_CONFIG: '/fixture/ignored-gcloud',
    }).credentialSelector;
    assert.deepEqual(selected, {
      mode: 'key-file',
      hash: crypto.createHash('sha256').update('/fixture/key.json').digest('hex'),
    });
    assert.deepEqual(exportConfigObject({
      ...BASE, CCXRAY_EXPORT_GCS_KEY_FILE: undefined, CLOUDSDK_CONFIG: undefined,
    }).credentialSelector, { mode: 'platform-default' });
  });

  it('stores hashes instead of raw email or credential selector values', () => {
    const rawEmail = 'sensitive.fixture@example.test';
    const rawPath = '/private/fixture/key.json';
    const object = exportConfigObject({
      ...BASE,
      CCXRAY_USER_EMAIL: rawEmail,
      CCXRAY_EXPORT_GCS_KEY_FILE: rawPath,
    });
    const serialized = JSON.stringify(object);
    assert.equal(object.userEmailHash, crypto.createHash('sha256').update(rawEmail).digest('hex'));
    assert.equal(object.credentialSelector.hash, crypto.createHash('sha256').update(rawPath).digest('hex'));
    assert.equal(serialized.includes(rawEmail), false);
    assert.equal(serialized.includes(rawPath), false);
    assert.equal(hash({ CCXRAY_USER_EMAIL: rawEmail }).includes(rawEmail), false);
  });
});
