'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  discoverCredentials,
  describeCredentials,
  credentialText,
  tokenError,
  networkError,
  uploadError,
} = require('../server/export-credentials');

// Synthetic credential bodies. Nothing here is a real client id, secret, or key.
const ADC_USER = JSON.stringify({
  type: 'authorized_user',
  client_id: 'synthetic-client-id',
  client_secret: 'synthetic-client-secret',
  refresh_token: 'synthetic-refresh-token',
});
const SA_KEY = JSON.stringify({
  type: 'service_account',
  client_email: 'writer@synthetic.invalid',
  private_key: '-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----\n',
});

// Every test injects its own filesystem: the real ~/.config/gcloud and %APPDATA%
// must never be read by the suite (docs/testing.md).
function fsOf(files) {
  return p => {
    if (Object.prototype.hasOwnProperty.call(files, p)) return files[p];
    const err = new Error(`ENOENT: ${p}`);
    err.code = 'ENOENT';
    throw err;
  };
}

const noHome = () => '';

describe('credential discovery — config root (#633 M0)', () => {
  it('Windows reads %APPDATA%\\gcloud and never a cwd-relative .config path', () => {
    const appdata = 'C:\\Users\\dev\\AppData\\Roaming';
    const adc = path.join(appdata, 'gcloud', 'application_default_credentials.json');
    // The decoy is what the old `process.env.HOME || ''` join resolved to on a
    // machine without HOME: a path relative to the working directory.
    const decoy = path.join('.config', 'gcloud', 'application_default_credentials.json');
    const record = discoverCredentials({
      env: { APPDATA: appdata },
      platform: 'win32',
      homedir: noHome,
      readFile: fsOf({ [adc]: ADC_USER, [decoy]: '{"type":"decoy"}' }),
    });
    assert.equal(record.discovery.state, 'adc');
    assert.equal(record.path, adc);
    assert.equal(record.parse.state, 'ok');
    assert.equal(record.parse.type, 'authorized_user');
    assert.equal(record.discovery.pathLabel, '%APPDATA%\\gcloud/application_default_credentials.json');
  });

  it('a decoy in the working directory is not found when no config root exists', () => {
    const decoy = path.join('.config', 'gcloud', 'application_default_credentials.json');
    const record = discoverCredentials({
      env: {},
      platform: 'win32',
      homedir: noHome,
      readFile: fsOf({ [decoy]: ADC_USER }),
    });
    assert.equal(record.discovery.state, 'no-config-root');
    assert.equal(record.discovery.source, 'APPDATA');
    assert.equal(record.parse.state, 'not-attempted');
    assert.equal(record.path, null);
  });

  it('POSIX uses os.homedir(), not process.env.HOME, and reports no-config-root when both are empty', () => {
    const home = '/home/dev';
    const adc = path.join(home, '.config', 'gcloud', 'application_default_credentials.json');
    const found = discoverCredentials({
      env: {}, platform: 'linux', homedir: () => home, readFile: fsOf({ [adc]: ADC_USER }),
    });
    assert.equal(found.discovery.state, 'adc');
    assert.equal(found.discovery.pathLabel, '~/.config/gcloud/application_default_credentials.json');

    const none = discoverCredentials({ env: {}, platform: 'linux', homedir: noHome, readFile: fsOf({}) });
    assert.equal(none.discovery.state, 'no-config-root');
    assert.equal(none.discovery.source, 'HOME');
  });

  it('CLOUDSDK_CONFIG overrides the platform root on every platform', () => {
    for (const platform of ['win32', 'darwin', 'linux']) {
      const cfg = platform === 'win32' ? 'D:\\gcloud-cfg' : '/opt/gcloud-cfg';
      const adc = path.join(cfg, 'application_default_credentials.json');
      const record = discoverCredentials({
        env: { CLOUDSDK_CONFIG: cfg, APPDATA: 'C:\\ignored' },
        platform,
        homedir: () => '/ignored',
        readFile: fsOf({ [adc]: ADC_USER }),
      });
      assert.equal(record.discovery.state, 'adc', platform);
      assert.equal(record.discovery.source, '$CLOUDSDK_CONFIG', platform);
      assert.equal(record.path, adc, platform);
    }
  });

  it('an absent ADC file is discovery:none with parse not attempted', () => {
    const record = discoverCredentials({
      env: {}, platform: 'darwin', homedir: () => '/Users/dev', readFile: fsOf({}),
    });
    assert.equal(record.discovery.state, 'none');
    assert.equal(record.parse.state, 'not-attempted');
    assert.equal(record.path, null);
  });
});

