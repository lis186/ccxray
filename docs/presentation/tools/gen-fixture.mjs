import fs from 'fs';
const HOME = process.argv[2];
const LOGS = HOME + '/logs';
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(LOGS, { recursive: true });
const SHARED = LOGS + '/shared';
fs.mkdirSync(SHARED, { recursive: true });
const now = Date.now();
const sidA = 'a1b2c3d4-1111-2222-3333-444455556666';
const sidB = 'b2c3d4e5-7777-8888-9999-000011112222';
const pad = n => String(n).padStart(2, '0');
const mkId = t => { const d = new Date(t); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth()+1) + '-' + pad(d.getUTCDate()) + 'T' + pad(d.getUTCHours()) + '-' + pad(d.getUTCMinutes()) + '-' + pad(d.getUTCSeconds()) + '-' + String(d.getUTCMilliseconds()).padStart(3,'0'); };
const mkTs = t => { const d = new Date(t); return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); };

// 費率照抄 server/default-rates.js(USD / 1M tokens)——成本一律由此計算
const RATES = {
  'claude-fable-5':    { input: 10, output: 50, cache_create: 12.50, cache_read: 1.00 },
  'claude-sonnet-4-6': { input: 3,  output: 15, cache_create: 3.75,  cache_read: 0.30 },
};
const price = (model, u) => {
  const r = RATES[model];
  const c = (u.input_tokens * r.input + u.output_tokens * r.output +
    u.cache_creation_input_tokens * r.cache_create + u.cache_read_input_tokens * r.cache_read) / 1e6;
  return Math.round(c * 10000) / 10000;
};

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
const mkSys = (core, ver, modelMarker) => ([
  { type: 'text', text: `x-anthropic-internal cc_version=${ver}; platform=darwin` },
  { type: 'text', text: 'You are Claude Code, Anthropic\'s official CLI for Claude.' + (modelMarker ? ' The exact model ID is ' + modelMarker + '.' : '') },
  { type: 'text', text: core + TONE },
]);
fs.writeFileSync(SHARED + '/sys_f3a9c1.json', JSON.stringify(mkSys(CORE_A, '2.0.14', 'claude-fable-5[1m]')));
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
const asst = blocks => ({ role: 'assistant', content: blocks });
const user = c => ({ role: 'user', content: c });
const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });
const toolResult = (id, text) => ({ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] });

const sseFor = (rid, model, u, blocks, thinking) => {
  const ev = [{ type: 'message_start', message: { id: rid, type: 'message', role: 'assistant', model,
    usage: { input_tokens: u.input_tokens, cache_creation_input_tokens: u.cache_creation_input_tokens, cache_read_input_tokens: u.cache_read_input_tokens, output_tokens: 1 } } }];
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
  ev.push({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: u.output_tokens } });
  ev.push({ type: 'message_stop' });
  return ev;
};

