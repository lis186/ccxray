'use strict';

const { countTokens } = require('@anthropic-ai/tokenizer');
const { isInjectedText } = require('../shared/injected-tags');

// ── Helpers ─────────────────────────────────────────────────────────
function timestamp() {
  const d = new Date();
  const parts = d.toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).replace(' ', 'T');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return (parts + '-' + ms).replace(/[:.]/g, '-');
}

function taipeiTime() {
  return new Date().toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
}

function printSeparator() {
  console.log('\x1b[33m' + '═'.repeat(60) + '\x1b[0m');
}

function safeCountTokens(text) {
  if (!text) return 0;
  try { return countTokens(text); } catch { return 0; }
}

// ── Context Breakdown Analysis ───────────────────────────────────────
const TOOL_CATEGORIES = {
  core:  ['Bash','Read','Write','Edit','Glob','Grep','WebFetch','WebSearch','NotebookEdit','ToolSearch'],
  agent: ['Agent','Skill','TaskOutput','TaskStop','AskUserQuestion','EnterPlanMode','ExitPlanMode'],
  task:  ['TaskCreate','TaskGet','TaskUpdate','TaskList'],
  team:  ['EnterWorktree','TeamCreate','TeamDelete','SendMessage'],
  cron:  ['CronCreate','CronDelete','CronList'],
};

