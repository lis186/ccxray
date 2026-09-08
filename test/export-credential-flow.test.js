'use strict';

// #633 M0: the exporter's token stage consumes a discovery record and never
// prints an upstream body; the startup banner states the offline stages only.
// Every path here is synthetic and injected — no real ADC file, no network.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const exportSync = require('../server/export-sync');
const { discoverCredentials, CredentialError } = require('../server/export-credentials');

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const SA_KEY = {
  type: 'service_account',
  client_email: 'writer@synthetic.invalid',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
};
const ADC_USER = {
  type: 'authorized_user',
  client_id: 'synthetic-client-id',
  client_secret: 'synthetic-client-secret',
  refresh_token: 'synthetic-refresh-token',
};

function recordFor(env, files) {
  return discoverCredentials({
    env,
    platform: 'linux',
    homedir: () => '',
    readFile: p => {
      if (files[p] !== undefined) return JSON.stringify(files[p]);
      const err = new Error('ENOENT'); err.code = 'ENOENT'; throw err;
    },
  });
}

let exchanges;
beforeEach(() => {
  exchanges = [];
  exportSync._resetTokenCache();
  exportSync._setTokenExchanger(async body => {
    exchanges.push(body);
    return { access_token: 'synthetic-access-token', expires_in: 3600 };
  });
});
afterEach(() => {
  exportSync._setTokenExchanger(null);
  exportSync._resetTokenCache();
});

test('a service_account key file is exchanged as a signed JWT assertion', async () => {
  const record = recordFor({ CCXRAY_EXPORT_GCS_KEY_FILE: '/k.json' }, { '/k.json': SA_KEY });
  const token = await exportSync.getAccessToken(record);
  assert.equal(token, 'synthetic-access-token');
  assert.equal(exchanges.length, 1);
  assert.match(exchanges[0], /^grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=/);
  const jwt = exchanges[0].split('assertion=')[1];
  const [header, payload] = jwt.split('.').slice(0, 2).map(part => JSON.parse(Buffer.from(part, 'base64url')));
  assert.equal(header.alg, 'RS256');
  assert.equal(payload.iss, 'writer@synthetic.invalid');
  assert.equal(payload.scope, 'https://www.googleapis.com/auth/devstorage.read_write');
});

test('an authorized_user ADC file is exchanged as a refresh_token grant from the discovered path', async () => {
  const adc = path.join('/cfg', 'application_default_credentials.json');
  const record = recordFor({ CLOUDSDK_CONFIG: '/cfg' }, { [adc]: ADC_USER });
  assert.equal(record.discovery.state, 'adc');
  await exportSync.getAccessToken(record);
  assert.equal(exchanges.length, 1);
  const form = new URLSearchParams(exchanges[0]);
  assert.equal(form.get('grant_type'), 'refresh_token');
  assert.equal(form.get('client_id'), 'synthetic-client-id');
  assert.equal(form.get('refresh_token'), 'synthetic-refresh-token');
});

test('the token is cached across calls until reset', async () => {
  const record = recordFor({ CCXRAY_EXPORT_GCS_KEY_FILE: '/k.json' }, { '/k.json': SA_KEY });
  await exportSync.getAccessToken(record);
  await exportSync.getAccessToken(record);
  assert.equal(exchanges.length, 1);
  exportSync._resetTokenCache();
  await exportSync.getAccessToken(record);
  assert.equal(exchanges.length, 2);
});

test('a record that did not reach parse:ok fails before any exchange, naming the stage and state', async () => {
  const rows = [
    [recordFor({}, {}), 'discovery', 'no-config-root'],
    [recordFor({ CLOUDSDK_CONFIG: '/cfg' }, {}), 'discovery', 'none'],
    [recordFor({ CCXRAY_EXPORT_GCS_KEY_FILE: '/k.json' }, {}), 'parse', 'missing'],
    [recordFor({ CCXRAY_EXPORT_GCS_KEY_FILE: '/k.json' }, { '/k.json': { type: 'external_account' } }), 'parse', 'unsupported-type'],
    [recordFor({ CCXRAY_EXPORT_GCS_KEY_FILE: '/k.json' }, { '/k.json': { type: 'authorized_user', client_id: 'x' } }), 'parse', 'missing-fields'],
  ];
  for (const [record, stage, category] of rows) {
    await assert.rejects(exportSync.getAccessToken(record), err => {
      assert.ok(err instanceof CredentialError, `${stage} ${category}: CredentialError`);
      assert.equal(err.stage, stage);
      assert.equal(err.category, category);
      assert.equal(err.message, `${stage} ${category}`);
      return true;
    });
  }
  assert.equal(exchanges.length, 0, 'no exchange may be attempted for an unusable record');
});

test('a refused exchange surfaces as its category only', async () => {
  exportSync._setTokenExchanger(async () => {
    throw new CredentialError('token', 'refused:invalid_grant');
  });
  const record = recordFor({ CCXRAY_EXPORT_GCS_KEY_FILE: '/k.json' }, { '/k.json': SA_KEY });
  await assert.rejects(exportSync.getAccessToken(record), { message: 'token refused:invalid_grant' });
});

test('startExportSync prints the offline credential stages through the injected logger and never a secret', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-cred-flow-'));
  const home = path.join(root, 'home');
  const gcloud = path.join(root, 'gcloud');
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(home, 'logs', 'index.ndjson'), '');
  fs.mkdirSync(gcloud);
  fs.writeFileSync(path.join(gcloud, 'application_default_credentials.json'), JSON.stringify(ADC_USER));

  const keys = ['CCXRAY_HOME', 'LOGS_DIR', 'CCXRAY_EXPORT_GCS_BUCKET', 'CCXRAY_EXPORT_DISABLE',
    'CCXRAY_EXPORT_CONFIG_DIRS', 'CCXRAY_EXPORT_DOMAINS', 'CCXRAY_USER_EMAIL',
    'CCXRAY_EXPORT_GCS_KEY_FILE', 'CLOUDSDK_CONFIG', 'GOOGLE_APPLICATION_CREDENTIALS'];
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  process.env.CCXRAY_HOME = home;
  process.env.CCXRAY_EXPORT_GCS_BUCKET = 'synthetic-bucket';
  process.env.CLOUDSDK_CONFIG = gcloud;
  process.env.GOOGLE_APPLICATION_CREDENTIALS = path.join(root, 'ignored.json');

  const lines = [];
  const origLog = console.log;
  console.log = (...args) => { lines.push(args.join(' ')); };
  exportSync._setCredentialLogger(line => lines.push('LOGGER ' + line));
  exportSync._setUploader(async () => {});
  try {
    exportSync.startExportSync();
    await exportSync.awaitPendingFlush();
  } finally {
    exportSync.stopExportSync();
    exportSync._setUploader(null);
    exportSync._setCredentialLogger(null);
    console.log = origLog;
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(root, { recursive: true, force: true });
  }

  const banner = lines.find(l => l.startsWith('LOGGER '));
  assert.ok(banner, `credential banner missing from:\n${lines.join('\n')}`);
  assert.match(banner, /\[ccxray export\] credential=discovery:adc at:\$CLOUDSDK_CONFIG\/application_default_credentials\.json parse:ok\(authorized_user\) authorization:unknown ignored:GOOGLE_APPLICATION_CREDENTIALS/);
  assert.doesNotMatch(banner, /token:/, 'startup must not claim a token stage it never ran');
  const all = lines.join('\n');
  for (const secret of ['synthetic-client-secret', 'synthetic-refresh-token', 'synthetic-client-id', root]) {
    assert.doesNotMatch(all, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `leaked: ${secret}`);
  }
});