// ── Session A:claude-fable-5[1m],14 回合,context 152K → ~380K(38% of 1M)──
// 逐回合的合理數字:小 input(增量訊息)、cache 重讀整段歷史、工具結果寫入 cache、
// 中等 output;第 8 回合帶 thinking(較長 elapsed、較大 output)。
const MAIN = 'claude-fable-5';
const T = [
  // [elapsed 秒, gap 秒, input, output, cache_create, tools, say]
  [14.2, 22, 34,  640, 18400, [['tu1','Read',{file_path:'public/miller-columns.js'}],['tu2','Read',{file_path:'public/app.js'}]], '先看 renderProjectsCol 的 dirty-check。'],
  [18.6, 31, 41,  820, 12100, [['tu3','Grep',{pattern:'sigParts'}],['tu4','Read',{file_path:'public/entry-rendering.js'}]], '簽章欄位少了 idleBucket。'],
  [ 9.8, 18, 27,  410, 9800, [['tu5','Edit',{file_path:'public/miller-columns.js'}]], '補上 sigParts 欄位。'],
  [ 8.1, 45, 25,  300, 8500, [['tu6','Bash',{command:'npm test'}]], '跑測試確認。'],
  [21.4, 26, 52,  940, 16600, [['tu7','Read',{file_path:'test/render.test.js'}],['tu8','Edit',{file_path:'test/render.test.js'}]], '加回歸測試。'],
  [ 7.9, 15, 24,  350, 9700, [['tu9','Bash',{command:'npm test'}]], '測試全綠。'],
  [16.3, 33, 47,  760, 14400, [['tu10','Edit',{file_path:'public/miller-columns.js'}],['tu11','Bash',{command:'node --test'}]], '重構 guard comment。'],
  [72.4, 38, 88, 2450, 30200, [['tu12','Task',{description:'搜尋其他 sigParts 遺漏', subagent_type:'Explore'}]], '派 Explore 子代理掃其他遺漏。'],
  [12.7, 21, 36,  520, 12000, [['tu13','Read',{file_path:'public/workflow-timeline.js'}]], '檢查泳道視圖同類問題。'],
  [ 9.2, 17, 26,  290, 9600, [['tu14','Bash',{command:'git diff --stat'}]], '檢視變更範圍。'],
  [15.8, 28, 44,  680, 11900, [['tu15','Edit',{file_path:'docs/decisions/0002-dirty-check-signature.md'}]], '更新 ADR。'],
  [11.4, 24, 31,  430, 13200, [['tu16','Bash',{command:'git add -A && git commit'}]], '提交修正。'],
  [ 8.6, 19, 23,  310, 9500, [['tu17','Read',{file_path:'CHANGELOG.md'}]], '補 changelog。'],
  [13.9,  0, 38,  860, 10700, [['tu18','Bash',{command:'git push'}]], '完成,推上遠端。'],
];
const spanMs = T.reduce((s, r) => s + r[0] * 1000 + r[1] * 1000, 0);
let t = now - spanMs - 95 * 1000;   // 最後一回合結束在 ~95 秒前(cache 倒數仍綠)
let cacheRead = 184000;
const toolsAgg = T.map(r => { const o = {}; for (const [, n] of r[5]) o[n] = (o[n] || 0) + 1; return o; });
let msgs = [user('幫我修 dashboard 的 rendering bug:SSE 進來之後 Projects 欄有時不會更新')];
T.forEach((row, k) => {
  const [elapsed, gap, inTok, outTok, ccTok, tools, say] = row;
  const id = mkId(t);
  const rid = 'msg_01A' + String(k).padStart(2, '0');
  const usage = { input_tokens: inTok, output_tokens: outTok, cache_creation_input_tokens: ccTok, cache_read_input_tokens: cacheRead };
  const blocks = [{ t: 'text', text: say }, ...tools.map(([tid, name, input]) => ({ t: 'tool', id: tid + '-' + k, name, input }))];
  writeTurn(id,
    { model: MAIN, max_tokens: 32000, messages: msgs.slice(), sysHash: 'f3a9c1', toolsHash: '7d2e88' },
    sseFor(rid, MAIN, usage, blocks, k === 7));
  lines.push({
    id, ts: mkTs(t), sessionId: sidA, provider: 'anthropic', agent: 'claude',
    model: MAIN, msgCount: msgs.length, toolCount: 8,
    toolCalls: toolsAgg[k], turnToolCalls: toolsAgg[k],
    isSubagent: false, sessionInferred: false, cwd: '/home/justin/dev/ccxray',
    receivedAt: t, elapsed: elapsed.toFixed(1),
    usage, cost: { cost: price(MAIN, usage) }, maxContext: 1000000, beta1m: true,
    stopReason: 'end_turn', title: 'Fix dashboard rendering bug', status: 200,
    sysHash: 'f3a9c1', toolsHash: '7d2e88', coreHash: 'aa11bb', agentKey: 'orchestrator', agentLabel: 'Claude Code',
    convId: 'c0ffee11', responseId: rid, isSSE: true,
    ...(k === 7 ? { thinkingDuration: 31.2 } : {}),
  });
  // 下一回合:歷史全數進 cache(本回合的 input+creation+output 併入重讀)
  cacheRead += ccTok + inTok + outTok;
  msgs.push(asst([{ type: 'text', text: say }, ...tools.map(([tid, name, input]) => toolUse(tid + '-' + k, name, input))]));
  msgs.push(user(tools.map(([tid]) => toolResult(tid + '-' + k, 'ok'))));
  t += (elapsed + gap) * 1000;
});
const mainStart = now - spanMs - 95 * 1000;

