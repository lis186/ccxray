// Shared agentKey-based main/subagent classification (L1 rule).
// Isomorphic: loaded as a browser script tag (globals) AND require()'d by server.
//
// INVARIANT: every agentKey-based main/subagent classification site must use
// these shared constants — see docs/decisions/0005-agent-key-unreliable-shared-contract.md
// ADR 0005 site table: workflow-timeline.js, entry-rendering.js, session-index.js (#381),
// store.js isAnthropicSubagent (#725)

// Agent keys whose turns belong to the main lane — model switches within the
// main conversation stay in main (the dashed model-switch line marks them)
var WF_MAIN_AGENT_KEYS = { 'orchestrator': 1, 'sdk-agent': 1, 'default': 1 };

// Agent keys that are POSITIVE subagent / side-request evidence: the non-main
// KNOWN_AGENTS keys (server/system-prompt.js) plus the OpenAI-wire title key.
// test/main-turn-without-context-management.test.js fails if a KNOWN_AGENTS key is in neither
// this table nor WF_MAIN_AGENT_KEYS.
var KNOWN_SUBAGENT_KEYS = {
  'explorer': 1, 'worker': 1, 'general-purpose': 1, 'explore': 1, 'web-search': 1,
  'title-generator': 1, 'name-generator': 1, 'plan': 1, 'codex-rescue': 1,
  'claude-code-guide': 1, 'summarizer': 1, 'translator': 1, 'title': 1,
};

// agentKey values that don't reliably mean "not main" — both are catch-all
// defaults from extractAgentType()'s regex fallback for unrecognized prompts
// (server/system-prompt.js), which could be a genuinely new main-agent
// variant, not necessarily a subagent (codex review round 3).
var AGENT_KEY_UNRELIABLE = { unknown: 1, agent: 1 };

// Is this agentKey a classification by itself? Only a main key or a known
// subagent key is. Every other key — 'unknown'/'agent' and any slug the
// regex fallback derives from an unfamiliar "You are …" opening — says
// nothing about main vs subagent, so callers fall back to the raw
// isSubagent flag (store.js isAnthropicSubagent, which reads structure).
// #725: Claude Code 2.1.304's main prompt lands in that fallback as a long
// role slug; listing slugs as main keys would break on the next rewording.
function isAgentKeyReliable(key) {
  return !!key && !AGENT_KEY_UNRELIABLE[key] && !!(WF_MAIN_AGENT_KEYS[key] || KNOWN_SUBAGENT_KEYS[key]);
}

// L1 classification: is this entry a main turn by agentKey?
// Returns true if the entry should be treated as main, false if subagent.
// When agentKey is not reliable (see isAgentKeyReliable), falls back to the raw isSubagent flag.
// This is the first layer of the client's 5-layer classification pipeline
// (L1 agentKey → L2 coreHash → L3 overlap → L4 seq → L5 display).
function isMainTurnByAgentKey(entry) {
  if (isAgentKeyReliable(entry.agentKey)) {
    return !!WF_MAIN_AGENT_KEYS[entry.agentKey];
  }
  // Unreliable, unfamiliar or missing agentKey: fall back to the raw flag
  return !(entry.isSubagent || false);
}

if (typeof module !== 'undefined') {
  module.exports = { WF_MAIN_AGENT_KEYS, KNOWN_SUBAGENT_KEYS, AGENT_KEY_UNRELIABLE, isAgentKeyReliable, isMainTurnByAgentKey };
}