describe('credential discovery — precedence and parse', () => {
  it('CCXRAY_EXPORT_GCS_KEY_FILE wins over an existing ADC file', () => {
    const home = '/Users/dev';
    const adc = path.join(home, '.config', 'gcloud', 'application_default_credentials.json');
    const key = '/secure/writer-key.json';
    const record = discoverCredentials({
      env: { CCXRAY_EXPORT_GCS_KEY_FILE: key },
      platform: 'darwin',
      homedir: () => home,
      readFile: fsOf({ [adc]: ADC_USER, [key]: SA_KEY }),
    });
    assert.equal(record.discovery.state, 'key-file');
    assert.equal(record.path, key);
    assert.equal(record.parse.type, 'service_account');
    assert.equal(record.discovery.pathLabel, '$CCXRAY_EXPORT_GCS_KEY_FILE');
  });

  it('a configured key file that does not exist is parse:missing, not discovery:none', () => {
    const record = discoverCredentials({
      env: { CCXRAY_EXPORT_GCS_KEY_FILE: '/secure/gone.json' },
      platform: 'darwin', homedir: () => '/Users/dev', readFile: fsOf({}),
    });
    assert.equal(record.discovery.state, 'key-file');
    assert.equal(record.parse.state, 'missing');
  });

  it('iterates every parse state', () => {
    const key = '/k.json';
    const rows = [
      ['malformed', 'not json'],
      ['malformed', '[1,2]'],
      ['unsupported-type', JSON.stringify({ type: 'external_account', audience: 'x' })],
      ['unsupported-type', JSON.stringify({ client_id: 'no-type' })],
      ['missing-fields', JSON.stringify({ type: 'authorized_user', client_id: 'only-id' })],
      ['missing-fields', JSON.stringify({ type: 'service_account', client_email: 'a@b.invalid', private_key: '' })],
      ['ok', SA_KEY],
      ['ok', ADC_USER],
    ];
    for (const [expected, body] of rows) {
      const record = discoverCredentials({
        env: { CCXRAY_EXPORT_GCS_KEY_FILE: key }, platform: 'linux', homedir: noHome, readFile: fsOf({ [key]: body }),
      });
      assert.equal(record.parse.state, expected, body);
    }
    const eacces = discoverCredentials({
      env: { CCXRAY_EXPORT_GCS_KEY_FILE: key }, platform: 'linux', homedir: noHome,
      readFile: () => { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; },
    });
    assert.equal(eacces.parse.state, 'unreadable');
    assert.equal(eacces.parse.code, 'EACCES');
  });

  it('GOOGLE_APPLICATION_CREDENTIALS is diagnosed as ignored and never selected', () => {
    const gac = '/elsewhere/other-identity.json';
    const record = discoverCredentials({
      env: { GOOGLE_APPLICATION_CREDENTIALS: gac },
      platform: 'linux', homedir: noHome, readFile: fsOf({ [gac]: SA_KEY }),
    });
    assert.deepEqual(record.ignoredEnv, ['GOOGLE_APPLICATION_CREDENTIALS']);
    assert.equal(record.discovery.state, 'no-config-root');
    assert.equal(record.path, null);
  });
});

describe('credential display and error redaction', () => {
  it('describeCredentials drops the path and the parsed credential; credentialText carries no secret', () => {
    const key = '/secure/writer-key.json';
    const record = discoverCredentials({
      env: { CCXRAY_EXPORT_GCS_KEY_FILE: key, GOOGLE_APPLICATION_CREDENTIALS: '/x' },
      platform: 'darwin', homedir: noHome, readFile: fsOf({ [key]: SA_KEY }),
    });
    const described = describeCredentials(record);
    assert.equal('path' in described, false);
    assert.equal('credential' in described.parse, false);
    const text = credentialText(described);
    assert.equal(text,
      'credential=discovery:key-file at:$CCXRAY_EXPORT_GCS_KEY_FILE parse:ok(service_account) authorization:unknown ignored:GOOGLE_APPLICATION_CREDENTIALS');
    const serialized = JSON.stringify(described) + text;
    for (const secret of ['/secure', 'writer@synthetic.invalid', 'PRIVATE KEY', 'synthetic']) {
      assert.doesNotMatch(serialized, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), secret);
    }
  });

  it('credentialText states token and authorization only as far as they were exercised', () => {
    const described = describeCredentials(discoverCredentials({
      env: {}, platform: 'darwin', homedir: () => '/Users/dev', readFile: fsOf({}),
    }));
    assert.equal(credentialText(described),
      'credential=discovery:none at:~/.config/gcloud/application_default_credentials.json authorization:unknown');
    assert.equal(credentialText(null), 'credential=unavailable');
  });

  it('token, network, and upload errors are categories, never the upstream body', () => {
    const body = '{"error":"invalid_grant","error_description":"Token has been expired or revoked. client=leaky-client-id"}';
    const refused = tokenError(body);
    assert.equal(refused.message, 'token refused:invalid_grant');
    assert.equal(refused.stage, 'token');
    assert.doesNotMatch(refused.message, /leaky|expired/);
    assert.equal(tokenError('<html>502</html>', 'malformed-response').message, 'token malformed-response');

    const net = networkError('token', Object.assign(new Error('getaddrinfo ENOTFOUND oauth2.googleapis.com'), { code: 'ENOTFOUND' }));
    assert.equal(net.message, 'token network:ENOTFOUND');
    assert.doesNotMatch(net.message, /googleapis/);

    assert.equal(uploadError(401).message, 'authorization unauthenticated');
    assert.equal(uploadError(403).message, 'authorization denied');
    assert.equal(uploadError(503).message, 'upload http-503');
  });
});
