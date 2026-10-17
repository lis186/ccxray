'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

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

// #671: a user-level `chatgpt_base_url` pointing at a loopback proxy (the
// older way to route Codex through ccxray) still breaks ChatGPT workspace
// discovery, and a `-c` override cannot safely undo it: enterprise configs set
// it legitimately. Detect and warn only — this never writes the file.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1']);

function codexConfigPath(env) {
  if (env.CODEX_HOME) return path.join(env.CODEX_HOME, 'config.toml');
  const home = env.HOME || env.USERPROFILE;
  return home ? path.join(home, '.codex', 'config.toml') : null;
}

function findLoopbackCodexChatgptBaseUrl(env = process.env) {
  const file = codexConfigPath(env);
  if (!file) return null;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const re = /^[ \t]*chatgpt_base_url[ \t]*=[ \t]*(?:"([^"]*)"|'([^']*)')/gm;
  let m;
  while ((m = re.exec(text))) {
    const value = m[1] ?? m[2];
    let host;
    try { host = new URL(value).hostname.toLowerCase(); } catch { continue; }
    if (LOOPBACK_HOSTS.has(host) || /^127\./.test(host)) return value;
  }
  return null;
}

let warnedLoopbackChatgptBaseUrl = false;
function warnLoopbackCodexChatgptBaseUrl(env) {
  if (warnedLoopbackChatgptBaseUrl) return;
  const url = findLoopbackCodexChatgptBaseUrl(env);
  if (!url) return;
  warnedLoopbackChatgptBaseUrl = true;
  console.warn(`[ccxray] chatgpt_base_url in ${codexConfigPath(env)} points at a loopback proxy (${url}); `
    + 'Codex ChatGPT workspace discovery will fail (#671). Remove it — ccxray no longer needs it.');
}

function proxyBaseUrl(port, env, suffix = '') {
  const clientPid = String(env.CCXRAY_HUB_CLIENT_PID || '');
  const clientRoute = /^[1-9]\d*$/.test(clientPid)
    ? `/_ccxray/client/${clientPid}`
    : '';
  return `http://localhost:${port}${clientRoute}${suffix}`;
}

// Keep root option arity aligned with `codex --help`. Infinity means a
// detached option consumes following non-option tokens; Codex's `--image`
// does this even when a value looks like a subcommand. `terminal` options
// take over parsing before a later subcommand can run.
const CODEX_ROOT_OPTION_ARITY = Object.freeze({
  '-c': 1,
  '--config': 1,
  '--enable': 1,
  '--disable': 1,
  '--remote': 1,
  '--remote-auth-token-env': 1,
  '-i': Infinity,
  '--image': Infinity,
  '-m': 1,
  '--model': 1,
  '--oss': 0,
  '--local-provider': 1,
  '-p': 1,
  '--profile': 1,
  '-s': 1,
  '--sandbox': 1,
  '--approve-for-me': 0,
  '--dangerously-bypass-approvals-and-sandbox': 0,
  '--dangerously-bypass-hook-trust': 0,
  '-C': 1,
  '--cd': 1,
  '--worktree': 0,
  '--add-dir': 1,
  '-a': 1,
  '--ask-for-approval': 1,
  '--search': 0,
  '--no-alt-screen': 0,
  '--no-daemon': 0,
  '--strict-config': 0,
  '-h': 'terminal',
  '--help': 'terminal',
  '-V': 'terminal',
  '--version': 'terminal',
});
const CODEX_MODEL_SUBCOMMANDS = new Set(['exec', 'e', 'review', 'resume', 'fork']);
// Needed to distinguish a root prompt from a different root command after
// Codex allows a prompt positional before a command (for example, `app exec`).
// Keep synchronized with the root Commands section in `codex --help`.
const CODEX_SUBCOMMANDS = new Set([
  ...CODEX_MODEL_SUBCOMMANDS,
  'agents', 'login', 'logout', 'mcp', 'plugin', 'app-server', 'remote-control',
  'app', 'completion', 'update', 'doctor', 'sandbox', 'debug', 'apply', 'a',
  'help', 'queue', 'archive', 'delete', 'migrate-rollouts', 'unarchive', 'cloud',
  'exec-server', 'features',
]);

function getCodexRootOption(arg) {
  if (Object.hasOwn(CODEX_ROOT_OPTION_ARITY, arg)) {
    return { arity: CODEX_ROOT_OPTION_ARITY[arg], attachedValue: false };
  }

  for (const [option, arity] of Object.entries(CODEX_ROOT_OPTION_ARITY)) {
    if (typeof arity !== 'number' || arity === 0) continue;
    const prefix = option.startsWith('--') ? `${option}=` : option;
    if (arg.startsWith(prefix) && arg.length > prefix.length) {
      return { arity, attachedValue: true };
    }
  }
  return null;
}

