'use strict';

const crypto = require('crypto');
const { safeCountTokens } = require('./helpers');

// Dedup key: md5(b2) prefix. Logged B2 prompts rarely change; Set growth is bounded in practice.
const UNKNOWN_AGENT_SEEN = new Set();

function logUnknownAgent(b2, key) {
  // Maintainer-only debug print: surfaces unknown agent B2 shapes so they can
  // be added to KNOWN_AGENTS. In hub mode this goes to ~/.ccxray/hub.log (the
  // detached child's stdio); in standalone agent mode (`ccxray codex` with
  // --port) ccxray's stderr is `stdio: 'inherit'`-ed by the spawned agent's
  // terminal, so a default-on warn pollutes the agent UI. Gate it.
  if (process.env.CCXRAY_DEBUG_CLASSIFY !== '1') return;
  const hash = crypto.createHash('md5').update(b2 || '').digest('hex').slice(0, 12);
  if (UNKNOWN_AGENT_SEEN.has(hash)) return;
  UNKNOWN_AGENT_SEEN.add(hash);
  const preview = (b2 || '').slice(0, 120).replace(/\s+/g, ' ').trim();
  console.warn(`\x1b[33m[classify] new agent bucket key="${key}" — register in KNOWN_AGENTS? B2=${JSON.stringify(preview)}\x1b[0m`);
}

// ── System prompt diff helpers ───────────────────────────────────────