function parseSystemBlocks(system) {
  const result = {
    billingHeader: 0, coreIdentity: 0, coreInstructions: 0,
    customSkills: 0, customAgents: 0, pluginSkills: 0,
    mcpServersList: 0, settingsJson: 0, envAndGit: 0, autoMemory: 0,
  };
  if (!system || !Array.isArray(system)) return result;

  if (system[0]) result.billingHeader = safeCountTokens(system[0].text || '');
  if (system[1]) result.coreIdentity = safeCountTokens(system[1].text || '');

  const mainText = system.slice(2).map(b => b.text || '').join('\n');
  if (!mainText) return result;

  const markerDefs = [
    { key: 'autoMemory',     pattern: /# auto memory\n|You have a persistent, file-based memory/ },
    { key: 'customSkills',   pattern: /# User'?s Current Configuration/ },
    { key: 'customAgents',   pattern: /\*\*Available custom agents/ },
    { key: 'mcpServersList', pattern: /\*\*Configured MCP servers/ },
    { key: 'pluginSkills',   pattern: /\*\*Available plugin skills/ },
    { key: 'settingsJson',   pattern: /\*\*User's settings\.json/ },
    { key: 'envAndGit',      pattern: /# Environment\n|<env>/ },
  ];
  const positions = [];
  for (const m of markerDefs) {
    const match = m.pattern.exec(mainText);
    if (match) positions.push({ key: m.key, index: match.index });
  }
  positions.sort((a, b) => a.index - b.index);

  const firstPos = positions.length > 0 ? positions[0].index : mainText.length;
  result.coreInstructions = safeCountTokens(mainText.slice(0, firstPos));
  for (let i = 0; i < positions.length; i++) {
    const start = positions[i].index;
    const end = i + 1 < positions.length ? positions[i + 1].index : mainText.length;
    result[positions[i].key] = safeCountTokens(mainText.slice(start, end));
  }
  return result;
}

function parseClaudeMdFromMessages(messages) {
  const result = { globalClaudeMd: 0, projectClaudeMd: 0 };
  if (!messages || !messages.length) return result;

  const firstUser = messages.find(m => m.role === 'user');
  if (!firstUser) return result;
  const text = typeof firstUser.content === 'string' ? firstUser.content : JSON.stringify(firstUser.content);

  const re = /Contents of ([^\n]+CLAUDE\.md)[^\n]*:\n([\s\S]*?)(?=Contents of [^\n]+CLAUDE\.md|$)/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    const filePath = match[1];
    const content = match[2];
    if (filePath.includes('/.claude/CLAUDE.md') || /~\/\.claude/.test(filePath)) {
      result.globalClaudeMd += safeCountTokens(content);
    } else {
      result.projectClaudeMd += safeCountTokens(content);
    }
  }
  return result;
}

function categorizeTools(tools) {
  if (!tools || !tools.length) return { byCategory: {}, mcpPlugins: [], counts: {} };

  const byCategory = { core: [], agent: [], task: [], team: [], cron: [], mcp: [], other: [] };
  const mcpPluginsMap = {};

  for (const tool of tools) {
    const name = tool.name || '';
    if (name.startsWith('mcp__')) {
      byCategory.mcp.push(tool);
      const plugin = name.split('__')[1] || 'unknown';
      if (!mcpPluginsMap[plugin]) mcpPluginsMap[plugin] = [];
      mcpPluginsMap[plugin].push(tool);
    } else {
      let placed = false;
      for (const [cat, names] of Object.entries(TOOL_CATEGORIES)) {
        if (names.includes(name)) { byCategory[cat].push(tool); placed = true; break; }
      }
      if (!placed) byCategory.other.push(tool);
    }
  }

  const mcpPlugins = Object.entries(mcpPluginsMap).map(([plugin, pluginTools]) => ({
    plugin, count: pluginTools.length,
    tokens: safeCountTokens(JSON.stringify(pluginTools)),
  }));
  const counts = Object.fromEntries(Object.entries(byCategory).map(([k, v]) => [k, v.length]));
  return { byCategory, mcpPlugins, counts };
}

function parseSkillsFromMessages(messages) {
  if (!messages) return [];
  // Skills are injected via system-reminder in user messages:
  // "The following skills are available for use with the Skill tool:\n- name: desc\n..."
  for (const m of messages) {
    if (m.role !== 'user') continue;
    const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content || '' }];
    for (const block of blocks) {
      const txt = block.type === 'text' ? (block.text || '') : '';
      const idx = txt.indexOf('The following skills are available for use with the Skill tool:');
      if (idx < 0) continue;
      const section = txt.slice(idx);
      const end = section.indexOf('</system-reminder>');
      const body = end >= 0 ? section.slice(0, end) : section;
      const seen = new Set();
      for (const line of body.split('\n')) {
        // Support both "- skill-name: description" and "- skill-name" (no description)
        // Skill names may contain ":" (e.g. "sourceatlas:flow"), so split on ": " (colon-space)
        const m2 = line.match(/^- (.+?)(?:: .+)?$/);
        if (m2) { const n = m2[1].trim(); if (n) seen.add(n); }
      }
      if (seen.size > 0) return [...seen];
    }
  }
  return [];
}

function analyzeContext(body) {
  if (!body) return null;
  const systemBreakdown = parseSystemBlocks(body.system);
  const claudeMd = parseClaudeMdFromMessages(body.messages);
  const loadedSkills = parseSkillsFromMessages(body.messages);
  const toolsCat = categorizeTools(body.tools);
  const toolTokens = {};
  for (const [cat, arr] of Object.entries(toolsCat.byCategory)) {
    toolTokens[cat] = arr.length > 0 ? safeCountTokens(JSON.stringify(arr)) : 0;
  }
  let messageTokens = 0;
  if (body.messages) {
    for (const m of body.messages) {
      if (typeof m.content === 'string') {
        messageTokens += safeCountTokens(m.content);
      } else if (Array.isArray(m.content)) {
        for (const block of m.content) {
          if (block.type === 'text') messageTokens += safeCountTokens(block.text || '');
          else if (block.type === 'tool_use') messageTokens += safeCountTokens(JSON.stringify(block.input || {}));
          else if (block.type === 'tool_result') {
            const c = block.content;
            if (typeof c === 'string') messageTokens += safeCountTokens(c);
            else if (Array.isArray(c)) messageTokens += c.reduce((s, b) => s + safeCountTokens(b.text || ''), 0);
          }
        }
      }
    }
  }
  return {
    systemBreakdown, claudeMd, messageTokens, loadedSkills,
    toolsBreakdown: { mcpPlugins: toolsCat.mcpPlugins, counts: toolsCat.counts, toolTokens },
  };
}

function tokenizeRequest(body) {
  if (!body) return null;
  const breakdown = {};
  if (body.system) {
    const text = typeof body.system === 'string' ? body.system : JSON.stringify(body.system);
    breakdown.system = safeCountTokens(text);
  }
  if (body.tools && body.tools.length) {
    breakdown.tools = safeCountTokens(JSON.stringify(body.tools));
  }
  if (body.messages && body.messages.length) {
    let total = 0;
    breakdown.perMessage = body.messages.map(m => {
      let tokens = 0;
      const blocks = [];
      if (typeof m.content === 'string') {
        const t = safeCountTokens(m.content);
        tokens = t;
        if (t > 0) blocks.push({ type: 'text', tokens: t });
      } else if (Array.isArray(m.content)) {
        for (const block of m.content) {
          if (block.type === 'text') {
            const t = safeCountTokens(block.text || '');
            tokens += t;
            if (t > 0) blocks.push({ type: 'text', tokens: t });
          } else if (block.type === 'thinking') {
            const t = safeCountTokens(block.thinking || '');
            tokens += t;
            if (t > 0) blocks.push({ type: 'thinking', tokens: t });
          } else if (block.type === 'tool_use') {
            const t = safeCountTokens(JSON.stringify(block.input || {}));
            tokens += t;
            if (t > 0) blocks.push({ type: 'tool_use', name: block.name || null, tokens: t });
          } else if (block.type === 'tool_result') {
            const c = block.content;
            let t = 0;
            if (typeof c === 'string') t = safeCountTokens(c);
            else if (Array.isArray(c)) t = c.reduce((s, b) => s + safeCountTokens(b.text || ''), 0);
            tokens += t;
            if (t > 0) blocks.push({ type: 'tool_result', name: block.name || null, tokens: t });
          }
        }
      }
      total += tokens;
      return { role: m.role, tokens, blocks };
    });
    breakdown.messages = total;
  }
  breakdown.total = (breakdown.system || 0) + (breakdown.tools || 0) + (breakdown.messages || 0);
  breakdown.contextBreakdown = analyzeContext(body);
  return breakdown;
}

function extractUsage(resData) {
  if (!Array.isArray(resData)) return null;
  const msgStart = resData.find(e => e.type === 'message_start');
  const msgDelta = resData.find(e => e.type === 'message_delta');
  const u = msgStart?.message?.usage || {};
  const result = {
    input_tokens: u.input_tokens || 0,
    output_tokens: msgDelta?.usage?.output_tokens || u.output_tokens || 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
    cache_read_input_tokens: u.cache_read_input_tokens || 0,
  };
  // Preserve nested cache_creation ephemeral TTL split — plan-detector uses
  // ephemeral_5m_input_tokens vs ephemeral_1h_input_tokens to infer Pro vs Max.
  if (u.cache_creation && typeof u.cache_creation === 'object') {
    result.cache_creation = {
      ephemeral_5m_input_tokens: u.cache_creation.ephemeral_5m_input_tokens || 0,
      ephemeral_1h_input_tokens: u.cache_creation.ephemeral_1h_input_tokens || 0,
    };
  }
  return result;
}

// Pure: { turn, step } from a Claude API messages[] array.
// turn = count of human-text user openers (role:user with at least one text
//        block whose text is not an injected tag like <system-reminder>).
// step = count of role:user messages from the last human-text opener
//        inclusive to the end of the array (i.e. how many user messages
//        belong to the current logical turn so far, including this one).
function computeTurnStep(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return { turn: 0, step: 0 };
  let turn = 0;
  let lastOpenerIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || m.role !== 'user') continue;
    const blocks = Array.isArray(m.content)
      ? m.content
      : [{ type: 'text', text: typeof m.content === 'string' ? m.content : '' }];
    const isOpener = blocks.some(b =>
      b && b.type === 'text' && typeof b.text === 'string' && b.text.length > 0 && !isInjectedText(b.text)
    );
    if (isOpener) { turn++; lastOpenerIdx = i; }
  }
  if (lastOpenerIdx < 0) return { turn: 0, step: 0 };
  let step = 0;
  for (let i = lastOpenerIdx; i < messages.length; i++) {
    if (messages[i] && messages[i].role === 'user') step++;
  }
  return { turn, step };
}

