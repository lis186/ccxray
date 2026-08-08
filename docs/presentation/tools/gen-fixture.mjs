import fs from 'fs';
const HOME = process.argv[2];
const LOGS = HOME + '/logs';
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(LOGS, { recursive: true }); const SHARED = LOGS + '/shared'; fs.mkdirSync(SHARED, { recursive: true });
const now = Date.now();
const sidA = 'a1b2c3d4-1111-2222-3333-444455556666';
const sidB = 'b2c3d4e5-7777-8888-9999-000011112222';
const pad = n => String(n).padStart(2, '0');
const mkId = t => { const d = new Date(t); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth()+1) + '-' + pad(d.getUTCDate()) + 'T' + pad(d.getUTCHours()) + '-' + pad(d.getUTCMinutes()) + '-' + pad(d.getUTCSeconds()) + '-' + String(d.getUTCMilliseconds()).padStart(3,'0'); };
const mkTs = t => { const d = new Date(t); return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); };

// ── 共享 system prompt / tools 檔 ──────────────────────────
const CORE_A = `You are an interactive agent that helps users with software engineering tasks. Use the instructions below and the tools available to you to assist the user.

IMPORTANT: Assist with defensive security tasks only. Refuse to create, modify, or improve code that may be used maliciously.

If the user asks for help or wants to give feedback inform them of the following:
- /help: Get help with using Claude Code
- To give feedback, users should report the issue at https://github.com/anthropics/claude-code/issues

When the user directly asks about Claude Code, use the WebFetch tool to gather information to answer the question from Claude Code docs.
`;
const CORE_B = CORE_A + `
# Task Management
You have access to the TaskCreate and TaskUpdate tools to help you manage and plan tasks. Use these tools VERY frequently to ensure that you are tracking your tasks and giving the user visibility into your progress.
`;
const TONE = `
# Tone and style
You should be concise, direct, and to the point. When you run a non-trivial bash command, you should explain what the command does and why you are running it. Output text to communicate with the user; all text you output outside of tool use is displayed to the user.
`;
const mkSys = (core, ver) => ([
  { type: 'text', text: `x-anthropic-internal cc_version=${ver}; platform=darwin` },
  { type: 'text', text: 'You are Claude Code, Anthropic\'s official CLI for Claude.' },
  { type: 'text', text: core + TONE },
]);
fs.writeFileSync(SHARED + '/sys_f3a9c1.json', JSON.stringify(mkSys(CORE_A, '2.0.14')));
fs.writeFileSync(SHARED + '/sys_e5b7d2.json', JSON.stringify(mkSys(CORE_B, '2.0.15')));
fs.writeFileSync(SHARED + '/sys_99baaf.json', JSON.stringify([
  { type: 'text', text: 'x-anthropic-internal cc_version=2.0.14; platform=darwin' },
  { type: 'text', text: 'You are Claude Code, Anthropic\'s official CLI for Claude.' },
  { type: 'text', text: 'You are a file search specialist for Claude Code. Your job is to locate files and code relevant to a query using Glob, Grep and Read, then report precise paths and line numbers back to the orchestrator. Be thorough: check multiple naming conventions and locations before concluding something does not exist. Never modify files. Keep your final report compact and structured so the calling agent can act on it without re-reading the files you cite. Prefer targeted reads over full-file dumps to conserve context. When the query is ambiguous, enumerate the plausible interpretations and cover each briefly.' + TONE },
]));
fs.writeFileSync(SHARED + '/tools_7d2e88.json', JSON.stringify(
  ['Bash','Read','Edit','Write','Glob','Grep','Task','WebFetch'].map(n => ({ name: n, description: n + ' tool', input_schema: { type: 'object' } }))
));

// ── 回合資料 ────────────────────────────────────────────────
const lines = [];
const writeTurn = (id, req, resEvents) => {
  fs.writeFileSync(LOGS + '/' + id + '_req.json', JSON.stringify(req));
  fs.writeFileSync(LOGS + '/' + id + '_res.json', JSON.stringify(resEvents));
};
const asst = (blocks) => ({ role: 'assistant', content: blocks });
const user = (c) => ({ role: 'user', content: c });
const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });
const toolResult = (id, text) => ({ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] });

