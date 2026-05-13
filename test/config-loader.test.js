'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readProjectConfig, DEFAULT_CONFIG } = require('../server/config-loader');
const { tryRequire, isAvailable } = require('../server/otel-lazy');

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-cfg-'));
}

test('config-loader: returns default config when .ccxray.json is absent', () => {
  const dir = mkTmp();
  try {
    const { config, source } = readProjectConfig(dir);
    assert.equal(source, null);
    assert.deepEqual(config, DEFAULT_CONFIG);
    assert.equal(config.otel.enabled, false);
    assert.equal(config.otel.tier, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('config-loader: reads otel block from .ccxray.json', () => {
  const dir = mkTmp();
  try {
    fs.writeFileSync(path.join(dir, '.ccxray.json'), JSON.stringify({
      otel: {
        enabled: true,
        tier: 1,
        endpoint: 'http://collector.local:4318',
        headers: { 'x-team': 'platform' },
        resource_attributes: { 'service.name': 'ccxray-proxy' },
      },
    }));
    const { config, source } = readProjectConfig(dir);
    assert.ok(source && source.endsWith('.ccxray.json'));
    assert.equal(config.otel.enabled, true);
    assert.equal(config.otel.tier, 1);
    assert.equal(config.otel.endpoint, 'http://collector.local:4318');
    assert.equal(config.otel.headers['x-team'], 'platform');
    assert.equal(config.otel.resource_attributes['service.name'], 'ccxray-proxy');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('config-loader: malformed JSON throws with a descriptive error', () => {
  const dir = mkTmp();
  try {
    fs.writeFileSync(path.join(dir, '.ccxray.json'), '{ not valid json');
    assert.throws(() => readProjectConfig(dir), /not valid JSON/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('config-loader: tier defaults to 0 when value is non-integer', () => {
  const dir = mkTmp();
  try {
    fs.writeFileSync(path.join(dir, '.ccxray.json'), JSON.stringify({ otel: { tier: 'one' } }));
    const { config } = readProjectConfig(dir);
    assert.equal(config.otel.tier, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('otel-lazy: tryRequire returns the package object when installed', () => {
  const api = tryRequire('@opentelemetry/api');
  assert.ok(api && typeof api === 'object', 'expected @opentelemetry/api to resolve');
});

test('otel-lazy: tryRequire rejects unknown package names', () => {
  assert.throws(() => tryRequire('@opentelemetry/not-real'), /unknown package/);
});

test('otel-lazy: isAvailable returns true once all known packages resolve', () => {
  assert.equal(isAvailable(), true);
});
