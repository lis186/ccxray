'use strict';

// Transcript evidence (docs/agentflow-integration.md, "Transcript evidence").
// The index keeps no tool arguments or owner text, so these readers parse
// transcripts directly, in memory only. Nothing read here is ever printed.

const fs = require('fs');

function toMs(ts) {
  const n = Date.parse(ts);
  return Number.isFinite(n) ? n : null;
}

function lines(file) {
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

function blockText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(b => (b && (b.type === 'text' || b.type === 'input_text' || b.type === 'output_text') ? b.text || '' : '')).join('\n');
}

const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/gu;
const PERSISTED = /<persisted-output>[\s\S]*?Full output saved to:\s*(\/\S+)/u;
const PERSISTED_MAX_BYTES = 8 * 1024 * 1024;

// An oversized Claude tool result is saved to a side file whose absolute path
// the transcript's preview records (possibly under another config directory).
// Read it; if it is gone, keep the preview and mark the evidence truncated.
function resolvePersisted(text) {
  const m = PERSISTED.exec(text);
  if (!m) return { text, truncated: false };
  try {
    if (fs.statSync(m[1]).size <= PERSISTED_MAX_BYTES) return { text: fs.readFileSync(m[1], 'utf8'), truncated: false };
  } catch {}
  return { text, truncated: true };
}

// Claude owner submissions exclude meta lines, tool results, slash commands and
// skill expansions, task notifications, and lines holding only system reminders
// or hook context. Gated on text shape, not on the newer `origin` fields, which
// older lines lack.
function claudeOwnerText(e) {
  if (e.type !== 'user' || e.isMeta) return null;
  const content = e.message && e.message.content;
  let text;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    const texts = content.filter(b => b && b.type === 'text');
    if (!texts.length) return null;
    text = texts.map(b => b.text || '').join('\n');
  } else return null;
  const t = text.trim();
  if (t.startsWith('<command-') || t.startsWith('<local-command') || t.includes('<task-notification>')) return null;
  if (t.startsWith('Base directory for this skill')) return null;
  const rest = t.replace(SYSTEM_REMINDER, '').trim();
  if (!rest || /^<[a-z-]+-hook[\s>]/u.test(rest)) return null;
  return rest;
}

// One pass over a Claude transcript. Events are deduplicated by uuid; tool
// blocks are merged by tool_use id, so a message written as several lines keeps
// every distinct block (F20).
function readClaudeTranscript(file) {
  const seen = new Set();
  const submissions = [];
  const tools = new Map();
  const turns = new Map(); // message.id → first time; usage counts each message once
  let sessionId = null;
  for (const e of lines(file)) {
    if (e.uuid) { if (seen.has(e.uuid)) continue; seen.add(e.uuid); }
    if (!sessionId && e.sessionId) sessionId = e.sessionId;
    const at = toMs(e.timestamp);
    if (e.type === 'assistant' && e.message && e.message.id && !turns.has(e.message.id)) turns.set(e.message.id, at);
    const owner = claudeOwnerText(e);
    if (owner != null) submissions.push({ key: e.uuid || `${file}:${submissions.length}`, sessionId: e.sessionId || sessionId, at, text: owner });
    const content = e.message && Array.isArray(e.message.content) ? e.message.content : [];
    for (const b of content) {
      if (!b) continue;
      if (b.type === 'tool_use' && b.id) {
        const t = tools.get(b.id) || { id: b.id, sessionId: e.sessionId || sessionId };
        Object.assign(t, { name: b.name, input: JSON.stringify(b.input ?? null), inputAt: at });
        tools.set(b.id, t);
      } else if (b.type === 'tool_result' && b.tool_use_id) {
        const t = tools.get(b.tool_use_id) || { id: b.tool_use_id, sessionId: e.sessionId || sessionId };
        const r = resolvePersisted(blockText(b.content));
        Object.assign(t, { result: r.text, truncated: r.truncated, resultAt: at, isError: !!b.is_error });
        tools.set(b.tool_use_id, t);
      }
    }
  }
  for (const t of tools.values()) t.origin = file;
  return { provider: 'anthropic', sessionId, submissions, tools: [...tools.values()], turns: [...turns].map(([id, at]) => ({ id, at })) };
}

// Codex: owner messages are `response_item` user messages that are not tagged
// context (environment, instructions, app context); background threads such as
// memory_consolidation carry no owner input.
function readCodexTranscript(file) {
  const submissions = [];
  const tools = new Map();
  let sessionId = null, background = false;
  for (const [i, e] of lines(file).entries()) {
    const p = e.payload || {};
    const at = toMs(e.timestamp);
    if (e.type === 'session_meta') {
      sessionId = p.id || sessionId;
      if (p.thread_source && p.thread_source !== 'user') background = true;
      continue;
    }
    if (e.type !== 'response_item') continue;
    if (p.type === 'message' && p.role === 'user') {
      const t = blockText(p.content).trim();
      if (!t || t.startsWith('<') || t.startsWith('# AGENTS.md instructions') || t.includes('<INSTRUCTIONS>')) continue;
      submissions.push({ key: `${sessionId}:${i}`, sessionId, at, text: t });
    } else if ((p.type === 'function_call' || p.type === 'custom_tool_call') && p.call_id) {
      const t = tools.get(p.call_id) || { id: p.call_id, sessionId };
      Object.assign(t, { name: p.name, input: typeof p.arguments === 'string' ? p.arguments : typeof p.input === 'string' ? p.input : JSON.stringify(p.arguments ?? p.input ?? null), inputAt: at });
      tools.set(p.call_id, t);
    } else if ((p.type === 'function_call_output' || p.type === 'custom_tool_call_output') && p.call_id) {
      const t = tools.get(p.call_id) || { id: p.call_id, sessionId };
      const out = p.output;
      Object.assign(t, { result: typeof out === 'string' ? out : blockText(out && out.content !== undefined ? out.content : out), resultAt: at });
      tools.set(p.call_id, t);
    }
  }
  for (const t of tools.values()) t.origin = file;
  return { provider: 'openai', sessionId, background, submissions: background ? [] : submissions, tools: [...tools.values()] };
}

// Owner submissions across host transcripts. Across files only an identical
// uuid makes two events one; the merged event remembers every session it
// appeared in, since each is a host row (F3a).
function collectSubmissions(transcripts) {
  const byKey = new Map();
  for (const t of transcripts) {
    for (const s of t.submissions) {
      const prev = byKey.get(s.key);
      if (prev) { if (!prev.sessionIds.includes(s.sessionId)) prev.sessionIds.push(s.sessionId); continue; }
      byKey.set(s.key, { key: s.key, sessionIds: [s.sessionId], at: s.at, text: s.text });
    }
  }
  return [...byKey.values()].filter(s => s.at != null);
}

module.exports = { claudeOwnerText, readClaudeTranscript, readCodexTranscript, collectSubmissions };