const sseFor = (rid, model, inTok, outTok, cacheRead, blocks, thinking) => {
  const ev = [{ type: 'message_start', message: { id: rid, type: 'message', role: 'assistant', model, usage: { input_tokens: inTok, cache_creation_input_tokens: 2200, cache_read_input_tokens: cacheRead, output_tokens: 1 } } }];
  let idx = 0;
  if (thinking) {
    ev.push({ type: 'content_block_start', index: idx, content_block: { type: 'thinking', thinking: '' } });
    ev.push({ type: 'content_block_delta', index: idx, delta: { type: 'thinking_delta', thinking: '這個 rendering bug 可能出在 dirty-check signature……先重現,再看 renderProjectsCol 的 sigParts 是否漏了欄位。' } });
    ev.push({ type: 'content_block_stop', index: idx }); idx++;
  }
  for (const b of blocks) {
    if (b.t === 'text') {
      ev.push({ type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } });
      ev.push({ type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: b.text } });
      ev.push({ type: 'content_block_stop', index: idx });
    } else {
      ev.push({ type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
      ev.push({ type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
      ev.push({ type: 'content_block_stop', index: idx });
    }
    idx++;
  }
  ev.push({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: outTok } });
  ev.push({ type: 'message_stop' });
  return ev;
};

// Session A:14 回合主線
let t = now - 42 * 60000;
let cacheRead = 18000;
let msgs = [user('幫我修 dashboard 的 rendering bug:SSE 進來之後 Projects 欄有時不會更新')];
const script = [
  { tools: [['tu1','Read',{file_path:'public/miller-columns.js'}],['tu2','Read',{file_path:'public/app.js'}]], say: '先看 renderProjectsCol 的 dirty-check。' },
  { tools: [['tu3','Grep',{pattern:'sigParts'}],['tu4','Read',{file_path:'public/entry-rendering.js'}]], say: '簽章欄位少了 idleBucket。' },
  { tools: [['tu5','Edit',{file_path:'public/miller-columns.js'}]], say: '補上 sigParts 欄位。' },
  { tools: [['tu6','Bash',{command:'npm test'}]], say: '跑測試確認。' },
  { tools: [['tu7','Read',{file_path:'test/render.test.js'}],['tu8','Edit',{file_path:'test/render.test.js'}]], say: '加回歸測試。' },
  { tools: [['tu9','Bash',{command:'npm test'}]], say: '測試全綠。' },
  { tools: [['tu10','Edit',{file_path:'public/miller-columns.js'}],['tu11','Bash',{command:'node --test'}]], say: '重構 guard comment。' },
  { tools: [['tu12','Task',{description:'搜尋其他 sigParts 遺漏', subagent_type:'Explore'}]], say: '派 Explore 子代理掃其他遺漏。', thinking: true },
  { tools: [['tu13','Read',{file_path:'public/workflow-timeline.js'}]], say: '檢查泳道視圖同類問題。' },
  { tools: [['tu14','Bash',{command:'git diff --stat'}]], say: '檢視變更範圍。' },
  { tools: [['tu15','Edit',{file_path:'docs/decisions/0002-dirty-check-signature.md'}]], say: '更新 ADR。' },
  { tools: [['tu16','Bash',{command:'git add -A && git commit'}]], say: '提交修正。' },
  { tools: [['tu17','Read',{file_path:'CHANGELOG.md'}]], say: '補 changelog。' },
  { tools: [['tu18','Bash',{command:'git push'}]], say: '完成,推上遠端。' },
];
const toolsAgg = [{Read:2},{Grep:1,Read:1},{Edit:1},{Bash:1},{Read:1,Edit:1},{Bash:1},{Edit:1,Bash:1},{Task:1},{Read:1},{Bash:1},{Edit:1},{Bash:1},{Read:1},{Bash:1}];
for (let k = 0; k < 14; k++) {
  const id = mkId(t);
  const rid = 'msg_01A' + String(k).padStart(2, '0');
  const elapsedMs = k === 7 ? 68000 : (6000 + (k * 1700) % 14000);
  cacheRead += 6500 + k * 900;
  const outTok = 380 + (k * 260) % 900;
  const s = script[k];
  const blocks = [{ t: 'text', text: s.say }, ...s.tools.map(([tid, name, input]) => ({ t: 'tool', id: tid + '-' + k, name, input }))];
  writeTurn(id,
    { model: 'claude-opus-4-6', max_tokens: 32000, messages: msgs.slice(), sysHash: 'f3a9c1', toolsHash: '7d2e88' },
    sseFor(rid, 'claude-opus-4-6', 40 + k * 7, outTok, cacheRead, blocks, !!s.thinking));
  lines.push({
    id, ts: mkTs(t), sessionId: sidA, provider: 'anthropic', agent: 'claude',
    model: 'claude-opus-4-6', msgCount: msgs.length, toolCount: 8,
    toolCalls: toolsAgg[k], turnToolCalls: toolsAgg[k],
    isSubagent: false, sessionInferred: false, cwd: '/home/justin/dev/ccxray',
    receivedAt: t, elapsed: (elapsedMs / 1000).toFixed(1),
    usage: { input_tokens: 40 + k * 7, output_tokens: outTok, cache_creation_input_tokens: 2200, cache_read_input_tokens: cacheRead },
    cost: { cost: 0.11 + k * 0.021 }, maxContext: 200000,
    stopReason: 'end_turn', title: 'Fix dashboard rendering bug', status: 200,
    sysHash: 'f3a9c1', toolsHash: '7d2e88', coreHash: 'aa11bb', agentKey: 'orchestrator', agentLabel: 'Claude Code',
    convId: 'c0ffee11', responseId: rid, isSSE: true,
    ...(k === 7 ? { thinkingDuration: 29.8 } : {}),
  });
  // 累積對話
  msgs.push(asst([{ type: 'text', text: s.say }, ...s.tools.map(([tid, name, input]) => toolUse(tid + '-' + k, name, input))]));
  msgs.push(user(s.tools.map(([tid]) => toolResult(tid + '-' + k, 'ok'))));
  t += elapsedMs + 9000;
}
// Explore 子代理 3 回合(與主線後段重疊)
let ts2 = now - 42 * 60000 + 8 * 30000;
for (let k = 0; k < 3; k++) {
  const id = mkId(ts2);
  const rid = 'msg_01S' + String(k).padStart(2, '0');
  const blocks = [{ t: 'text', text: '掃描 render 呼叫點。' }, { t: 'tool', id: 'se' + k, name: 'Grep', input: { pattern: 'innerHTML' } }];
  writeTurn(id,
    { model: 'claude-sonnet-4-6', max_tokens: 16000, messages: [user('找出所有直接 innerHTML 更新且未走 dirty-check 的 render 呼叫點')], sysHash: '99baaf', toolsHash: '7d2e88' },
    sseFor(rid, 'claude-sonnet-4-6', 900, 350, 12000 + k * 4000, blocks, false));
  lines.push({
    id, ts: mkTs(ts2), sessionId: sidA, provider: 'anthropic', agent: 'claude',
    model: 'claude-sonnet-4-6', msgCount: 1 + k * 2, toolCount: 8,
    toolCalls: { Grep: 3 + k, Read: 5 }, turnToolCalls: { Grep: 3 + k, Read: 5 },
    isSubagent: true, sessionInferred: false, cwd: '/home/justin/dev/ccxray',
    receivedAt: ts2, elapsed: '8.4',
    usage: { input_tokens: 900, output_tokens: 350, cache_creation_input_tokens: 500, cache_read_input_tokens: 12000 + k * 4000 },
    cost: { cost: 0.04 }, maxContext: 200000,
    stopReason: 'end_turn', title: 'Fix dashboard rendering bug', status: 200,
    sysHash: '99baaf', toolsHash: '7d2e88', coreHash: 'dd44ee', agentKey: 'explore', agentLabel: 'Explore',
    convId: 'deadbe22', responseId: rid, isSSE: true,
  });
  ts2 += 26000;
}
// Session B(webapp,v2.0.15 的 prompt → System Prompt 有兩版可 diff)
let tb = now - 3 * 3600000;
for (let k = 0; k < 4; k++) {
  const id = mkId(tb);
  const rid = 'msg_01B' + String(k).padStart(2, '0');
  writeTurn(id,
    { model: 'claude-sonnet-4-6', max_tokens: 32000, messages: [user('加上使用者驗證流程')], sysHash: 'e5b7d2', toolsHash: '7d2e88' },
    sseFor(rid, 'claude-sonnet-4-6', 60, 400, 30000 + k * 8000, [{ t: 'text', text: '規劃 auth flow。' }, { t: 'tool', id: 'wb' + k, name: 'Read', input: { file_path: 'src/auth.ts' } }], false));
  lines.push({
    id, ts: mkTs(tb), sessionId: sidB, provider: 'anthropic', agent: 'claude',
    model: 'claude-sonnet-4-6', msgCount: 2 + k * 2, toolCount: 8,
    toolCalls: { Read: 1 + k }, turnToolCalls: { Read: 1 + k }, isSubagent: false, sessionInferred: false,
    cwd: '/home/justin/dev/webapp', receivedAt: tb, elapsed: '5.2',
    usage: { input_tokens: 60, output_tokens: 400, cache_creation_input_tokens: 1500, cache_read_input_tokens: 30000 + k * 8000 },
    cost: { cost: 0.06 + k * 0.01 }, maxContext: 200000,
    stopReason: 'end_turn', title: 'Add user auth flow', status: 200,
    sysHash: 'e5b7d2', toolsHash: '7d2e88', coreHash: 'aa11bb', agentKey: 'orchestrator', agentLabel: 'Claude Code',
    convId: 'beef3344', responseId: rid, isSSE: true,
  });
  tb += 65000;
}
lines.sort((a, b) => a.receivedAt - b.receivedAt);
fs.writeFileSync(LOGS + '/index.ndjson', lines.map(l => JSON.stringify(l)).join('\n') + '\n');
console.log('wrote', lines.length, 'entries +', fs.readdirSync(LOGS).length - 1, 'files');