function findCodexModelSubcommand(args) {
  let sawRootPrompt = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') return -1;
    if (!arg.startsWith('-') || arg === '-') {
      if (CODEX_MODEL_SUBCOMMANDS.has(arg)) return i;
      // Codex permits its one root PROMPT positional before a subcommand.
      // A different known root command takes ownership of the remaining args.
      if (CODEX_SUBCOMMANDS.has(arg) || sawRootPrompt) return -1;
      sawRootPrompt = true;
      continue;
    }

    const option = getCodexRootOption(arg);
    if (!option) return -1;
    if (option.arity === 'terminal') return -1;
    if (option.arity === 0 || option.attachedValue) continue;

    if (option.arity === Infinity) {
      if (i + 1 >= args.length) return -1;
      i++;
      while (i + 1 < args.length && (!args[i + 1].startsWith('-') || args[i + 1] === '-')) i++;
      continue;
    }

    if (i + 1 >= args.length) return -1;
    i++;
  }
  return -1;
}

function withCodexConfig(configArgs, args) {
  const commandIndex = findCodexModelSubcommand(args);
  if (commandIndex < 0) return [...configArgs, ...args];
  return [
    ...args.slice(0, commandIndex + 1),
    ...configArgs,
    ...args.slice(commandIndex + 1),
  ];
}

function appendAnthropicCustomHeader(launchEnv, header) {
  const existing = launchEnv.ANTHROPIC_CUSTOM_HEADERS;
  launchEnv.ANTHROPIC_CUSTOM_HEADERS = existing
    ? `${existing}\n${header}`
    : header;
}

/**
 * @param {string[]} args Arguments passed after the `claude` command.
 * @returns {boolean} Whether Claude was launched in its non-interactive print mode.
 *
 * Claude Code --help identifies -p/--print as the mode switches; options such
 * as --input-format and --output-format only modify print mode. A bare `--`
 * ends option parsing, so later values are prompt text rather than flags.
 */
function isClaudePrintMode(args) {
  for (const arg of Array.isArray(args) ? args : []) {
    if (arg === '--') break;
    if (arg === '-p' || arg === '--print') return true;
  }
  return false;
}

// This synchronous read is deliberately confined to launcher construction:
// the launched account is a session-start snapshot, never a proxy hot-path read.
// Invariant: account snapshot resolves exactly the way the launched process
// resolves its config: every input is from launch env, never the parent.
// os.homedir() is only the no-HOME fallback, matching the child's passwd entry.
function getClaudeLaunchAccountEmail(env, { readFile = file => fs.readFileSync(file, 'utf8') } = {}) {
  const accountConfig = env.CLAUDE_CONFIG_DIR
    ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json')
    : path.join(env.HOME || os.homedir(), '.claude.json');
  try {
    const config = JSON.parse(readFile(accountConfig));
    return typeof config.oauthAccount?.emailAddress === 'string'
      ? config.oauthAccount.emailAddress
      : null;
  } catch {
    return null;
  }
}

