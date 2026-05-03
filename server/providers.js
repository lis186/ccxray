'use strict';

// Provider launchers are centralized here so startup and hub recovery stay
// provider-agnostic. Each CLI has its own routing contract for pointing at the
// ccxray proxy, so new launchers should be additive registry entries instead
// of new command-specific branches in server/index.js.

const AGENT_PROVIDERS = Object.freeze({
  claude: Object.freeze({
    id: 'claude',
    label: 'Claude Code',
    displayName: 'ccxray',
    upstream: 'anthropic',
    installHint: '  npm install -g @anthropic-ai/claude-code',
    createLaunch({ port, args, env }) {
      return {
        bin: 'claude',
        args: [...args],
        env: { ...env, ANTHROPIC_BASE_URL: `http://localhost:${port}` },
      };
    },
  }),

  codex: Object.freeze({
    id: 'codex',
    label: 'Codex CLI',
    displayName: 'ccxray',
    upstream: 'openai',
    installHint: '  npm install -g @openai/codex',
    createLaunch({ port, args, env }) {
      return {
        bin: 'codex',
        args: ['-c', `openai_base_url="http://localhost:${port}/v1"`, ...args],
        env: { ...env },
      };
    },
  }),
});

function listAgentProviderIds() {
  return Object.keys(AGENT_PROVIDERS);
}

function getAgentProvider(id) {
  return AGENT_PROVIDERS[id] || null;
}

function isAgentProvider(id) {
  return Boolean(getAgentProvider(id));
}

function supportedProviderList() {
  return listAgentProviderIds().join(', ');
}

function getDisplayName(id, env = process.env) {
  if (env.CCXRAY_DISPLAY_NAME) return env.CCXRAY_DISPLAY_NAME;
  return getAgentProvider(id)?.displayName || 'ccxray';
}

function getAgentLaunch(id, port, args = [], env = process.env) {
  const provider = getAgentProvider(id);
  if (!provider) return null;
  const launch = provider.createLaunch({ port, args, env });
  return {
    provider: provider.id,
    label: provider.label,
    displayName: provider.displayName,
    upstream: provider.upstream,
    installHint: provider.installHint,
    ...launch,
  };
}

module.exports = {
  AGENT_PROVIDERS,
  getAgentLaunch,
  getAgentProvider,
  getDisplayName,
  isAgentProvider,
  listAgentProviderIds,
  supportedProviderList,
};
