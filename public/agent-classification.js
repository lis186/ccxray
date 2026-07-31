// Shared agentKey-based main/subagent classification (L1 rule).
// Isomorphic: loaded as a browser script tag (globals) AND require()'d by server.
//
// INVARIANT: every agentKey-based main/subagent classification site must use
// these shared constants — see docs/decisions/0005-agent-key-unreliable-shared-contract.md
// ADR 0005 site table: workflow-timeline.js, entry-rendering.js, session-index.js (#381)

// Agent keys whose turns belong to the main lane — model switches within the
// main conversation stay in main (the dashed model-switch line marks them)
var WF_MAIN_AGENT_KEYS = { 'orchestrator': 1, 'sdk-agent': 1, 'default': 1 };

// agentKey values that don't reliably mean "not main" — both are catch-all
// defaults from extractAgentType()'s regex fallback for unrecognized prompts
// (server/system-prompt.js), which could be a genuinely new main-agent
// variant, not necessarily a subagent (codex review round 3).
var AGENT_KEY_UNRELIABLE = { unknown: 1, agent: 1 };

// L1 classification: is this entry a main turn by agentKey?
// Returns true if the entry should be treated as main, false if subagent.
// When agentKey is unreliable (unknown/agent), falls back to raw isSubagent flag.
// This is the first layer of the client's 5-layer classification pipeline
// (L1 agentKey → L2 coreHash → L3 overlap → L4 seq → L5 display).
function isMainTurnByAgentKey(entry) {
  if (entry.agentKey && !AGENT_KEY_UNRELIABLE[entry.agentKey]) {
    return !!WF_MAIN_AGENT_KEYS[entry.agentKey];
  }
  // Unreliable or missing agentKey: fall back to the raw flag
  return !(entry.isSubagent || false);
}

if (typeof module !== 'undefined') module.exports = { WF_MAIN_AGENT_KEYS, AGENT_KEY_UNRELIABLE, isMainTurnByAgentKey };
