'use strict';

const { describe, it, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const hub = require('../server/hub');
const { resolveHttpSessionCwd } = require('../server/http-session-cwd');
const { getParser } = require('../server/wire-parsers');
const { buildIndexLine } = require('../server/entry');

const CLIENT_PID = 123;
const CLIENT_CWD = '/synthetic/project';

function indexedCwd(provider, { url = `/_ccxray/client/${CLIENT_PID}/v1/messages`, wireCwd = null } = {}) {
  const clientReq = { url, headers: {} };
  hub.applyClientRoute(clientReq);
  const parsedBody = provider === 'anthropic'
    ? { system: wireCwd ? `Primary working directory: ${wireCwd}` : '', messages: [] }
    : { input: [], ...(wireCwd ? { metadata: { cwd: wireCwd } } : {}) };
  const cwd = resolveHttpSessionCwd({
    parser: getParser(provider), parsedBody, provider, clientReq,
    getAgentCwdFallback: req => hub.lookupClientCwdForRequest(req) || '/synthetic/launcher',
  });
  return JSON.parse(buildIndexLine({ cwd })).cwd;
}

describe('HTTP session cwd attribution with a registered hub client', () => {
  before(() => hub.addClient(CLIENT_PID, CLIENT_CWD));
  after(() => {
    // Removing the last in-memory client schedules hub shutdown; discard that
    // timer without starting a hub or touching its lock/socket files.
    mock.timers.enable({ apis: ['setTimeout'] });
    hub.removeClient(CLIENT_PID);
    mock.timers.reset();
  });

  for (const [route, url] of [
    ['unrouted', '/v1/messages'],
    ['pane URL without PID', '/_ccxray/agent/herdr%3Atest%3Aclaude/v1/messages'],
    ['unknown PID', '/_ccxray/client/456/v1/messages'],
    ['unsafe PID', '/_ccxray/client/9007199254740992/v1/messages'],
  ]) {
    it(`Anthropic ${route}: leaves cwd unknown without a wire cwd`, () => {
      assert.equal(indexedCwd('anthropic', { url }), null);
    });
    it(`Anthropic ${route}: retains an explicit wire cwd`, () => {
      assert.equal(indexedCwd('anthropic', { url, wireCwd: '/synthetic/wire' }), '/synthetic/wire');
    });
  }

  for (const provider of ['anthropic', 'openai']) {
    it(`${provider}: uses the PID-routed client's cwd when the wire has none`, () => {
      assert.equal(indexedCwd(provider), CLIENT_CWD);
    });
    it(`${provider}: prefers the wire cwd over the registered cwd`, () => {
      assert.equal(indexedCwd(provider, { wireCwd: '/synthetic/wire' }), '/synthetic/wire');
    });
  }

  it('OpenAI: preserves the sole-client fallback for unrouted requests', () => {
    assert.equal(indexedCwd('openai', { url: '/v1/responses' }), CLIENT_CWD);
  });
  it('OpenAI: preserves the sole-client fallback for pane URL requests', () => {
    assert.equal(indexedCwd('openai', { url: '/_ccxray/agent/herdr%3Atest%3Acodex/v1/responses' }), CLIENT_CWD);
  });
  it('OpenAI: preserves the launcher fallback when no client matches', () => {
    assert.equal(indexedCwd('openai', { url: '/_ccxray/client/456/v1/responses' }), '/synthetic/launcher');
  });
});
