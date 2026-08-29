'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { renderHubClientStatus } = require('../server/hub-client-status');

const indexPath = process.env.CCXRAY_INDEX_SOURCE || path.join(__dirname, '..', 'server', 'index.js');
const indexSource = fs.readFileSync(indexPath, 'utf8');

const hubIdentity = {
  kind: 'hub',
  pid: 7123,
  port: 5577,
  home: '/hub-owned-home',
  logsDir: '/hub-owned-logs',
};
const clientIdentity = {
  kind: 'client',
  pid: 9988,
  port: null,
  home: '/client-owned-home',
  logsDir: '/client-owned-logs',
};

function stateFor(exportState, exportReason = null, configWarnings = []) {
  return { exportState, exportReason, configWarnings };
}

function renderReply(reply, lifecycle = 'attached') {
  return renderHubClientStatus(
    reply?.identity || null,
    lifecycle,
    reply && {
      exportState: reply.exportState,
      exportReason: reply.exportReason,
      configWarnings: reply.configWarnings,
    },
  );
}

describe('hub client export/config status render', () => {
  const recoveryOutcomes = [
    {
      outcome: 'success → register resolves a reply',
      callback: 'onRecovery',
      lifecycle: 'recovered',
    },
    {
      outcome: 'success → register resolves null',
      callback: 'onRecovery',
      lifecycle: 'recovery-failed',
    },
    {
      outcome: 'success → register rejects',
      callback: 'onRecovery',
      lifecycle: 'recovery-failed',
    },
    {
      outcome: 'replacement hub on the wrong port',
      callback: 'onRecoveryFailure',
      lifecycle: 'recovery-failed',
    },
    {
      outcome: 'fork/readiness throws or times out',
      callback: 'onRecoveryFailure',
      lifecycle: 'recovery-failed',
    },
  ];

  it('keeps the five terminal recovery outcomes on the status-render path', () => {
    assert.deepEqual(
      recoveryOutcomes.map(row => row.lifecycle),
      ['recovered', 'recovery-failed', 'recovery-failed', 'recovery-failed', 'recovery-failed'],
    );
    assert.deepEqual(
      recoveryOutcomes.map(row => row.callback),
      ['onRecovery', 'onRecovery', 'onRecovery', 'onRecoveryFailure', 'onRecoveryFailure'],
    );

    for (const row of recoveryOutcomes) {
      const output = renderHubClientStatus(
        row.lifecycle === 'recovered' ? hubIdentity : null,
        row.lifecycle,
        row.lifecycle === 'recovered' ? stateFor('enabled') : null,
      );
      assert.ok(output, `${row.outcome} must render a status banner`);
      if (row.lifecycle === 'recovered') assert.match(output, /status \(recovered\)/, row.outcome);
      else assert.match(output, /state unavailable after recovery/, row.outcome);
    }
  });

  it('iterates all lifecycles and makes recovery visibly identify a hub change', () => {
    const rows = [
      ['attached', stateFor('enabled')],
      ['recovered', stateFor('refused', 'config-dirs-retired')],
      ['recovery-failed', null],
    ];

    const rendered = rows.map(([lifecycle, state]) =>
      renderHubClientStatus(hubIdentity, lifecycle, state));

    assert.equal(rendered.length, 3);
    assert.equal(new Set(rendered).size, 3, 'each lifecycle must render distinctly');
    assert.match(rendered[0], /status \(attached\)/);
    assert.match(rendered[1], /Hub changed;.*status \(recovered\)/);
    assert.match(rendered[2], /recovery-failed.*state unavailable after recovery/);
  });

  it('iterates all five exportState values reaching the render', () => {
    const states = [
      ['unconfigured', null],
      ['suppressed', 'explicitly-disabled'],
      ['suppressed', 'test-run'],
      ['refused', 'config-dirs-retired'],
      ['enabled', null],
    ];

    for (const [exportState, exportReason] of states) {
      const output = renderHubClientStatus(hubIdentity, 'attached', stateFor(exportState, exportReason));
      assert.ok(output, exportState + '/' + exportReason + ': output should exist');
      assert.match(output, new RegExp('exportState=' + exportState));
      if (exportReason) assert.match(output, new RegExp('exportReason=' + exportReason));
    }

    // unconfigured is an explicit hub report, so it is stated; only absent
    // export fields are silent under the wire-compatibility rule.
    assert.match(
      renderHubClientStatus(hubIdentity, 'attached', stateFor('unconfigured')),
      /exportState=unconfigured/,
    );
  });

  it('iterates full, old-hub, and null register reply shapes', () => {
    const replies = [
      {
        name: 'full payload',
        reply: { identity: hubIdentity, ...stateFor('refused', 'config-dirs-retired') },
        expected: /exportState=refused/,
      },
      {
        name: 'fields absent (old hub)',
        reply: { ok: true, firstClient: false },
        expected: null,
      },
      {
        name: 'null reply (rejection/tombstone)',
        reply: null,
        expected: null,
      },
    ];

    for (const row of replies) {
      const output = renderReply(row.reply);
      if (row.expected) assert.match(output, row.expected, row.name);
      else assert.equal(output, null, row.name + ': export status must be silent');
    }
  });

  it('does not fall back to a loud client environment when reply fields are absent', () => {
    const names = ['CCXRAY_EXPORT_CONFIG_DIRS', 'CCXRAY_IMPORT_HOMES'];
    const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
    process.env.CCXRAY_EXPORT_CONFIG_DIRS = '/loud-client-config';
    process.env.CCXRAY_IMPORT_HOMES = 'relative-client-root';
    try {
      const output = renderReply({ ok: true });
      assert.equal(output, null);
      assert.doesNotMatch(String(output), /export|config|import|relative-client-root/i);
    } finally {
      for (const name of names) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
    }
  });

  it('renders the hub identity from the reply and never the client identity', () => {
    const output = renderHubClientStatus(hubIdentity, 'attached', stateFor('refused', 'config-dirs-retired'));
    assert.match(output, /"kind":"hub"/);
    assert.match(output, /"pid":7123/);
    assert.match(output, /"home":"\/hub-owned-home"/);
    assert.match(output, /"logsDir":"\/hub-owned-logs"/);
    assert.doesNotMatch(output, /client-owned|9988/);
    assert.notEqual(hubIdentity, clientIdentity);
    assert.equal(
      renderHubClientStatus(clientIdentity, 'attached', stateFor(null)),
      null,
      'a client-shaped report has no exporter state to render',
    );
  });

  it('uses one shared render at attach and recovery, through the _origLog channel', () => {
    const clientMode = indexSource.slice(indexSource.indexOf('async function startClientMode'));
    const reportCalls = [...clientMode.matchAll(/reportHubRegistrationStatus\([^)]*\)/g)]
      .map(match => match[0]);

    assert.equal(reportCalls.length, 5, 'attach and every recovery outcome must use the same report helper');
    assert.ok(reportCalls.some(call => call.includes("'attached'")), 'attach call missing');
    assert.ok(reportCalls.some(call => call.includes("'recovered'")), 'recovery call missing');
    assert.ok(reportCalls.some(call => call.includes("'recovery-failed'")), 'recovery failure call missing');

    const helper = indexSource.slice(
      indexSource.indexOf('function reportHubRegistrationStatus'),
      indexSource.indexOf('async function startClientMode'),
    );
    assert.equal((helper.match(/renderHubClientStatus\(/g) || []).length, 1,
      'both lifecycle call sites must converge on one renderer');
    assert.match(helper, /if \(rendered\) _origLog\(rendered\)/,
      'render must use the unmuted _origLog channel');
    assert.doesNotMatch(clientMode, /configDirsRefusal|relativeRootComplaints|assembleExportReport/,
      'the client path must not inspect or assemble local exporter state');
  });

  it('renders unknown warning codes with their raw args instead of dropping them', () => {
    const output = renderHubClientStatus(hubIdentity, 'attached', stateFor('enabled', null, [{
      code: 'future-warning',
      args: { rawValue: 'keep-me', count: 2 },
    }]));
    assert.match(output, /future-warning: \{"rawValue":"keep-me","count":2\}/);
  });

  it('has recovery evidence that the register reply is consumed, not discarded', () => {
    const monitor = indexSource.slice(indexSource.indexOf('hub.startHubMonitor('));
    const body = monitor.slice(0, monitor.indexOf('\n  });'));
    assert.match(body, /registration = hub\.registerClient\(newLock/);
    assert.match(body, /const reg = await registration/,
      'recovery must await the reply before deciding what to render');
    assert.match(body, /reportHubRegistrationStatus\(reg, 'recovered'\)/,
      'recovery must render the returned reply');
    assert.match(body, /reportHubRegistrationStatus\(null, 'recovery-failed'\)/,
      'recovery rejection/null reply must render unavailability');
    assert.doesNotMatch(body, /registerClient\(newLock[\s\S]*?\.catch\(\(\) => \{\}\)/,
      'recovery must not discard the reply');
  });
});
