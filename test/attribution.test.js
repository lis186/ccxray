'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_ATTRIBUTION_LENGTH,
  buildAttributionPrefix,
  parseAttributionSegment,
  requestAttribution,
  sanitizeAttributionValue,
} = require('../server/attribution');
const hub = require('../server/hub');
const { deploymentFields } = require('../server/entry');

describe('attribution values', () => {
  it('trims, drops control characters, and bounds length', () => {
    assert.equal(sanitizeAttributionValue('  A-012\n'), 'A-012');
    assert.equal(sanitizeAttributionValue('a\u0000b\u001fc'), 'abc');
    assert.equal(sanitizeAttributionValue('   '), null);
    assert.equal(sanitizeAttributionValue(42), null);
    assert.equal(sanitizeAttributionValue('x'.repeat(MAX_ATTRIBUTION_LENGTH)), 'x'.repeat(MAX_ATTRIBUTION_LENGTH));
    assert.equal(sanitizeAttributionValue('x'.repeat(MAX_ATTRIBUTION_LENGTH + 1)), null);
  });

  it('round-trips through the path segment, including reserved characters', () => {
    const attribution = { task: 'A-012', role: 'cross-check', project: 'ipad pos/north&east=1' };
    const prefix = buildAttributionPrefix(attribution);
    assert.ok(prefix.startsWith('/_ccxray/attr/'));
    const segment = prefix.slice('/_ccxray/attr/'.length);
    assert.ok(!/[/?&=]/.test(segment), `segment must be one opaque path part: ${segment}`);
    assert.deepEqual(parseAttributionSegment(segment), {
      task: 'A-012', role: 'cross-check', taskProject: 'ipad pos/north&east=1',
    });
  });

  it('builds no prefix when nothing usable is supplied', () => {
    assert.equal(buildAttributionPrefix({}), '');
    assert.equal(buildAttributionPrefix({ task: '  ', role: null }), '');
    assert.equal(buildAttributionPrefix({ taskProject: 'p' }), `/_ccxray/attr/${encodeURIComponent('project=p')}`);
  });

  it('yields no attribution for a malformed or foreign segment instead of throwing', () => {
    assert.deepEqual(parseAttributionSegment('%E0%A4%A'), {});
    assert.deepEqual(parseAttributionSegment(''), {});
    assert.deepEqual(parseAttributionSegment(encodeURIComponent('agentId=spoof&userEmail=a@b')), {});
  });
});

describe('requestAttribution', () => {
  it('reads headers, taking the first comma-joined segment', () => {
    assert.deepEqual(requestAttribution({ headers: {
      'x-ccxray-task': 'A-1, X-Ccxray-Auth: secret',
      'x-ccxray-role': ['spec', 'ignored'],
      'x-ccxray-project': 'pos',
    } }), { task: 'A-1', role: 'spec', taskProject: 'pos' });
  });

  it('lets the routed prefix win per key and keeps other header keys', () => {
    assert.deepEqual(requestAttribution({
      headers: { 'x-ccxray-task': 'stale', 'x-ccxray-role': 'from-header' },
      ccxrayAttribution: { task: 'fresh' },
    }), { task: 'fresh', role: 'from-header' });
  });

  it('returns an empty object for an unattributed request', () => {
    assert.deepEqual(requestAttribution({ headers: {} }), {});
    assert.deepEqual(requestAttribution(null), {});
  });
});

describe('applyClientRoute with attribution prefixes', () => {
  const attr = buildAttributionPrefix({ task: 'A-2', role: 'worker' });

  it('composes with the client route in either order', () => {
    for (const url of [`/_ccxray/client/77${attr}/v1/responses?s=1`, `${attr}/_ccxray/client/77/v1/responses?s=1`]) {
      const req = { url };
      assert.equal(hub.applyClientRoute(req), true);
      assert.equal(req.url, '/v1/responses?s=1');
      assert.equal(req.ccxrayClientPid, 77);
      assert.deepEqual(req.ccxrayAttribution, { task: 'A-2', role: 'worker' });
    }
  });

  it('lets an inner launch override an outer one per key', () => {
    const req = { url: `${attr}${buildAttributionPrefix({ task: 'A-3' })}/v1/messages` };
    assert.equal(hub.applyClientRoute(req), true);
    assert.deepEqual(req.ccxrayAttribution, { task: 'A-3', role: 'worker' });
    assert.equal(req.url, '/v1/messages');
  });

  it('strips every leading prefix, however many, so none is forwarded upstream', () => {
    // Found in independent review: a cap on the number of stripped prefixes
    // left the remainder in req.url, and the proxy forwards req.url verbatim.
    const many = Array.from({ length: 40 }, (_, i) => buildAttributionPrefix({ task: `T-${i}` })).join('');
    const req = { url: `/_ccxray/client/5${many}/v1/messages?x=1` };
    assert.equal(hub.applyClientRoute(req), true);
    assert.equal(req.url, '/v1/messages?x=1');
    assert.ok(!req.url.includes('_ccxray'));
    assert.equal(req.ccxrayAttribution.task, 'T-39');
  });

  it('keeps the original client-route behaviour for bare and query-only URLs', () => {
    const bare = { url: '/_ccxray/client/12' };
    assert.equal(hub.applyClientRoute(bare), true);
    assert.equal(bare.url, '/');
    const query = { url: '/_ccxray/client/12?x=1' };
    assert.equal(hub.applyClientRoute(query), true);
    assert.equal(query.url, '/?x=1');
    const similar = { url: '/_ccxray/attrX/v1' };
    assert.equal(hub.applyClientRoute(similar), false);
    assert.equal(similar.url, '/_ccxray/attrX/v1');
  });
});

describe('launch-time attribution identity', () => {
  it('carries task, role, and project through hub registration', () => {
    assert.deepEqual(hub.clientIdentityFromMessage({
      agentType: 'grok', task: ' A-9 ', role: 'acceptance', taskProject: 'pos', unknown: 'dropped',
    }), { agentType: 'grok', task: 'A-9', role: 'acceptance', taskProject: 'pos' });
  });

  it('projects identity attribution into deployment fields, env only as fallback', () => {
    const fromIdentity = deploymentFields(Date.now(), {
      identity: { task: 'A-9', role: 'acceptance', taskProject: 'pos' },
      env: { CCXRAY_TASK: 'ENV', CCXRAY_ROLE: 'ENV', CCXRAY_PROJECT: 'ENV' },
    });
    assert.equal(fromIdentity.task, 'A-9');
    assert.equal(fromIdentity.role, 'acceptance');
    assert.equal(fromIdentity.taskProject, 'pos');

    const fromEnv = deploymentFields(Date.now(), { env: { CCXRAY_TASK: 'E-1', CCXRAY_PROJECT: 'envproj' } });
    assert.equal(fromEnv.task, 'E-1');
    assert.equal(fromEnv.taskProject, 'envproj');
    assert.equal('role' in fromEnv, false);

    const noEnv = deploymentFields(Date.now(), { env: { CCXRAY_TASK: 'E-1' }, useEnvIdentity: false });
    assert.equal('task' in noEnv, false);
  });
});
