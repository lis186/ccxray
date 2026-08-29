'use strict';

const { renderConfigWarning } = require('./importer');

const LIFECYCLES = new Set(['attached', 'recovered', 'recovery-failed']);

function reportedExportState(state) {
  return typeof state?.exportState === 'string' && state.exportState.length > 0;
}

function identityText(identity) {
  if (!identity || typeof identity !== 'object') return 'identity unavailable';
  // Keep home and logsDir together: they are one report's paired storage domain.
  return JSON.stringify({
    kind: identity.kind ?? null,
    pid: identity.pid ?? null,
    port: identity.port ?? null,
    home: identity.home ?? null,
    logsDir: identity.logsDir ?? null,
  });
}

function stateText(state) {
  const parts = ['exportState=' + state.exportState];
  if (state.exportReason) parts.push('exportReason=' + state.exportReason);
  if (Array.isArray(state.configWarnings) && state.configWarnings.length) {
    parts.push('configWarnings=' + state.configWarnings.map(renderConfigWarning).join(' | '));
  }
  return parts.join(' ');
}

// Returns a line for the foreground client, or null when the hub cannot report
// export state. The caller owns the output channel because console.log is muted
// in agent and hub mode; startClientMode sends returned lines through _origLog.
function renderHubClientStatus(identity, lifecycle, state) {
  if (!LIFECYCLES.has(lifecycle)) {
    throw new Error('Unknown hub-client status lifecycle: ' + lifecycle);
  }

  if (lifecycle === 'recovery-failed') {
    return '[ccxray] Hub export/config status (recovery-failed): state unavailable after recovery';
  }

  // An old hub, a 410 tombstone, and a rejected/null reply do not give the
  // client authority to inspect its own environment. Silence is intentional.
  if (!reportedExportState(state)) return null;

  const prefix = lifecycle === 'recovered'
    ? '[ccxray] Hub changed; export/config status (recovered)'
    : '[ccxray] Hub export/config status (attached)';
  return prefix + ': identity=' + identityText(identity) + ' — ' + stateText(state);
}

module.exports = { renderHubClientStatus };