function projectBasename(cwd) {
  if (!cwd || typeof cwd !== 'string') return '?';
  if (cwd.startsWith('(')) return cwd; // already a label like '(quota-check)'
  const parts = cwd.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '?';
}

// Builds the attribution prefix shown on REQUEST and RESPONSE log lines.
// ctx fields:
//   sessionId, cwd, sessNum, turn, step, sessionInferred, isQuotaCheck, isOrphan, reqId
function renderAttributionPrefix(ctx) {
  if (!ctx) return '[?]';
  if (ctx.isQuotaCheck) return '[quota-check]';
  if (ctx.isOrphan) {
    const id = (ctx.reqId || '').slice(0, 12) || '?';
    return `[orphan/${id}]`;
  }
  const sid = ctx.sessionId || '?';
  const sidLabel = sid === 'direct-api' ? 'direct-api' : sid.slice(0, 8);
  const tilde = ctx.sessionInferred ? '~' : '';
  const proj = projectBasename(ctx.cwd);
  const sessNum = (ctx.sessNum != null && ctx.sessNum !== '') ? `#${ctx.sessNum} ` : '';
  const turn = (ctx.turn != null && ctx.turn > 0) ? `R${ctx.turn}.${ctx.step || 1}` : 'R?.?';
  return `[${proj}/${sidLabel}${tilde} · ${sessNum}${turn}]`;
}

