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
    // When session id is known but cwd missing on the wire, use process.cwd() of the launcher.
    cwdFallback: true,
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

  // Module on the OpenAI Responses wire family (see OPENAI_WIRE_CLIENTS).
  // Host routing is client-header based so a shared hub keeps Codex on
  // api.openai.com without OPENAI_BASE_URL swap.
  grok: Object.freeze({
    id: 'grok',
    label: 'Grok CLI',
    displayName: 'ccxray',
    // Wire parser family (path → openai.js). Host profile is UPSTREAMS.xai via OPENAI_WIRE_CLIENTS.
    upstream: 'openai',
    wire: 'openai',
    cwdFallback: true,
    installHint: '  curl -fsSL https://x.ai/cli/install.sh | bash',
    createLaunch({ port, args, env }) {
      const proxyBaseUrl = `http://localhost:${port}/v1`;
      return {
        bin: 'grok',
        args: [...args],
        env: { ...env, GROK_CLI_CHAT_PROXY_BASE_URL: proxyBaseUrl },
      };
    },
  }),
});

// Upstream wire family → default agent label when no OPENAI_WIRE_CLIENTS match.
const PROVIDER_AGENT = Object.freeze({ anthropic: 'claude', openai: 'codex' });
function agentForProvider(provider) { return PROVIDER_AGENT[provider] || 'claude'; }

/**
 * OpenAI-wire client modules: same Responses parser, different host / agent id /
 * raw-session bucket. Adding another CLI that speaks POST /v1/responses is:
 *   1) AGENT_PROVIDERS.<id> launcher
 *   2) one OPENAI_WIRE_CLIENTS entry (matchHeaders + upstreamKey + rawSessionId)
 * Do not fork wire-parsers/openai.js for each new agent.
 */
const OPENAI_WIRE_CLIENTS = Object.freeze([
  Object.freeze({
    id: 'grok',
    upstreamKey: 'xai',
    rawSessionId: 'grok-raw',
    modelPattern: /^grok/i,
    sessionHeaderNames: Object.freeze(['x-grok-session-id', 'x-grok-conv-id']),
    // Non-conversation /v1/* probes (settings, feedback, …) are noise for this client.
    controlPlaneIsNoise: true,
    matchHeaders(headers) {
      const h = headers || {};
      const first = (name) => {
        const v = h[name] ?? h[String(name).toLowerCase()];
        return Array.isArray(v) ? v[0] : v;
      };
      if (first('x-grok-client-identifier') || first('x-grok-client-version') || first('x-grok-model-override')) {
        return true;
      }
      return /grok-shell/i.test(String(first('user-agent') || ''));
    },
  }),
]);

function firstHeaderValue(headers, name) {
  if (!headers) return undefined;
  const v = headers[name] ?? headers[String(name).toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

function matchOpenAIWireClient(headers, model) {
  if (headers) {
    for (const client of OPENAI_WIRE_CLIENTS) {
      if (client.matchHeaders(headers)) return client;
    }
  }
  if (typeof model === 'string') {
    for (const client of OPENAI_WIRE_CLIENTS) {
      if (client.modelPattern && client.modelPattern.test(model)) return client;
    }
  }
  return null;
}

function getOpenAIWireClient(id) {
  return OPENAI_WIRE_CLIENTS.find(c => c.id === id) || null;
}

/** Agent label for an OpenAI-wire request (client module id or default codex). */
function resolveOpenAIWireAgent(headers, parsedBody) {
  const byMeta = parsedBody?.metadata?.client
    ? getOpenAIWireClient(parsedBody.metadata.client)
    : null;
  const client = matchOpenAIWireClient(headers, parsedBody?.model) || byMeta;
  return client?.id || agentForProvider('openai');
}

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
  // Same wire semantics as openai; used when OPENAI_WIRE_CLIENTS route to UPSTREAMS.xai.
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
    cwdFallback: Boolean(provider.cwdFallback),
    wire: provider.wire || null,
    ...launch,
  };
}

/** Whether the launched agent should fall back to process.cwd() for session cwd. */
function agentUsesCwdFallback(id) {
  return Boolean(getAgentProvider(id)?.cwdFallback);
}

/** Synthetic session buckets that never get a resume button (raw / orphan). */
function listRawSessionBuckets() {
  const buckets = new Set(['direct-api', 'codex-raw', 'unknown']);
  for (const c of OPENAI_WIRE_CLIENTS) {
    if (c.rawSessionId) buckets.add(c.rawSessionId);
  }
  return buckets;
}

/**
 * Contract checklist for a complete agent module (docs + tests use this shape).
 * @returns {{ id, hasLauncher, wire, openAIWireClient, upstreamKey }}
 */
function describeAgentModule(id) {
  const p = getAgentProvider(id);
  if (!p) return null;
  const client = getOpenAIWireClient(id);
  return {
    id: p.id,
    label: p.label,
    hasLauncher: typeof p.createLaunch === 'function',
    wire: p.wire || (p.upstream === 'anthropic' ? 'anthropic' : 'openai'),
    cwdFallback: Boolean(p.cwdFallback),
    openAIWireClient: Boolean(client),
    upstreamKey: client?.upstreamKey || p.upstream,
    rawSessionId: client?.rawSessionId || null,
  };
}

module.exports = {
  AGENT_PROVIDERS,
  OPENAI_WIRE_CLIENTS,
  PROVIDER_AGENT,
  UPSTREAM_PROFILES,
  agentForProvider,
  agentUsesCwdFallback,
  describeAgentModule,
  firstHeaderValue,
  getAgentLaunch,
  getAgentProvider,
  getDisplayName,
  getOpenAIWireClient,
  getUpstreamProfile,
  isAgentProvider,
  listAgentProviderIds,
  listRawSessionBuckets,
  matchOpenAIWireClient,
  normalizeUsageForProvider,
  resolveOpenAIWireAgent,
  supportedProviderList,
};