// ── Explore 子代理:sonnet-4-6,3 回合,與主線 thinking 段重疊 ──
const SUB = 'claude-sonnet-4-6';
let ts2 = mainStart + Math.round(spanMs * 0.55);
[[9.6, 4200, 720, 18000], [7.8, 80, 540, 26400], [11.2, 60, 860, 34100]].forEach(([elapsed, inTok, outTok, cr], k) => {
  const id = mkId(ts2);
  const rid = 'msg_01S' + String(k).padStart(2, '0');
  const usage = { input_tokens: inTok, output_tokens: outTok, cache_creation_input_tokens: 900, cache_read_input_tokens: cr };
  const blocks = [{ t: 'text', text: '掃描 render 呼叫點。' }, { t: 'tool', id: 'se' + k, name: 'Grep', input: { pattern: 'innerHTML' } }];
  writeTurn(id,
    { model: SUB, max_tokens: 16000, messages: [user('找出所有直接 innerHTML 更新且未走 dirty-check 的 render 呼叫點')], sysHash: '99baaf', toolsHash: '7d2e88' },
    sseFor(rid, SUB, usage, blocks, false));
  lines.push({
    id, ts: mkTs(ts2), sessionId: sidA, provider: 'anthropic', agent: 'claude',
    model: SUB, msgCount: 1 + k * 2, toolCount: 8,
    toolCalls: { Grep: 3 + k, Read: 5 }, turnToolCalls: { Grep: 3 + k, Read: 5 },
    isSubagent: true, sessionInferred: false, cwd: '/home/justin/dev/ccxray',
    receivedAt: ts2, elapsed: elapsed.toFixed(1),
    usage, cost: { cost: price(SUB, usage) }, maxContext: 200000,
    stopReason: 'end_turn', title: 'Fix dashboard rendering bug', status: 200,
    sysHash: '99baaf', toolsHash: '7d2e88', coreHash: 'dd44ee', agentKey: 'explore', agentLabel: 'Explore',
    convId: 'deadbe22', responseId: rid, isSSE: true,
  });
  ts2 += (elapsed + 14) * 1000;
});

// ── Session B:webapp,sonnet-4-6,45K/200K(≈22%)──
let tb = now - 3 * 3600000;
[[6.1, 55, 380, 31000], [4.8, 42, 290, 34600], [7.3, 61, 520, 38200], [5.2, 48, 340, 42400]].forEach(([elapsed, inTok, outTok, cr], k) => {
  const id = mkId(tb);
  const rid = 'msg_01B' + String(k).padStart(2, '0');
  const usage = { input_tokens: inTok, output_tokens: outTok, cache_creation_input_tokens: 1500, cache_read_input_tokens: cr };
  writeTurn(id,
    { model: SUB, max_tokens: 32000, messages: [user('加上使用者驗證流程')], sysHash: 'e5b7d2', toolsHash: '7d2e88' },
    sseFor(rid, SUB, usage, [{ t: 'text', text: '規劃 auth flow。' }, { t: 'tool', id: 'wb' + k, name: 'Read', input: { file_path: 'src/auth.ts' } }], false));
  lines.push({
    id, ts: mkTs(tb), sessionId: sidB, provider: 'anthropic', agent: 'claude',
    model: SUB, msgCount: 2 + k * 2, toolCount: 8,
    toolCalls: { Read: 1 + k }, turnToolCalls: { Read: 1 + k }, isSubagent: false, sessionInferred: false,
    cwd: '/home/justin/dev/webapp', receivedAt: tb, elapsed: elapsed.toFixed(1),
    usage, cost: { cost: price(SUB, usage) }, maxContext: 200000,
    stopReason: 'end_turn', title: 'Add user auth flow', status: 200,
    sysHash: 'e5b7d2', toolsHash: '7d2e88', coreHash: 'aa11bb', agentKey: 'orchestrator', agentLabel: 'Claude Code',
    convId: 'beef3344', responseId: rid, isSSE: true,
  });
  tb += (elapsed + 55) * 1000;
});
lines.sort((a, b) => a.receivedAt - b.receivedAt);
fs.writeFileSync(LOGS + '/index.ndjson', lines.map(l => JSON.stringify(l)).join('\n') + '\n');

