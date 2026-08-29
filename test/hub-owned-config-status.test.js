'use strict';

const { describe, it, before, after } = require('node:test');
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
  'LOGS_DIR',
];
const originalEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccxray-hub-owned-status-'));
fs.mkdirSync(path.join(testHome, 'logs'), { recursive: true });
fs.writeFileSync(path.join(testHome, 'logs', 'index.ndjson'), '');

process.env.CCXRAY_HOME = testHome;
process.env.CCXRAY_IMPORT_DISABLE = '1';

const exportSync = require('../server/export-sync');
const importer = require('../server/importer');
const hub = require('../server/hub');

hub.setOnShutdown(() => {});
hub.setHubPort(5577);
hub.setIdentityPort(5577);

function reportFields(value) {
  const protocolKeys = new Set([
    'app', 'port', 'pid', 'version', 'uptime', 'clients',
    'ok', 'firstClient',
  ]);
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !protocolKeys.has(key))
  );
}

function setEnv(env) {
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) process.env[key] = value;
  }
}

async function withEnv(env, fn) {
  const saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  setEnv(env);
  try {
    return await fn();
  } finally {
    setEnv(saved);
  }
}

async function socketCommand(command) {
  return hub.hubSocketRequest(hub.SOCK_PATH, command);
}

async function unregister(pid) {
  await socketCommand({ cmd: 'unregister', pid });
}

function clearClients() {
  for (const client of hub.getHubStatus().clients) hub.removeClient(client.pid);
}

let socketServer;

before(async () => {
  hub.setLaunchSignals({
    hubMode: true,
    explicitPort: true,
    agentNamed: false,
    platform: process.platform,
  });
  await hub.cleanupStaleSocket();
  socketServer = await hub.createHubSocket();
});

after(async () => {
  clearClients();
  if (socketServer) await new Promise(resolve => socketServer.close(resolve));
  hub.setHubPort(null);
  hub.setIdentityPort(null);
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(testHome, { recursive: true, force: true });
});