function summarizeRequest(body) {
  if (!body) return '';
  const model = body.model || '?';
  const sysTokens = body.system
    ? safeCountTokens(typeof body.system === 'string' ? body.system : JSON.stringify(body.system))
    : 0;
  const msgCount = body.messages?.length || 0;
  const parts = [model];
  if (sysTokens > 0) parts.push(`sys ${sysTokens.toLocaleString()}`);
  parts.push(`msgs ${msgCount}`);
  return '   ' + parts.join(' · ');
}

function totalContextTokens(usage) {
  if (!usage) return 0;
  return (usage.input_tokens || 0)
    + (usage.cache_creation_input_tokens || 0)
    + (usage.cache_read_input_tokens || 0);
}

function printContextBar(usage, model, system) {
  const { getMaxContext } = require('./config');
  if (!usage) return;
  const maxCtx = getMaxContext(model, system);
  const used = totalContextTokens(usage);
  if (!used) return;
  const pct = Math.min(100, (used / maxCtx) * 100);
  const barWidth = 40;
  const filled = Math.round(barWidth * pct / 100);
  const empty = barWidth - filled;
  const color = pct > 90 ? '\x1b[31m' : pct > 70 ? '\x1b[33m' : '\x1b[32m';
  const bar = color + '█'.repeat(filled) + '\x1b[90m' + '░'.repeat(empty) + '\x1b[0m';
  console.log(`  Context ${bar} ${pct.toFixed(0)}% (${used.toLocaleString()} / ${maxCtx.toLocaleString()})`);
  const parts = [];
  if (usage.cache_read_input_tokens) parts.push(`cache:${usage.cache_read_input_tokens.toLocaleString()}↩`);
  if (usage.cache_creation_input_tokens) parts.push(`${usage.cache_creation_input_tokens.toLocaleString()}↗`);
  if (parts.length) console.log(`  ${parts.join('  ')}`);
}

function computeThinkingDuration(events) {
  let start = null, end = null;
  for (const ev of events) {
    if (!ev._ts) continue;
    if (ev.type === 'content_block_start' && ev.content_block?.type === 'thinking') start = ev._ts;
    else if (ev.type === 'content_block_stop' && start && !end) end = ev._ts;
  }
  return (start && end) ? (end - start) / 1000 : null;
}

function parseSSEEvents(raw) {
  const events = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('data: ')) {
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;
      try { events.push(JSON.parse(data)); } catch {}
    }
  }
  return events;
}

// ── Turn title extraction ─────────────────────────────────────────
const TITLE_MAX_LEN = 200;
const TITLE_JSON_REGEX = /"title"\s*:\s*"((?:[^"\\]|\\.)*?)(?:"|$)/;

// Concatenate text from either a parsed SSE-event array, a response body
// with content blocks, or a raw string. Returns '' if nothing found.
function collectResponseText(res) {
  if (!res) return '';
  if (Array.isArray(res)) {
    let out = '';
    for (const ev of res) {
      if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        out += ev.delta.text;
      }
    }
    return out;
  }
  if (typeof res === 'string') return res;
  if (Array.isArray(res.content)) {
    return res.content.filter(b => b?.type === 'text').map(b => b.text).join('');
  }
  return '';
}

