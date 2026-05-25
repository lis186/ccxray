'use strict';

// Provider launchers are centralized here so startup and hub recovery stay
// provider-agnostic. Each CLI has its own routing contract for pointing at the
// ccxray proxy, so new launchers should be additive registry entries instead
// of new command-specific branches in server/index.js.

function getUpstreamToken() {
  try {
    const auth = require('./auth');
    const secrets = auth.deriveSecrets(auth.getRootSecret());
    return secrets.K_upstream.toString('base64url');
  } catch (e) {
    console.warn(`[ccxray] Could not derive X-Ccxray-Auth token: ${e.message}`);
    return null;
  }
}

const AGENT_PROVIDERS = Object.freeze({
  claude: Object.freeze({
    id: 'claude',
    label: 'Claude Code',
    displayName: 'ccxray',
    upstream: 'anthropic',
    installHint: '  npm install -g @anthropic-ai/claude-code',
    createLaunch({ port, args, env }) {
      const launchEnv = { ...env, ANTHROPIC_BASE_URL: `http://localhost:${port}` };
      const token = getUpstreamToken();
      if (token) {
        const authHeader = `X-Ccxray-Auth: ${token}`;
        const existing = launchEnv.ANTHROPIC_CUSTOM_HEADERS;
        launchEnv.ANTHROPIC_CUSTOM_HEADERS = existing
          ? `${existing}, ${authHeader}`
          : authHeader;
      }
      return { bin: 'claude', args: [...args], env: launchEnv };
    },
  }),

  codex: Object.freeze({
    id: 'codex',
    label: 'Codex CLI',
    displayName: 'ccxray',
    upstream: 'openai',
    installHint: '  npm install -g @openai/codex',
    createLaunch({ port, args, env }) {
      const proxyBaseUrl = `http://localhost:${port}/v1`;
      const hasApiKey = Boolean(env.OPENAI_API_KEY);

      if (hasApiKey) {
        const token = getUpstreamToken();
        if (token) {
          const mpConfig = `model_providers.ccxray={name="ccxray", base_url="${proxyBaseUrl}", wire_api="responses", http_headers={"X-Ccxray-Auth"="${token}"}}`;
          return {
            bin: 'codex',
            args: ['-c', mpConfig, '-c', 'model_provider="ccxray"', ...args],
            env: { ...env },
          };
        }
        // Token derivation failed — fall through to legacy path with warning
        // (warning already emitted by getUpstreamToken)
      }

      // ChatGPT-OAuth mode or token derivation failure: legacy path
      return {
        bin: 'codex',
        args: [
          '-c',
          `openai_base_url="${proxyBaseUrl}"`,
          '-c',
          `chatgpt_base_url="${proxyBaseUrl}"`,
          ...args,
        ],
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
