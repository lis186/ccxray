'use strict';

const { countTokens } = require('@anthropic-ai/tokenizer');

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
  return {
    input_tokens: u.input_tokens || 0,
    output_tokens: msgDelta?.usage?.output_tokens || u.output_tokens || 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
    cache_read_input_tokens: u.cache_read_input_tokens || 0,
  };
}

function summarizeRequest(body) {
  const lines = [];
  lines.push(`  Model:     ${body.model || '?'}`);
  if (body.system) {
    const text = typeof body.system === 'string' ? body.system : JSON.stringify(body.system);
    lines.push(`  System:    ${safeCountTokens(text).toLocaleString()} tokens`);
  }
  if (body.tools && body.tools.length > 0) {
    const names = body.tools.map(t => t.name);
    const preview = names.slice(0, 7).join(', ');
    const suffix = names.length > 7 ? `, … (${names.length} total)` : '';
    lines.push(`  Tools:     ${names.length} [${preview}${suffix}]`);
  }
  if (body.messages && body.messages.length > 0) {
    const msgs = body.messages;
    const userCount = msgs.filter(m => m.role === 'user').length;
    const asstCount = msgs.filter(m => m.role === 'assistant').length;
    lines.push(`  Messages:  ${msgs.length} (${userCount} user, ${asstCount} assistant)`);
  }
  return lines.join('\n');
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
function extractResponseTitle(res) {
  if (!res) return null;
  let text = '';
  if (Array.isArray(res)) {
    text = res
      .filter(ev => ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta')
      .map(ev => ev.delta.text).join('');
  } else if (res.content) {
    text = (res.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  }
  text = text.trim().replace(/\s+/g, ' ');
  if (!text) return null;
  const firstSentence = text.split(/[.\n]/)[0].trim();
  return (firstSentence || text).slice(0, 80) || null;
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
  return CREDENTIAL_PATTERNS.some(p => p.test(text));
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
  totalContextTokens,
  printContextBar,
  computeThinkingDuration,
  parseSSEEvents,
  extractResponseTitle,
  extractToolCalls,
  extractDuplicateToolCalls,
  scanCredentials,
  entryHasCredential,
};