function extractResponseTitle(res) {
  const text = collectResponseText(res).trim().replace(/\s+/g, ' ');
  if (!text) return null;
  const firstSentence = text.split(/[.\n]/)[0].trim();
  return (firstSentence || text).slice(0, 80) || null;
}

// Claude Code's title-generator subagent wraps its output as {"title": "..."}.
// Parse defensively: JSON first, regex second, nothing else.
function extractTitleGenPayload(res) {
  if (process.env.CCXRAY_DISABLE_TITLES === '1') return null;
  const text = collectResponseText(res).trim();
  if (!text) return null;

  if (text[0] === '{') {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed.title === 'string') {
        const t = parsed.title.trim();
        return t ? t.slice(0, TITLE_MAX_LEN) : null;
      }
    } catch { /* fall through to regex for truncated / malformed streams */ }
  }

  const m = text.match(TITLE_JSON_REGEX);
  if (m && m[1]) {
    const unescaped = m[1]
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
      .replace(/\\n/g, ' ')
      .trim();
    return unescaped ? unescaped.slice(0, TITLE_MAX_LEN) : null;
  }
  return null;
}

// Extract pure text from a message's content blocks (ignores tool_result, tool_use, etc.)
function collectTextFromContent(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter(b => b && b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join(' ')
    .trim();
}

// Fallback #2: last user message had pure text (user-initiated turn with no response text)
function extractLastUserText(req) {
  const messages = req?.messages;
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== 'user') continue;
    const text = collectTextFromContent(m.content);
    if (text) {
      const firstSentence = text.split(/[.\n]/)[0].trim();
      return (firstSentence || text).replace(/\s+/g, ' ') || null;
    }
    return null; // last user msg exists but has no text (tool_results only)
  }
  return null;
}

// Fallback #3: last user message is all tool_results → summarize completed tool names
// Maps tool_use_id → name using preceding assistant message, dedupes, preserves order, caps at 5.
function extractToolResultSummary(req) {
  const messages = req?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const last = messages[messages.length - 1];
  if (last?.role !== 'user' || !Array.isArray(last.content)) return null;
  const ids = [];
  for (const b of last.content) {
    if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string') ids.push(b.tool_use_id);
  }
  if (!ids.length) return null;
  // Build id → name from all preceding assistant messages
  const idToName = {};
  for (let i = 0; i < messages.length - 1; i++) {
    const m = messages[i];
    if (m?.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b?.type === 'tool_use' && b.id && b.name) idToName[b.id] = b.name;
    }
  }
  const names = [];
  const seen = new Set();
  for (const id of ids) {
    const name = idToName[id];
    if (!name) continue;
    const shortName = name.replace(/^mcp__[^_]+__/, '');
    if (seen.has(shortName)) continue;
    seen.add(shortName);
    names.push(shortName);
  }
  if (!names.length) return null;
  const head = names.slice(0, 5).join(' · ');
  const overflow = names.length > 5 ? ` +${names.length - 5}` : '';
  return '↩ ' + head + overflow;
}

// Fallback #4 (subagent): first user message text — the task the subagent was given
function extractFirstUserText(req) {
  const messages = req?.messages;
  if (!Array.isArray(messages)) return null;
  for (const m of messages) {
    if (m?.role !== 'user') continue;
    const text = collectTextFromContent(m.content);
    if (text) {
      const firstSentence = text.split(/[.\n]/)[0].trim();
      return (firstSentence || text).replace(/\s+/g, ' ') || null;
    }
  }
  return null;
}

// Scan request for any tool_result with is_error: true
function hasToolFail(req) {
  const messages = req?.messages;
  if (!Array.isArray(messages)) return false;
  for (const m of messages) {
    if (!Array.isArray(m?.content)) continue;
    for (const b of m.content) {
      if (b?.type === 'tool_result' && b.is_error === true) return true;
    }
  }
  return false;
}

// ── Credential scanning ──────────────────────────────────────────────
const CREDENTIAL_PATTERNS = [
  /sk-ant-[a-zA-Z0-9_-]{20,}/,
  /sk-[a-zA-Z0-9]{20,}/,
  /ghp_[a-zA-Z0-9]{36}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN (?:RSA|EC|OPENSSH) PRIVATE KEY-----/,
];

