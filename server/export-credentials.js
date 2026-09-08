'use strict';

// GCS writer credential discovery for the exporter (#633 M0).
//
// Two of the four credential stages live here and are offline: DISCOVERY (which
// file, from which rule) and PARSE (is it a credential of a type we can use).
// TOKEN acquisition and destination AUTHORIZATION are only ever attempted by a
// real upload; this module just names their states so status can say
// `not-attempted` / `unknown` instead of implying anything.
//
// Nothing returned by describeCredentials() may carry file contents, raw
// upstream error bodies, or an absolute path — pathLabel is the RULE that chose
// the file, not the file.

const fs = require('fs');
const os = require('os');
const path = require('path');

const KEY_FILE_ENV = 'CCXRAY_EXPORT_GCS_KEY_FILE';
const ADC_FILE = 'application_default_credentials.json';
// Read by other Google tooling but deliberately not by ccxray (owner decision
// 2026-09-09): honoring it on upgrade would silently switch the writer identity
// on machines that already export via the key file or ADC. Diagnosed so the
// operator learns it is being ignored instead of wondering why it has no effect.
const IGNORED_ENV = ['GOOGLE_APPLICATION_CREDENTIALS'];

const REQUIRED_FIELDS = {
  service_account: ['client_email', 'private_key'],
  authorized_user: ['client_id', 'client_secret', 'refresh_token'],
};

// gcloud's own rule for where ADC lives: CLOUDSDK_CONFIG on every platform,
// then %APPDATA%\gcloud on Windows and ~/.config/gcloud elsewhere. There is no
// working-directory fallback — a missing root is a reported state. The old
// `process.env.HOME || ''` resolved `.config/gcloud/...` relative to cwd on any
// machine without HOME, which is every Windows machine.
function gcloudConfigRoot(env, platform, homedir) {
  if (env.CLOUDSDK_CONFIG) return { dir: env.CLOUDSDK_CONFIG, label: '$CLOUDSDK_CONFIG' };
  if (platform === 'win32') {
    if (!env.APPDATA) return null;
    return { dir: path.join(env.APPDATA, 'gcloud'), label: '%APPDATA%\\gcloud' };
  }
  const home = homedir();
  if (!home) return null;
  return { dir: path.join(home, '.config', 'gcloud'), label: '~/.config/gcloud' };
}

function parseCredentialFile(filePath, readFile) {
  let text;
  try {
    text = readFile(filePath);
  } catch (err) {
    return { state: err && err.code === 'ENOENT' ? 'missing' : 'unreadable', type: null, code: err?.code || null };
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { state: 'malformed', type: null };
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { state: 'malformed', type: null };
  const type = typeof json.type === 'string' ? json.type : null;
  const required = REQUIRED_FIELDS[type];
  if (!required) return { state: 'unsupported-type', type };
  const missing = required.filter(f => typeof json[f] !== 'string' || json[f].length === 0);
  if (missing.length) return { state: 'missing-fields', type, missing };
  return { state: 'ok', type, credential: json };
}

// Full record, for the exporter. `path` and `parse.credential` are the only
// fields that may leave this module as anything other than a label; callers
// that render must go through describeCredentials().
function discoverCredentials(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const homedir = options.homedir || os.homedir;
  const readFile = options.readFile || (p => fs.readFileSync(p, 'utf8'));

  const base = {
    token: { state: 'not-attempted' },
    authorization: { state: 'unknown' },
    ignoredEnv: IGNORED_ENV.filter(k => env[k]),
  };

  if (env[KEY_FILE_ENV]) {
    return {
      ...base,
      discovery: { state: 'key-file', source: KEY_FILE_ENV, pathLabel: '$' + KEY_FILE_ENV },
      parse: parseCredentialFile(env[KEY_FILE_ENV], readFile),
      path: env[KEY_FILE_ENV],
    };
  }

  const root = gcloudConfigRoot(env, platform, homedir);
  if (!root) {
    return {
      ...base,
      discovery: { state: 'no-config-root', source: platform === 'win32' ? 'APPDATA' : 'HOME', pathLabel: null },
      parse: { state: 'not-attempted', type: null },
      path: null,
    };
  }

  const adcPath = path.join(root.dir, ADC_FILE);
  const parse = parseCredentialFile(adcPath, readFile);
  if (parse.state === 'missing') {
    return {
      ...base,
      discovery: { state: 'none', source: root.label, pathLabel: root.label + '/' + ADC_FILE },
      parse: { state: 'not-attempted', type: null },
      path: null,
    };
  }
  return {
    ...base,
    discovery: { state: 'adc', source: root.label, pathLabel: root.label + '/' + ADC_FILE },
    parse,
    path: adcPath,
  };
}

// Display-safe view: same shape minus the file path and the parsed credential.
function describeCredentials(record) {
  const { credential, ...parse } = record.parse;
  return {
    discovery: record.discovery,
    parse,
    token: record.token,
    authorization: record.authorization,
    ignoredEnv: record.ignoredEnv,
  };
}

// One line for the Process: status surface and the exporter's startup banner.
function credentialText(described) {
  if (!described || !described.discovery) return 'credential=unavailable';
  const parts = [`discovery:${described.discovery.state}`];
  if (described.discovery.pathLabel) parts.push(`at:${described.discovery.pathLabel}`);
  const p = described.parse;
  if (p && p.state !== 'not-attempted') {
    parts.push(`parse:${p.state}${p.type ? `(${p.type})` : ''}`);
  }
  if (described.token && described.token.state !== 'not-attempted') parts.push(`token:${described.token.state}`);
  if (described.authorization) parts.push(`authorization:${described.authorization.state}`);
  if (described.ignoredEnv && described.ignoredEnv.length) parts.push(`ignored:${described.ignoredEnv.join(',')}`);
  return 'credential=' + parts.join(' ');
}

// Errors the exporter raises from the token and upload stages. The message is
// built from the category alone: Google's token endpoint answers with a JSON
// body that names the client, and a GCS 403 body names the principal and the
// bucket — neither belongs in hub.log or a terminal.
class CredentialError extends Error {
  constructor(stage, category) {
    super(`${stage} ${category}`);
    this.stage = stage;
    this.category = category;
  }
}

function tokenError(body, fallback) {
  let category = fallback || 'refused';
  try {
    const j = JSON.parse(body);
    if (j && typeof j.error === 'string') category = `refused:${j.error}`;
  } catch {}
  return new CredentialError('token', category);
}

function networkError(stage, err) {
  return new CredentialError(stage, err && err.code ? `network:${err.code}` : 'network');
}

function uploadError(statusCode) {
  if (statusCode === 401) return new CredentialError('authorization', 'unauthenticated');
  if (statusCode === 403) return new CredentialError('authorization', 'denied');
  return new CredentialError('upload', `http-${statusCode}`);
}

module.exports = {
  KEY_FILE_ENV,
  discoverCredentials,
  describeCredentials,
  credentialText,
  CredentialError,
  tokenError,
  networkError,
  uploadError,
};