const B2_MARKER_DEFS = [
  { key: 'customSkills',   pattern: /# User'?s Current Configuration/ },
  { key: 'customAgents',   pattern: /\*\*Available custom agents/ },
  { key: 'mcpServersList', pattern: /\*\*Configured MCP servers/ },
  { key: 'pluginSkills',   pattern: /\*\*Available plugin skills/ },
  { key: 'settingsJson',   pattern: /\*\*User's settings\.json/ },
  { key: 'envAndGit',      pattern: /# Environment\n|<env>/ },
  { key: 'autoMemory',     pattern: /# auto memory\n|You have a persistent, file-based memory/ },
];

const BLOCK_OWNERS_SERVER = {
  billingHeader: 'anthropic', coreIdentity: 'anthropic', coreInstructions: 'anthropic',
  customSkills: 'user', pluginSkills: 'user', mcpServersList: 'user', settingsJson: 'user', envAndGit: 'user',
  customAgents: 'user', autoMemory: 'user',
};

// Known agent types by b2 prefix. Order matters — first match wins.
const KNOWN_AGENTS = [
  { prefix: 'You are Codex',                            key: 'default',           label: 'Codex Default' },
  { prefix: 'You are an explorer agent',                key: 'explorer',          label: 'Codex Explorer' },
  { prefix: 'You are an agent that explores',           key: 'explorer',          label: 'Codex Explorer' },
  { prefix: 'You are a worker agent',                   key: 'worker',            label: 'Codex Worker' },
  { prefix: 'You are an execution agent',               key: 'worker',            label: 'Codex Worker' },
  { prefix: 'You are an interactive agent',                key: 'orchestrator',      label: 'Orchestrator' },
  { prefix: 'You are an agent for Claude Code',            key: 'general-purpose',   label: 'General Purpose' },
  { prefix: 'You are a file search specialist',            key: 'explore',           label: 'Explore' },
  { prefix: 'You are an assistant for performing a web',   key: 'web-search',        label: 'Web Search' },
  { prefix: 'Generate a concise',                          key: 'title-generator',   label: 'Title Generator' },
  { prefix: 'Generate a short kebab-case name',            key: 'name-generator',    label: 'Name Generator' },
  { prefix: 'You are a software architect and planning',   key: 'plan',              label: 'Plan' },
  { prefix: 'You are a thin forwarding wrapper around the Codex', key: 'codex-rescue', label: 'Codex Rescue' },
  { prefix: 'You are the Claude guide agent',              key: 'claude-code-guide', label: 'Claude Code Guide' },
  { prefix: 'You are a helpful AI assistant tasked with summarizing', key: 'summarizer', label: 'Summarizer' },
  { prefix: 'You are a translator',                        key: 'translator',        label: 'Translator' },
];

function extractAgentType(sys) {
  if (!Array.isArray(sys) || sys.length < 2) return { key: 'unknown', label: 'Unknown' };
  const b1 = (sys[1]?.text || '').trim();
  const b2 = (sys[2]?.text || '').trim();

  // Match against known agent types by b2 prefix
  for (const a of KNOWN_AGENTS) {
    if (b2.startsWith(a.prefix)) return { key: a.key, label: a.label };
  }

  // Short-form prompt (no B2): trust B1 identity only when B2 is absent.
  // Current Claude Code keeps B1 = "You are Claude Code…" branding for every
  // sub-agent, so B1 is NOT a reliable signal when B2 has content.
  if (!b2) {
    if (b1.startsWith('You are Claude Code')) return { key: 'orchestrator', label: 'Orchestrator' };
    if (b1.startsWith('You are a Claude agent, built on Anthropic')) return { key: 'sdk-agent', label: 'SDK Agent' };
  }

  // Regex fallback for unknown future agent types
  const m = b2.match(/^You are (?:a |an |the )?(.+?)(?:\s+for\s|\s+that\s|\s+specializ|\s*[,.]|\n)/i);
  if (m) {
    const role = m[1].trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 30);
    const label = m[1].trim().replace(/\b\w/g, c => c.toUpperCase());
    const key = role || 'agent';
    logUnknownAgent(b2, key);
    return { key, label: label || 'Agent' };
  }
  logUnknownAgent(b2, 'agent');
  return { key: 'agent', label: 'Agent' };
}

function extractPromptAgentType(provider, req) {
  if (provider === 'openai') {
    const explicit = req?.metadata?.agent_type || req?.metadata?.agentType || req?.metadata?.agent;
    if (explicit === 'explorer') return { key: 'explorer', label: 'Codex Explorer' };
    if (explicit === 'worker') return { key: 'worker', label: 'Codex Worker' };
    if (explicit === 'default') return { key: 'default', label: 'Codex Default' };

    const instructions = typeof req?.instructions === 'string' ? req.instructions : JSON.stringify(req?.instructions || '');
    if (/explorer/i.test(instructions)) return { key: 'explorer', label: 'Codex Explorer' };
    if (/worker|execution agent/i.test(instructions)) return { key: 'worker', label: 'Codex Worker' };

    const hasCodexPrompt =
      req?.instructions != null ||
      req?.input != null ||
      (Array.isArray(req?.tools) && req.tools.length > 0);
    return hasCodexPrompt
      ? { key: 'default', label: 'Codex Default' }
      : { key: 'unknown', label: 'Unknown' };
  }
  return extractAgentType(req?.system);
}

function splitB2IntoBlocks(b2) {
  const positions = [];
  for (const m of B2_MARKER_DEFS) {
    const match = m.pattern.exec(b2);
    if (match) positions.push({ key: m.key, index: match.index });
  }
  positions.sort((a, b) => a.index - b.index);
  const result = {};
  const firstPos = positions.length > 0 ? positions[0].index : b2.length;
  result['coreInstructions'] = b2.slice(0, firstPos);
  for (let i = 0; i < positions.length; i++) {
    const start = positions[i].index;
    const end = i + 1 < positions.length ? positions[i + 1].index : b2.length;
    result[positions[i].key] = b2.slice(start, end);
  }
  return result;
}

// ── coreHash: platform-normalized version identity ───────────────────
// Claude Code's coreInstructions carry platform-specific tokens (the shell
// name — Bash on macOS/Linux vs PowerShell on Windows — plus os identifiers
// and home paths). Hashing the raw text splits one semantic prompt version
// into per-OS duplicates (#219). Normalize those tokens to placeholders
// *before* hashing so the same cc_version yields one coreHash across
// platforms. The stored/displayed coreInstructions text stays un-normalized —
// only the hash sees placeholders, so the content and diff views still show
// the real platform-specific words.
function normalizePlatform(text) {
  return (text || '')
    .replace(/\b(Bash|PowerShell|cmd\.exe)\b/g, '{{SHELL}}')
    .replace(/\b(darwin|win32|linux)\b/g, '{{PLATFORM}}')
    .replace(/[A-Za-z]:\\[\w.\\-]+/g, '{{PATH}}')  // Windows paths (C:\Users\foo)
    .replace(/\/(?:Users|home)\/[\w.-]+/g, '{{PATH}}');  // macOS/Linux home paths
}

// Single source of truth for the Anthropic coreHash. Every anthropic call site
// (wire-parsers/anthropic.js live path, restore.js buildVersionIndex,
// rebuild-index.js) MUST go through this so the versionIndex key
// `agentKey::coreHash` cannot diverge across paths — an inlined
// md5(coreText) at any one site would silently re-split platform variants.
function computeCoreHash(coreText) {
  return crypto.createHash('md5').update(normalizePlatform(coreText)).digest('hex').slice(0, 12);
}

function computeBlockDiff(b2A, b2B) {
  const blocksA = splitB2IntoBlocks(b2A);
  const blocksB = splitB2IntoBlocks(b2B);
  const ALL_BLOCKS = ['coreInstructions', 'customSkills', 'customAgents', 'mcpServersList', 'pluginSkills', 'settingsJson', 'envAndGit', 'autoMemory'];
  return ALL_BLOCKS.map(block => {
    const textA = blocksA[block] || '';
    const textB = blocksB[block] || '';
    const aTokens = safeCountTokens(textA);
    const bTokens = safeCountTokens(textB);
    const delta = bTokens - aTokens;
    const owner = BLOCK_OWNERS_SERVER[block] || 'anthropic';
    const status = textA === textB ? 'same' : 'changed';
    const blockDiff = status === 'changed' ? computeUnifiedDiff(textA, textB, block, block) : '';
    return { block, tokA: aTokens, tokB: bTokens, aTokens, bTokens, delta, status, owner, textB, blockDiff };
  });
}

function computeUnifiedDiff(textA, textB, labelA, labelB) {
  const linesA = textA.split('\n');
  const linesB = textB.split('\n');
  const result = [`--- ${labelA}`, `+++ ${labelB}`];
  const changes = [];
  let i = 0, j = 0;
  while (i < linesA.length || j < linesB.length) {
    if (i < linesA.length && j < linesB.length && linesA[i] === linesB[j]) {
      changes.push({ type: ' ', line: linesA[i] }); i++; j++;
    } else if (j < linesB.length && (i >= linesA.length || linesA[i] !== linesB[j])) {
      let matchAhead = -1;
      for (let k = 1; k <= 5 && i + k < linesA.length; k++) {
        if (linesA[i + k] === linesB[j]) { matchAhead = k; break; }
      }
      if (matchAhead === -1) {
        changes.push({ type: '+', line: linesB[j] }); j++;
      } else {
        for (let k = 0; k < matchAhead; k++) { changes.push({ type: '-', line: linesA[i] }); i++; }
      }
    } else {
      changes.push({ type: '-', line: linesA[i] }); i++;
    }
  }
  const CONTEXT = 3;
  const hunkStarts = [];
  for (let ci = 0; ci < changes.length; ci++) {
    if (changes[ci].type !== ' ') hunkStarts.push(ci);
  }
  const hunkRanges = [];
  let ri = 0;
  while (ri < hunkStarts.length) {
    const start = Math.max(0, hunkStarts[ri] - CONTEXT);
    let end = Math.min(changes.length - 1, hunkStarts[ri] + CONTEXT);
    while (ri + 1 < hunkStarts.length && hunkStarts[ri + 1] <= end + CONTEXT) {
      ri++;
      end = Math.min(changes.length - 1, hunkStarts[ri] + CONTEXT);
    }
    hunkRanges.push([start, end]);
    ri++;
  }
  let aLine = 1, bLine = 1, ci2 = 0;
  for (const [hStart, hEnd] of hunkRanges) {
    while (ci2 < hStart) {
      if (changes[ci2].type !== '+') aLine++;
      if (changes[ci2].type !== '-') bLine++;
      ci2++;
    }
    const hunkA = aLine, hunkB = bLine;
    let aCount = 0, bCount = 0;
    const hunkLines = [];
    for (let ci3 = hStart; ci3 <= hEnd; ci3++) {
      const c = changes[ci3];
      hunkLines.push(c.type + c.line);
      if (c.type !== '+') aCount++;
      if (c.type !== '-') bCount++;
    }
    result.push(`@@ -${hunkA},${aCount} +${hunkB},${bCount} @@`);
    for (const l of hunkLines) result.push(l);
    for (let ci3 = hStart; ci3 <= hEnd; ci3++) {
      if (changes[ci3].type !== '+') aLine++;
      if (changes[ci3].type !== '-') bLine++;
    }
    ci2 = hEnd + 1;
  }
  return result.join('\n');
}

module.exports = {
  B2_MARKER_DEFS,
  BLOCK_OWNERS_SERVER,
  extractAgentType,
  extractPromptAgentType,
  splitB2IntoBlocks,
  normalizePlatform,
  computeCoreHash,
  computeBlockDiff,
  computeUnifiedDiff,
  _resetUnknownAgentSeen: () => UNKNOWN_AGENT_SEEN.clear(),
};