function scanCredentials(text) {
  if (!text) return false;
  if (CREDENTIAL_PATTERNS.some(p => p.test(text))) return true;
  try {
    const decoded = decodeURIComponent(text);
    if (decoded !== text) return CREDENTIAL_PATTERNS.some(p => p.test(decoded));
  } catch (_) {}
  return false;
}

function entryHasCredential(entry) {
  // Scan current response (assistant text deltas)
  if (Array.isArray(entry.res)) {
    for (const ev of entry.res) {
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        if (scanCredentials(ev.delta.text)) return true;
      }
    }
  }
  // Scan messages history: assistant text blocks + tool_result content
  const messages = entry.req?.messages;
  if (!Array.isArray(messages)) return false;
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (msg.role === 'assistant' && block.type === 'text') {
        if (scanCredentials(block.text)) return true;
      } else if (msg.role === 'assistant' && block.type === 'tool_use' && block.input) {
        if (scanCredentials(JSON.stringify(block.input))) return true;
      } else if (block.type === 'tool_result') {
        const c = block.content;
        if (typeof c === 'string' && scanCredentials(c)) return true;
        if (Array.isArray(c)) {
          for (const b of c) {
            if (b.type === 'text' && scanCredentials(b.text)) return true;
          }
        }
      }
    }
  }
  return false;
}

// ── Taint / source classification ───────────────────────────────────
const SENSITIVE_PATH_PATTERNS = [
  '~/.ssh/', 'id_rsa', 'id_ed25519', 'id_ecdsa', 'authorized_keys', 'known_hosts',
  '.env', '/.env',
  '/etc/passwd', '/etc/shadow', '/etc/sudoers',
];

const NETWORK_TOOL_NAMES = new Set(['WebFetch', 'WebSearch']);
const NETWORK_TOOL_SUFFIXES = ['_fetch', '_search', '_browse', '_crawl'];

function classifyToolSource(toolName, toolInput) {
  if (NETWORK_TOOL_NAMES.has(toolName)) return 'network';
  if (toolName.startsWith('mcp__') && NETWORK_TOOL_SUFFIXES.some(s => toolName.endsWith(s))) return 'network';
  const inputStr = toolInput ? JSON.stringify(toolInput).toLowerCase() : '';
  if (SENSITIVE_PATH_PATTERNS.some(p => inputStr.includes(p.toLowerCase()))) return 'local:sensitive';
  return 'local';
}

function buildToolSources(entry) {
  const sources = {};
  const messages = entry.req?.messages;
  if (!Array.isArray(messages)) return sources;
  for (const msg of messages) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === 'tool_use' && block.id) {
        sources[block.id] = classifyToolSource(block.name, block.input);
      }
    }
  }
  return sources;
}

// ── Tool usage extraction ────────────────────────────────────────────
function extractToolCalls(messages) {
  const counts = {};
  (messages || []).forEach(m => {
    if (!Array.isArray(m.content)) return;
    m.content.forEach(b => {
      if (b.type === 'tool_use' && b.name) counts[b.name] = (counts[b.name] || 0) + 1;
    });
  });
  return counts;
}

function extractDuplicateToolCalls(messages) {
  const seen = {};  // key → { name, count }
  (messages || []).forEach(m => {
    if (!Array.isArray(m.content)) return;
    m.content.forEach(b => {
      if (b.type !== 'tool_use' || !b.name) return;
      const inputStr = JSON.stringify(b.input || {});
      // Large inputs (>10KB): truncated key (may over-count, acceptable tradeoff)
      const key = b.name + '\0' + (inputStr.length > 10240 ? inputStr.slice(0, 200) : inputStr);
      if (!seen[key]) seen[key] = { name: b.name, count: 0 };
      seen[key].count++;
    });
  });
  const dupes = {};
  for (const { name, count } of Object.values(seen)) {
    if (count > 1) dupes[name] = (dupes[name] || 0) + (count - 1);
  }
  return Object.keys(dupes).length > 0 ? dupes : null;
}

// ── Star-based retention helpers ────────────────────────────────────
// Sentinels: pseudo session/project ids that act as catch-all buckets.
// Upward star derivation skips these so a single starred turn inside a
// sentinel does not pin the entire bucket.
const SENTINEL_SESSIONS = new Set(['direct-api']);
const SENTINEL_PROJECTS = new Set(['(unknown)', '(quota-check)']);

