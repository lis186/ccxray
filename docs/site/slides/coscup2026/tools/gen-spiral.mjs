// 死亡螺旋 session:不分工、context 一路墊到 95%、auto compact、cache 全滅、重生。
// 單獨的 CCXRAY_HOME(給逐格重播用);費率同 server/default-rates.js。
import fs from 'fs';
const HOME = process.argv[2];
const LOGS = HOME + '/logs';
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(LOGS + '/shared', { recursive: true });
// 共用 orchestrator prompt(agentKey 判定用)
fs.copyFileSync('ccxray-smoke/logs/shared/sys_f3a9c1.json', LOGS + '/shared/sys_f3a9c1.json');
fs.copyFileSync('ccxray-smoke/logs/shared/tools_7d2e88.json', LOGS + '/shared/tools_7d2e88.json');

const RATE = { input: 3, output: 15, cache_create: 3.75, cache_read: 0.30 }; // claude-sonnet-4-6
const price = u => Math.round((u.input_tokens * RATE.input + u.output_tokens * RATE.output +
  u.cache_creation_input_tokens * RATE.cache_create + u.cache_read_input_tokens * RATE.cache_read) / 1e6 * 10000) / 10000;

const pad = n => String(n).padStart(2, '0');
const mkId = t => { const d = new Date(t); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth()+1) + '-' + pad(d.getUTCDate()) + 'T' + pad(d.getUTCHours()) + '-' + pad(d.getUTCMinutes()) + '-' + pad(d.getUTCSeconds()) + '-' + String(d.getUTCMilliseconds()).padStart(3,'0'); };
const mkTs = t => { const d = new Date(t); return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); };

const sid = 'deadc0de-4444-5555-6666-777788889999';
const MODEL = 'claude-sonnet-4-6';
// 每回合目標 context %(of 200K):21 回合爬到 95 → auto compact → 15 → 23
const PCT = [11,17,24,30,37,43,49,55,60,65,70,74,78,81,84,86,88,90,92,93.5,95, 15,17,19,21,23];
const FAIL = new Set([13,16,18,19,20,21]);           // 1-based:dumb zone 失敗回合(紅點)
const COMPACT_AT = 22;                                // 1-based:compact 後第一手
const tools = k => (k % 3 === 0 ? { Bash: 1, Edit: 1 } : k % 3 === 1 ? { Read: 2 } : { Edit: 2 });

const spanGap = k => (k >= 15 ? 95 : 70) + (k * 7) % 40;          // 對話間隔 70–135s
const elapsedOf = k => (k >= 15 && k < COMPACT_AT ? 17 + (k * 5) % 18 : 6 + (k * 3) % 9); // dumb zone 變慢
let total = 0;
PCT.forEach((_, i) => { total += elapsedOf(i + 1) + spanGap(i + 1); });
let t = Date.now() - total * 1000 - 8 * 60000;       // 結束於 ~8 分鐘前

const lines = [];
let prevCtx = 0, msgCount = 1, cost = 0;
PCT.forEach((pct, i) => {
  const k = i + 1;
  const ctx = Math.round(pct * 2000);
  const isCompact = k === COMPACT_AT;
  const inTok = k === 1 ? 8200 : isCompact ? 420 : 30 + (k * 13) % 40;
  const read = (k === 1 || isCompact) ? 0 : prevCtx;   // compact → cache 全滅
  const cc = Math.max(0, ctx - read - inTok);
  const outTok = 280 + (k * 97) % 540;
  const usage = { input_tokens: inTok, output_tokens: outTok, cache_creation_input_tokens: cc, cache_read_input_tokens: read };
  if (isCompact) msgCount = 3; else if (k > 1) msgCount += 2;
  const id = mkId(t);
  const elapsed = elapsedOf(k);
  fs.writeFileSync(LOGS + '/' + id + '_req.json', JSON.stringify({ model: MODEL, max_tokens: 16000, messages: [{ role: 'user', content: 'refactor auth middleware — turn ' + k }], sysHash: 'f3a9c1', toolsHash: '7d2e88' }));
  fs.writeFileSync(LOGS + '/' + id + '_res.json', JSON.stringify([
    { type: 'message_start', message: { id: 'msg_01D' + pad(k), type: 'message', role: 'assistant', model: MODEL, usage: { ...usage, output_tokens: 1 } } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: outTok } },
    { type: 'message_stop' },
  ]));
  const c = price(usage); cost += c;
  lines.push({
    id, ts: mkTs(t), sessionId: sid, provider: 'anthropic', agent: 'claude',
    model: MODEL, msgCount, toolCount: 8,
    toolCalls: tools(k), turnToolCalls: tools(k),
    isSubagent: false, sessionInferred: false, cwd: '/home/justin/dev/api-server',
    receivedAt: t, elapsed: elapsed.toFixed(1),
    usage, cost: { cost: c }, maxContext: 200000,
    stopReason: 'end_turn', title: 'Refactor auth middleware', status: 200,
    toolFail: FAIL.has(k),
    sysHash: 'f3a9c1', toolsHash: '7d2e88', coreHash: 'aa11bb', agentKey: 'orchestrator', agentLabel: 'Claude Code',
    convId: k >= COMPACT_AT ? 'c0mpac7d' : '0ddba11e', responseId: 'msg_01D' + pad(k), isSSE: true,
  });
  prevCtx = ctx;
  t += (elapsed + spanGap(k)) * 1000;
});
fs.writeFileSync(LOGS + '/index.ndjson', lines.map(l => JSON.stringify(l)).join('\n') + '\n');
fs.writeFileSync(HOME + '/all-lines.json', JSON.stringify(lines));
console.log('spiral: 26 turns, peak', PCT[20] + '%', '→ compact →', PCT[21] + '%,',
  'fails:', [...FAIL].join(','), ', cost $' + cost.toFixed(2), ', span', Math.round(total / 60) + 'm');