const AGENT_PROVIDERS = Object.freeze({
  claude: Object.freeze({
    id: 'claude',
    label: 'Claude Code',
    npmPackage: '@anthropic-ai/claude-code',
    displayName: 'ccxray',
    upstream: 'anthropic',
    installHint: '  npm install -g @anthropic-ai/claude-code',
    createLaunch({ port, args, env }) {
      const launchEnv = { ...env, ANTHROPIC_BASE_URL: proxyBaseUrl(port, env) };
      // This secret belongs to the ccxray install, not the launched session.
      const token = getUpstreamToken();
      if (token) {
        appendAnthropicCustomHeader(launchEnv, `X-Ccxray-Auth: ${token}`);
      }
      const accountEmail = getClaudeLaunchAccountEmail(env);
      if (accountEmail) appendAnthropicCustomHeader(launchEnv, `X-Ccxray-Account: ${accountEmail}`);
      if (isClaudePrintMode(args)) appendAnthropicCustomHeader(launchEnv, 'X-Ccxray-Print-Mode: true');
      return { bin: 'claude', args: [...args], env: launchEnv };
    },
  }),

  codex: Object.freeze({
    id: 'codex',
    label: 'Codex CLI',
    npmPackage: '@openai/codex',
    displayName: 'ccxray',
    // Capitalized agent name for prose titles (e.g. "Codex WebSocket session").
    // Not displayName (process title "ccxray") or label ("Codex CLI").
    wireDisplayName: 'Codex',
    upstream: 'openai',
    // When session id is known but cwd missing on the wire, use process.cwd() of the launcher.
    cwdFallback: true,
    installHint: '  npm install -g @openai/codex',
    createLaunch({ port, args, env }) {
      const baseUrl = proxyBaseUrl(port, env, '/v1');
      const hasApiKey = Boolean(env.OPENAI_API_KEY);

      if (hasApiKey) {
        const token = getUpstreamToken();
        if (token) {
          const mpConfig = `model_providers.ccxray={name="ccxray", base_url="${baseUrl}", wire_api="responses", http_headers={"X-Ccxray-Auth"="${token}"}}`;
          return {
            bin: 'codex',
            args: withCodexConfig(['-c', mpConfig, '-c', 'model_provider="ccxray"'], args),
            env: { ...env },
          };
        }
        // Token derivation failed — fall through to legacy path with warning
        // (warning already emitted by getUpstreamToken)
      }

      // ChatGPT-OAuth mode or token derivation failure: built-in `openai`
      // provider pointed at the proxy. Only openai_base_url is overridden.
      //
      // #671: chatgpt_base_url must stay at Codex's default
      // (https://chatgpt.com/backend-api/). Codex runs ChatGPT workspace
      // discovery against it at bootstrap and rejects a plaintext loopback URL
      // (-32603 "workspace routing discovery failed"); account/backend calls
      // therefore go to chatgpt.com directly, while model traffic still comes
      // here (config.js routes `chatgpt-account-id` requests to the ChatGPT
      // upstream).
      //
      // INVARIANT: baseUrl must NOT end in `/backend-api/codex`. Codex applies
      // the discovered workspace origin to the openai provider only when its
      // base_url is unset or ends there (`supports_codex_backend_routes()`);
      // the `/v1` suffix keeps that gate closed, so model traffic can never be
      // re-routed past the proxy. See docs/codex-workspace-routing.md.
      warnLoopbackCodexChatgptBaseUrl(env);
      return {
        bin: 'codex',
        args: withCodexConfig(['-c', `openai_base_url="${baseUrl}"`], args),
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
    wireDisplayName: 'Grok',
    // Wire parser family (path → openai.js). Host profile is UPSTREAMS.xai via OPENAI_WIRE_CLIENTS.
    upstream: 'openai',
    wire: 'openai',
    cwdFallback: true,
    installHint: '  curl -fsSL https://x.ai/cli/install.sh | bash',
    createLaunch({ port, args, env }) {
      const baseUrl = proxyBaseUrl(port, env, '/v1');
      return {
        bin: 'grok',
        args: [...args],
        env: { ...env, GROK_CLI_CHAT_PROXY_BASE_URL: baseUrl },
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
    // Title-gen often finishes several seconds after the main turn starts streaming.
    // TRANSITIONAL (#313): this window exists only because attributeTitleGen is a
    // point-in-time lookup against transient state and needs a recency bound. A
    // read-time join on the content anchor — the ADR 0012 argument applied to
    // attribution instead of dedup — needs no window, and this field disappears
    // with it. Do not tune it; replacing the mechanism is the fix.
    titleGenWindowMs: 60_000,
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

// Codex is the default OpenAI-wire provider module, so it is not in the
// alternate-upstream registry above. Keep a matcher record for parser context:
// only explicit Codex markers qualify; otherwise an unknown third-party client
// must remain unknown rather than silently inheriting Codex decoders.
const CODEX_WIRE_CLIENT = Object.freeze({
  id: 'codex',
  rawSessionId: 'codex-raw',
  matchHeaders(headers) {
    const turnMetadata = firstHeaderValue(headers, 'x-codex-turn-metadata');
    const userAgent = firstHeaderValue(headers, 'user-agent');
    return Boolean(turnMetadata) || /(?:^|\s)codex(?:_cli_rs)?\//i.test(String(userAgent || ''));
  },
});

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
    if (CODEX_WIRE_CLIENT.matchHeaders(headers)) return CODEX_WIRE_CLIENT;
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

/**
 * Capitalized agent name for user-facing prose (WS titles, etc.).
 * Falls back to 'Codex' for the openai wire family when the agent is unknown.
 * Do not use displayName (process title) or label ("… CLI").
 */
function displayNameForAgent(agent) {
  const p = getAgentProvider(agent);
  if (p?.wireDisplayName) return p.wireDisplayName;
  return 'Codex';
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
  displayNameForAgent,
  firstHeaderValue,
  getClaudeLaunchAccountEmail,
  getAgentLaunch,
  findLoopbackCodexChatgptBaseUrl,
  getAgentProvider,
  getDisplayName,
  getOpenAIWireClient,
  getUpstreamProfile,
  isClaudePrintMode,
  isAgentProvider,
  listAgentProviderIds,
  listRawSessionBuckets,
  matchOpenAIWireClient,
  normalizeUsageForProvider,
  resolveOpenAIWireAgent,
  supportedProviderList,
};
