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

  // Grok CLI (xAI): OpenAI Responses wire → cli-chat-proxy.grok.com by default.
  // Upstream host selection is header-based (x-grok-*) so a shared hub can serve
  // Claude/Codex/Grok without flipping OPENAI_BASE_URL. See docs/grok-wire-experiment-2026-07-09.md.
  grok: Object.freeze({
    id: 'grok',
    label: 'Grok CLI',
    displayName: 'ccxray',
    upstream: 'openai',
    installHint: '  curl -fsSL https://x.ai/cli/install.sh | bash',
    createLaunch({ port, args, env }) {
      const proxyBaseUrl = `http://localhost:${port}/v1`;
      const launchEnv = {
        ...env,
        GROK_CLI_CHAT_PROXY_BASE_URL: proxyBaseUrl,
      };
      // When X-Ccxray-Auth is required (non-loopback), Grok can send extra headers
      // via custom model config — but the stock cli path has no env-header hook
      // equivalent to ANTHROPIC_CUSTOM_HEADERS. Loopback is trusted by default.
      return { bin: 'grok', args: [...args], env: launchEnv };
    },
  }),
});

// Upstream wire family → default agent label. Grok also speaks the openai wire
// family but is distinguished at entry-build time via client headers / model id.
const PROVIDER_AGENT = Object.freeze({ anthropic: 'claude', openai: 'codex' });
function agentForProvider(provider) { return PROVIDER_AGENT[provider] || 'claude'; }

// Upstream wire-protocol profiles. Agent launchers describe "how to start";
// upstream profiles describe "how the wire format differs".
const UPSTREAM_PROFILES = Object.freeze({
  anthropic: Object.freeze({
    cache: 'ephemeral-ttl',
    inputIncludesCached: false,
    label: 'Anthropic',
    brandColor: '#e8956a',
    resume: Object.freeze({ template: '{agent} --resume {sid}', condition: 'always' }),
  }),
  openai: Object.freeze({
    cache: 'server-managed',
    inputIncludesCached: true,
    label: 'OpenAI',
    brandColor: '#74aa9c',
    // Codex only writes a rollout file (resumable session) after a successful
    // API turn — sessions with only startup errors can't be resumed.
    resume: Object.freeze({ template: 'codex resume {sid}', condition: 'has-usage' }),
  }),
  // Same wire semantics as openai (Responses + cache in input_tokens); distinct
  // brand + resume for Grok-labeled sessions.
  xai: Object.freeze({
    cache: 'server-managed',
    inputIncludesCached: true,
    label: 'xAI',
    brandColor: '#a78bfa',
    resume: Object.freeze({ template: 'grok --resume {sid}', condition: 'has-usage' }),
  }),
});

function getUpstreamProfile(upstream) {
  return UPSTREAM_PROFILES[upstream] || null;
}

// Normalize usage so canonical fields have the same semantics across providers.
// After normalization: input_tokens + cache_creation + cache_read = total context.
// _ccxrayUsageNormalized flag prevents double-subtraction on re-processing.
function normalizeUsageForProvider(provider, usage) {
  if (!usage || usage._ccxrayUsageNormalized) return usage;
  const profile = getUpstreamProfile(provider);
  if (!profile?.inputIncludesCached) return usage;
  const cached = usage.input_tokens_details?.cached_tokens
              || usage.cache_read_input_tokens || 0;
  if (cached <= 0) return usage;
  return {
    ...usage,
    input_tokens: Math.max(0, (usage.input_tokens || 0) - cached),
    cache_read_input_tokens: usage.cache_read_input_tokens ?? cached,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    _ccxrayUsageNormalized: true,
  };
}

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
  PROVIDER_AGENT,
  UPSTREAM_PROFILES,
  agentForProvider,
  getAgentLaunch,
  getAgentProvider,
  getDisplayName,
  getUpstreamProfile,
  isAgentProvider,
  listAgentProviderIds,
  normalizeUsageForProvider,
  supportedProviderList,
};