// Mirrors the frontend's getProjectName in public/miller-columns.js.
// null/empty → '(unknown)'; leading '(' is a passthrough sentinel label.
function getProjectName(cwd) {
  if (!cwd || typeof cwd !== 'string') return '(unknown)';
  if (cwd.startsWith('(')) return cwd;
  const parts = cwd.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '(unknown)';
}

// Walk parsed index entries once to derive the retention sets used by both
// pruneLogs and restoreFromLogs. Returns plain Sets so callers can do O(1)
// membership checks without re-walking. Sentinel buckets contribute leaves
// (their own starredTurns) but never pull their parent into the retained set.
//
// Inputs:
//   indexEntries: Array<{ id, sessionId, cwd }>  (pre-parsed; minimum fields)
//   stars: { projects: string[], sessions: string[], turns: string[], steps: string[] }
function computeRetentionSets(indexEntries, stars) {
  const starredTurnIds = new Set(stars?.turns || []);
  for (const stepId of stars?.steps || []) {
    const turnId = typeof stepId === 'string' ? stepId.split('::')[0] : '';
    if (turnId) starredTurnIds.add(turnId);
  }
  // Defensive: even if a sentinel id slipped into starredSessions/Projects (via
  // pre-API-guard data, manual settings.json edit, or older client), it must
  // never lift the bucket as a unit. Filter at the source.
  const retainedSessions = new Set((stars?.sessions || []).filter(s => !SENTINEL_SESSIONS.has(s)));
  const retainedProjects = new Set((stars?.projects || []).filter(p => !SENTINEL_PROJECTS.has(p)));

  // Phase 1: turns lift their session into retained (unless sentinel).
  for (const entry of indexEntries) {
    if (!entry || !starredTurnIds.has(entry.id)) continue;
    const sid = entry.sessionId;
    if (sid && !SENTINEL_SESSIONS.has(sid)) retainedSessions.add(sid);
  }

  // Phase 2: any retained session OR starred turn lifts its project into
  // retained (unless sentinel project name).
  for (const entry of indexEntries) {
    if (!entry) continue;
    const sid = entry.sessionId;
    const isStarredTurn = starredTurnIds.has(entry.id);
    const isInRetainedSession = sid && retainedSessions.has(sid);
    if (!isStarredTurn && !isInRetainedSession) continue;
    const proj = getProjectName(entry.cwd);
    if (proj && !SENTINEL_PROJECTS.has(proj)) retainedProjects.add(proj);
  }

  return { starredTurnIds, retainedSessions, retainedProjects };
}

// Pure boolean check: is this entry protected by the given retention sets?
// `meta` is one parsed index line; the sets come from computeRetentionSets.
function isProtectedByStar(meta, sets) {
  if (!meta || !sets) return false;
  if (sets.starredTurnIds && sets.starredTurnIds.has(meta.id)) return true;
  if (meta.sessionId && sets.retainedSessions && sets.retainedSessions.has(meta.sessionId)) return true;
  const proj = getProjectName(meta.cwd);
  if (proj && sets.retainedProjects && sets.retainedProjects.has(proj)) return true;
  return false;
}

module.exports = {
  timestamp,
  taipeiTime,
  printSeparator,
  safeCountTokens,
  TOOL_CATEGORIES,
  parseSystemBlocks,
  parseClaudeMdFromMessages,
  categorizeTools,
  analyzeContext,
  tokenizeRequest,
  extractUsage,
  summarizeRequest,
  computeTurnStep,
  renderAttributionPrefix,
  totalContextTokens,
  printContextBar,
  computeThinkingDuration,
  parseSSEEvents,
  extractResponseTitle,
  extractTitleGenPayload,
  extractLastUserText,
  extractToolResultSummary,
  extractFirstUserText,
  hasToolFail,
  extractToolCalls,
  extractDuplicateToolCalls,
  scanCredentials,
  entryHasCredential,
  classifyToolSource,
  buildToolSources,
  SENTINEL_SESSIONS,
  SENTINEL_PROJECTS,
  getProjectName,
  computeRetentionSets,
  isProtectedByStar,
};