describe('hub-owned export/config status', () => {
  it('maps every launch mode to kind and paired identity paths by iterating modes, not kinds', async () => {
    const identityHome = suffix => path.join(testHome, `launch-${suffix}`);
    const externalLogsDir = path.join(os.tmpdir(), 'ccxray-hub-owned-status-external-logs');
    const identityPaths = (home, logsDir = path.join(home, 'logs')) => ({ home, logsDir });
    const ambientIdentity = {
      CCXRAY_HOME: identityHome('ambient'),
      LOGS_DIR: path.join(os.tmpdir(), 'ccxray-hub-owned-status-ambient-logs'),
    };
    const launchModes = [
      {
        name: 'ccxray claude (1st): the detached hub',
        signals: { hubMode: true, explicitPort: true, agentNamed: false, platform: 'darwin' },
        expected: 'hub',
        env: { CCXRAY_HOME: identityHome('hub') },
        expectedIdentity: identityPaths(identityHome('hub')),
      },
      {
        name: 'ccxray claude (1st): client after discovering a detached hub',
        signals: { hubMode: false, explicitPort: false, agentNamed: true, platform: 'darwin' },
        expected: 'client',
        env: { CCXRAY_HOME: identityHome('client-first'), LOGS_DIR: externalLogsDir },
        expectedIdentity: identityPaths(identityHome('client-first'), externalLogsDir),
        logsDirOutsideHome: true,
      },
      {
        name: 'ccxray claude (2nd): client after reusing an existing hub',
        signals: { hubMode: false, explicitPort: false, agentNamed: true, platform: 'darwin' },
        expected: 'client',
        env: { CCXRAY_HOME: identityHome('client-reuse') },
        expectedIdentity: identityPaths(identityHome('client-reuse')),
      },
      {
        name: 'ccxray standalone: no agent',
        signals: { hubMode: false, explicitPort: false, agentNamed: false, platform: 'darwin' },
        expected: 'standalone',
        env: { CCXRAY_HOME: identityHome('standalone') },
        expectedIdentity: identityPaths(identityHome('standalone')),
      },
      {
        name: 'ccxray --port N <agent>: independent agent server',
        signals: { hubMode: false, explicitPort: true, agentNamed: true, platform: 'darwin' },
        expected: 'agent-port',
        env: { CCXRAY_HOME: identityHome('agent-port') },
        expectedIdentity: identityPaths(identityHome('agent-port')),
      },
      {
        name: 'Windows ccxray <agent>: hub unavailable, standalone fallback',
        signals: { hubMode: false, explicitPort: false, agentNamed: true, platform: 'win32' },
        expected: 'standalone',
        env: { CCXRAY_HOME: identityHome('windows') },
        expectedIdentity: identityPaths(identityHome('windows')),
      },
    ];

    try {
      for (const mode of launchModes) {
        hub.setLaunchSignals(mode.signals);
        await withEnv(ambientIdentity, () => {
          const identity = hub.assembleExportReport(mode.env).identity;
          assert.equal(identity.kind, mode.expected, mode.name);
          assert.deepEqual(
            { home: identity.home, logsDir: identity.logsDir },
            mode.expectedIdentity,
            `${mode.name}: home/logsDir must come from the reporting env`,
          );
          if (mode.logsDirOutsideHome) {
            assert.notEqual(identity.logsDir, path.join(identity.home, 'logs'),
              `${mode.name}: explicit LOGS_DIR must not fall back to <home>/logs`);
          }
        });
      }
    } finally {
      hub.setLaunchSignals({
        hubMode: true,
        explicitPort: true,
        agentNamed: false,
        platform: process.platform,
      });
    }

    const clientSignals = {
      hubMode: false,
      explicitPort: false,
      agentNamed: true,
      platform: 'darwin',
    };
    assert.notEqual(hub.kindFromLaunchSignals(clientSignals), 'hub',
      'the client signal set must never yield hub');
    assert.equal(hub.kindFromLaunchSignals(clientSignals), 'client');

  });

  it('does not borrow the hub lock port for a non-hub identity', () => {
    const lockPort = 59999;
    const ownPort = 45555;
    fs.writeFileSync(hub.HUB_LOCK_PATH, JSON.stringify({ port: lockPort }));
    hub.setLaunchSignals({
      hubMode: false,
      explicitPort: true,
      agentNamed: true,
      platform: 'darwin',
    });
    hub.setHubPort(null);
    hub.setIdentityPort(ownPort);

    try {
      const report = hub.assembleExportReport({ CCXRAY_HOME: testHome });
      assert.equal(report.identity.kind, 'agent-port');
      assert.equal(report.identity.port, ownPort);
      assert.notEqual(report.identity.port, lockPort,
        'a non-hub identity must not name the hub lockfile port');
    } finally {
      fs.rmSync(hub.HUB_LOCK_PATH, { force: true });
      hub.setHubPort(5577);
      hub.setIdentityPort(5577);
      hub.setLaunchSignals({
        hubMode: true,
        explicitPort: true,
        agentNamed: false,
        platform: process.platform,
      });
    }
  });

  it('does not report client-environment exporter facts through either carrier', async () => {
    const pid = 31050;
    hub.setLaunchSignals({
      hubMode: false,
      explicitPort: false,
      agentNamed: true,
      platform: 'darwin',
    });

    await withEnv({
      CCXRAY_HOME: testHome,
      CCXRAY_EXPORT_CONFIG_DIRS: '/retired-config-dir',
      CCXRAY_IMPORT_HOMES: 'relative-root',
      CCXRAY_EXPORT_GCS_BUCKET: 'status-test-bucket',
    }, async () => {
      const assembled = hub.assembleExportReport();
      const statusPayload = reportFields(hub.getHubStatus());
      const registration = await socketCommand({ cmd: 'register', pid, cwd: '/status-test' });
      const replyPayload = reportFields(registration);

      assert.deepEqual(assembled, {
        exportState: null,
        exportReason: null,
        configWarnings: [],
        identity: {
          kind: 'client',
          pid: process.pid,
          port: null,
          home: testHome,
          logsDir: path.join(testHome, 'logs'),
        },
      });
      assert.deepEqual(statusPayload, assembled, 'getHubStatus uses the shared client payload');
      assert.deepEqual(replyPayload, assembled, 'register uses the shared client payload');
      assert.equal('cursor' in registration, false, 'client reply has no cursor facts');

      await unregister(pid);
    });

    hub.setLaunchSignals({
      hubMode: true,
      explicitPort: true,
      agentNamed: false,
      platform: process.platform,
    });
  });

  it('carries every exportState/exportReason value unchanged through both carriers', async () => {
    exportSync._setUploader(null);
    const states = [
      {
        name: 'unconfigured',
        env: { CCXRAY_HOME: testHome },
        expected: { exportState: 'unconfigured', exportReason: null },
      },
      {
        name: 'suppressed explicitly-disabled',
        env: { CCXRAY_HOME: testHome, CCXRAY_EXPORT_DISABLE: '1' },
        expected: { exportState: 'suppressed', exportReason: 'explicitly-disabled' },
      },
      {
        name: 'suppressed test-run',
        env: { CCXRAY_HOME: testHome, NODE_TEST_CONTEXT: '1' },
        expected: { exportState: 'suppressed', exportReason: 'test-run' },
      },
      {
        name: 'refused config-dirs-retired',
        env: {
          CCXRAY_HOME: testHome,
          CCXRAY_EXPORT_CONFIG_DIRS: '',
          CCXRAY_EXPORT_GCS_BUCKET: 'status-test-bucket',
        },
        expected: { exportState: 'refused', exportReason: 'config-dirs-retired' },
      },
      {
        name: 'enabled',
        env: { CCXRAY_HOME: testHome, CCXRAY_EXPORT_GCS_BUCKET: 'status-test-bucket' },
        expected: { exportState: 'enabled', exportReason: null },
      },
    ];

    let pid = 31000;
    for (const state of states) {
      await withEnv(state.env, async () => {
        const assembled = hub.assembleExportReport();
        const statusPayload = reportFields(hub.getHubStatus());
        const registration = await socketCommand({ cmd: 'register', pid, cwd: '/status-test' });
        const replyPayload = reportFields(registration);

        assert.equal(assembled.exportState, state.expected.exportState, `${state.name}: assembler state`);
        assert.equal(assembled.exportReason, state.expected.exportReason, `${state.name}: assembler reason`);
        assert.deepEqual(statusPayload, assembled, `${state.name}: getHubStatus uses assembler payload`);
        assert.deepEqual(replyPayload, assembled, `${state.name}: register uses assembler payload`);
        assert.deepEqual(replyPayload, statusPayload, `${state.name}: carriers agree`);
        assert.equal('cursor' in registration, false, `${state.name}: no cursor facts in register reply`);
        assert.equal('readExportCursorFacts' in registration, false,
          `${state.name}: no cursor producer in register reply`);

        await unregister(pid);
      });
      pid++;
    }
  });

  it('round-trips coded warning args over the socket and preserves unknown codes', async () => {
    const pid = 31100;
    await withEnv({
      CCXRAY_HOME: testHome,
      CCXRAY_IMPORT_HOMES: 'relative-root, /absolute-root',
    }, async () => {
      const reply = await socketCommand({ cmd: 'register', pid, cwd: '/status-test' });
      const roundTripped = JSON.parse(JSON.stringify(reply));
      assert.deepEqual(roundTripped.configWarnings, [{
        code: 'relative-import-root',
        args: { variable: 'CCXRAY_IMPORT_HOMES', values: ['relative-root'] },
      }]);
      assert.deepEqual(roundTripped.configWarnings[0].args.values, ['relative-root']);
      await unregister(pid);
    });

    const unknown = { code: 'future-warning', args: { rawValue: 'keep-me', count: 2 } };
    const unknownRoundTripped = JSON.parse(JSON.stringify({ configWarnings: [unknown] }));
    assert.deepEqual(unknownRoundTripped.configWarnings, [unknown]);
    assert.equal(importer.renderConfigWarning(unknownRoundTripped.configWarnings[0]),
      'future-warning: {"rawValue":"keep-me","count":2}');
  });

  it('keeps register validation and the client identity whitelist unchanged', async () => {
    const pid = 31200;
    await withEnv({ CCXRAY_HOME: testHome }, async () => {
      const reply = await socketCommand({
        cmd: 'register',
        pid,
        cwd: '/status-test',
        exportState: 'client-controlled',
        configWarnings: [{ code: 'client-controlled', args: { bad: true } }],
        agentId: 'agent-1',
      });
      assert.equal(reply.ok, true);
      assert.equal(reply.exportState, 'unconfigured');
      const client = hub.getHubStatus().clients.find(item => item.pid === pid);
      assert.deepEqual(client, {
        pid,
        cwd: '/status-test',
        connectedAt: client.connectedAt,
        agentId: 'agent-1',
      });
      await unregister(pid);
    });
  });
});