// ── 同步輸出 Claude Code 端的使用記錄(Usage 頁來源)──
// cost-worker 掃 $HOME/.claude/projects/**/*.jsonl,每行 {timestamp, message:{id, model, usage}},
// 成本用 server/default-rates.js 同一張表計算 → 與 proxy index 的數字一致。
const FAKE_HOME = process.argv[3];
if (FAKE_HOME) {
  const projDir = h => FAKE_HOME + '/.claude/projects/' + h;
  const bySess = new Map();
  for (const l of lines) {
    const key = l.cwd.replace(/\//g, '-') + '|' + l.sessionId;
    if (!bySess.has(key)) bySess.set(key, []);
    bySess.get(key).push(JSON.stringify({
      timestamp: new Date(l.receivedAt + Number(l.elapsed) * 1000).toISOString(),
      message: { id: l.responseId, model: l.model, usage: l.usage },
    }));
  }
  for (const [key, rows] of bySess) {
    const [proj, sid] = key.split('|');
    fs.mkdirSync(projDir(proj), { recursive: true });
    fs.writeFileSync(projDir(proj) + '/' + sid + '.jsonl', rows.join('\n') + '\n');
  }
  // ── 過去 30 天歷史使用(Usage 頁的 MONTHLY/DAILY 才不會空)──
  // 需求:成本逐步攀升、帶起伏,30 天平均 $258/日。
  // 形狀:趨勢線 $150 → $420(採用量成長),週末低(六 ~0.6×、日 ~0.4×),
  // 日間噪聲 ±22%,今天為進行中的部分天(≈0.55×趨勢)+ demo session。
  // 金額不手填:湊 token、由同一費率表推出,最後整體正規化到精確平均。
  let hseed = 7;
  const hrnd = () => (hseed = (hseed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const RH = { fable: { i: 10, o: 50, w: 12.5, r: 1.0 }, sonnet: { i: 3, o: 15, w: 3.75, r: 0.3 } };
  const histDir = projDir('-home-justin-dev-ccxray');
  fs.mkdirSync(histDir, { recursive: true });
  const DAYS = 30, AVG_TARGET = 258, demoToday = 6.89;
  const dayFactor = d => { const dow = d.getDay(); return dow === 0 ? 0.4 : dow === 6 ? 0.6 : 1.08; };
  const targets = [];
  for (let ago = DAYS - 1; ago >= 0; ago--) {
    const day = new Date(now - ago * 86400000);
    const trend = 150 + ((DAYS - 1 - ago) / (DAYS - 1)) * 270;      // 150 → 420
    let v = trend * dayFactor(day) * (0.78 + hrnd() * 0.44);        // ±22% 起伏
    if (ago === 0) v = trend * 0.55;                                  // 今天:進行中
    targets.push({ ago, day, v });
  }
  const rawSum = targets.reduce((s, x) => s + x.v, 0);
  const scale = (AVG_TARGET * DAYS - demoToday) / rawSum;             // 正規化到精確平均
  let monthTotals = {};
  for (const { ago, day, v } of targets) {
    const target = v * scale;
    const rows = [];
    let sum = 0, n = 0;
    while (sum < target && n < 1500) {
      const heavy = hrnd() < 0.8;                                     // 重度期:fable 為主
      const R = heavy ? RH.fable : RH.sonnet;
      const u = {
        input_tokens: Math.round(30 + hrnd() * 70),
        output_tokens: Math.round(400 + hrnd() * 1400),
        cache_creation_input_tokens: Math.round(8000 + hrnd() * 30000),
        cache_read_input_tokens: Math.round((heavy ? 480000 : 90000) * (0.5 + hrnd())),
      };
      const c = (u.input_tokens * R.i + u.output_tokens * R.o +
        u.cache_creation_input_tokens * R.w + u.cache_read_input_tokens * R.r) / 1e6;
      sum += c;
      const ts = new Date(day); ts.setHours(8 + Math.floor(hrnd() * (ago === 0 ? 6 : 15)), Math.floor(hrnd() * 60), Math.floor(hrnd() * 60), 0);
      rows.push(JSON.stringify({ timestamp: ts.toISOString(),
        message: { id: 'msg_hist_' + ago + '_' + n, model: heavy ? 'claude-fable-5' : 'claude-sonnet-4-6', usage: u } }));
      n++;
    }
    const dstr = day.toISOString().slice(0, 10);
    fs.writeFileSync(histDir + '/hist-' + dstr + '.jsonl', rows.join('\n') + '\n');
    const mk = dstr.slice(0, 7);
    monthTotals[mk] = (monthTotals[mk] || 0) + sum;
  }
  console.log('claude-home jsonl:', bySess.size, 'demo sessions + 歷史', Object.entries(monthTotals).map(([m, v]) => m + '≈$' + v.toFixed(0)).join(' '), '→', FAKE_HOME + '/.claude/projects');
}
const mainLines = lines.filter(l => l.sessionId === sidA && !l.isSubagent);
const last = mainLines[mainLines.length - 1];
const ctx = last.usage.cache_read_input_tokens + last.usage.cache_creation_input_tokens + last.usage.input_tokens;
console.log('entries:', lines.length,
  '| main ctx:', ctx, '=', (ctx / 1e6 * 100).toFixed(1) + '% of 1M',
  '| main cost: $' + mainLines.reduce((s, l) => s + l.cost.cost, 0).toFixed(2),
  '| span:', Math.round(spanMs / 60000) + 'm');
