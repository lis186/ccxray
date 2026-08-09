// 多 subagent 長任務 × 模型選擇對照(連續瀑布版,對齊使用者參考圖):
//   主 lane 整段密集;子代理「輪替派工」——每隔 Δ 秒開一個新 lane,
//   各自跑數分鐘,birds-eye 呈連續斜瀑布。
//   GOOD:fable-5 1M 指揮 + sonnet 子代理小塊任務 → 全綠、bar 短而密
//   BAD :全上 200K——子代理 ctx 45→95%,橘 bar 稀疏 + 長紅 bar(卡很久),失敗率高
import fs from 'fs';
const HOME = process.argv[2];
const LOGS = HOME + '/logs';
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(LOGS + '/shared', { recursive: true });
for (const f of ['sys_f3a9c1.json', 'sys_99baaf.json', 'tools_7d2e88.json'])
  fs.copyFileSync('ccxray-smoke/logs/shared/' + f, LOGS + '/shared/' + f);

const RATES = {
  'claude-fable-5':    { input: 10, output: 50, cache_create: 12.50, cache_read: 1.00 },
  'claude-sonnet-4-6': { input: 3,  output: 15, cache_create: 3.75,  cache_read: 0.30 },
};
const price = (m, u) => (u.input_tokens * RATES[m].input + u.output_tokens * RATES[m].output +
  u.cache_creation_input_tokens * RATES[m].cache_create + u.cache_read_input_tokens * RATES[m].cache_read) / 1e6;
const pad = n => String(n).padStart(2, '0');
const mkId = t => { const d = new Date(t); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth()+1) + '-' + pad(d.getUTCDate()) + 'T' + pad(d.getUTCHours()) + '-' + pad(d.getUTCMinutes()) + '-' + pad(d.getUTCSeconds()) + '-' + String(d.getUTCMilliseconds()).padStart(3,'0'); };
const mkTs = t => { const d = new Date(t); return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); };
const CWD = '/home/justin/dev/data-pipeline';
const lines = [];
let ridSeq = 0;
let seed = 1234;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const ri = (a, b) => Math.round(a + rnd() * (b - a));

const push = o => {
  const id = mkId(o.t);
  const rid = 'msg_01F' + String(ridSeq++).padStart(3, '0');
  fs.writeFileSync(LOGS + '/' + id + '_req.json', JSON.stringify({ model: o.model, max_tokens: 16000, messages: [{ role: 'user', content: o.brief }], sysHash: o.sysHash, toolsHash: '7d2e88' }));
  const c = price(o.model, o.usage);
  lines.push({
    id, ts: mkTs(o.t), sessionId: o.sid, provider: 'anthropic', agent: 'claude',
    model: o.model, msgCount: o.msgCount, toolCount: 8,
    toolCalls: o.tools, turnToolCalls: o.tools,
    isSubagent: o.sub, sessionInferred: false, cwd: CWD,
    receivedAt: Math.round(o.t), elapsed: o.elapsed.toFixed(1),
    usage: o.usage, cost: { cost: Math.round(c * 10000) / 10000 },
    maxContext: o.maxContext, ...(o.beta1m ? { beta1m: true } : {}),
    stopReason: 'end_turn', title: o.title, status: 200, toolFail: !!o.fail,
    sysHash: o.sysHash, toolsHash: '7d2e88', coreHash: o.coreHash, agentKey: o.agentKey, agentLabel: o.agentLabel,
    convId: o.convId, responseId: rid, isSSE: true,
  });
  return c;
};

function buildSession(cfg) {
  const { sid, title, start, spanSec } = cfg;
  let cost = 0, fails = 0, subTurns = 0, lanes = 0;
  // 主 lane:整段密集(elapsed+gap 串行推進)
  let t = start, prevCtx = 0, k = 0;
  while (t < start + spanSec * 1000) {
    const frac = (t - start) / (spanSec * 1000);
    const ctx = Math.round(cfg.mainCtx0 + (cfg.mainCtx1 - cfg.mainCtx0) * frac);
    const inT = k === 0 ? 5800 : ri(30, 80);
    const usage = { input_tokens: inT, output_tokens: ri(350, 950), cache_creation_input_tokens: Math.max(0, ctx - prevCtx - inT + ri(0, 900)), cache_read_input_tokens: k === 0 ? 0 : prevCtx };
    const elapsed = ri(cfg.mainElapsed[0], cfg.mainElapsed[1]);
    cost += push({ t, sid, model: cfg.mainModel, maxContext: cfg.mainWin, beta1m: cfg.mainBeta,
      usage, msgCount: 1 + k * 2, elapsed, tools: { Task: ri(0, 2), Read: 1 }, sub: false, title,
      brief: title + ' — orchestrator', sysHash: 'f3a9c1', coreHash: 'aa11bb',
      agentKey: 'orchestrator', agentLabel: 'Claude Code', convId: 'a0a0' + sid.slice(0, 4) });
    prevCtx = ctx; k++;
    t += (elapsed + ri(cfg.mainGap[0], cfg.mainGap[1])) * 1000;
  }
  // 稀疏第二列:summarizer 心跳(短 tick)
  for (let s = 0; s < cfg.sparseN; s++) {
    const ts = start + ((s + 0.5) / cfg.sparseN) * spanSec * 1000 + ri(-20, 20) * 1000;
    const ctxTok = cfg.sparseCtx + ri(-2000, 2000);
    cost += push({ t: ts, sid, model: 'claude-sonnet-4-6', maxContext: 200000,
      usage: { input_tokens: ri(900, 1600), output_tokens: ri(60, 160), cache_creation_input_tokens: ri(400, 900), cache_read_input_tokens: ctxTok },
      msgCount: 1, elapsed: ri(1, 3), tools: { Read: 1 }, sub: true, title,
      brief: 'summarize progress', sysHash: '99baaf', coreHash: 'ee55ff',
      agentKey: 'summarizer', agentLabel: 'Summarizer', convId: 'beat' + sid.slice(0, 4) });
  }
  // 子代理:輪替派工——每 Δ 秒開新 lane,各自跑 lifeSec
  let li = 0;
  for (let at = cfg.subStart; at + 60 < spanSec && li < cfg.maxLanes; at += ri(cfg.dispatchEvery[0], cfg.dispatchEvery[1]), li++) {
    const conv = 'f' + String(li).padStart(3, '0') + sid.slice(0, 4);
    const life = ri(cfg.subLife[0], cfg.subLife[1]);
    let st = start + at * 1000;
    const end = Math.min(st + life * 1000, start + spanSec * 1000 - 5000);
    let kk = 0, prev = 0;
    while (st < end) {
      const frac = Math.min(1, (st - (start + at * 1000)) / (life * 1000));
      const ctx = Math.round(cfg.subCtx0 + (cfg.subCtx1 - cfg.subCtx0) * frac) + ri(-2500, 2500);
      // BAD:紅色長 bar(高 ctx 且卡很久)機率隨 lane 進度上升
      const isRed = cfg.redChance && frac > 0.25 && rnd() < cfg.redChance;
      const elapsed = isRed ? ri(cfg.redElapsed[0], cfg.redElapsed[1]) : ri(cfg.subElapsed[0], cfg.subElapsed[1]);
      const ctxEff = isRed ? Math.max(ctx, Math.round(0.84 * 200000 + rnd() * 0.12 * 200000)) : ctx;
      const inT = kk === 0 ? ri(2500, 4500) : ri(25, 70);
      const fail = isRed || (cfg.orangeFail && ctxEff > 90000 && rnd() < cfg.orangeFail);
      if (fail) fails++;
      const usage = { input_tokens: inT, output_tokens: ri(220, 620), cache_creation_input_tokens: Math.max(0, ctxEff - prev - inT), cache_read_input_tokens: kk === 0 ? 0 : prev };
      cost += push({ t: st, sid, model: cfg.subModel, maxContext: 200000,
        usage, msgCount: 1 + kk * 2, elapsed, tools: fail ? { Bash: 2, Edit: 1 } : { Read: 2, Grep: 1 },
        sub: true, fail, title, brief: title + ' — chunk ' + li, sysHash: '99baaf', coreHash: 'dd44ee',
        agentKey: 'explore', agentLabel: 'Explore', convId: conv });
      prev = ctxEff; kk++; subTurns++;
      st += (elapsed + ri(cfg.subGap[0], cfg.subGap[1])) * 1000;
    }
    lanes++;
  }
  return { cost, fails, subTurns, lanes };
}

const now = Date.now();
const G = buildSession({
  sid: 'feedface-1111-2222-3333-444455556666', title: 'Migrate pipeline to v2 schema',
  start: now - 100 * 60000, spanSec: 34 * 60,
  mainModel: 'claude-fable-5', mainWin: 1000000, mainBeta: true,
  mainCtx0: 90000, mainCtx1: 170000, mainElapsed: [8, 18], mainGap: [16, 32],
  sparseN: 9, sparseCtx: 9000,
  subStart: 70, dispatchEvery: [78, 105], maxLanes: 22, subLife: [190, 330],
  subModel: 'claude-sonnet-4-6', subCtx0: 12000, subCtx1: 68000,
  subElapsed: [4, 10], subGap: [7, 16], redChance: 0, redElapsed: [0, 0], orangeFail: 0,
});
const B = buildSession({
  sid: 'baadf00d-7777-8888-9999-000011112222', title: 'Migrate pipeline to v2 schema (retry)',
  start: now - 60 * 60000, spanSec: 52 * 60,
  mainModel: 'claude-sonnet-4-6', mainWin: 200000, mainBeta: false,
  mainCtx0: 60000, mainCtx1: 155000, mainElapsed: [10, 24], mainGap: [18, 40],
  sparseN: 8, sparseCtx: 105000,
  subStart: 110, dispatchEvery: [115, 150], maxLanes: 22, subLife: [560, 880],
  subModel: 'claude-sonnet-4-6', subCtx0: 88000, subCtx1: 176000,
  subElapsed: [14, 36], subGap: [9, 22], redChance: 0.22, redElapsed: [70, 180], orangeFail: 0.3,
});
lines.sort((a, b) => a.receivedAt - b.receivedAt);
fs.writeFileSync(LOGS + '/index.ndjson', lines.map(l => JSON.stringify(l)).join('\n') + '\n');
const failPct = Math.round(B.fails / B.subTurns * 100);
console.log('GOOD: lanes', G.lanes, 'subTurns', G.subTurns, 'cost $' + G.cost.toFixed(2), 'fails', G.fails);
console.log('BAD : lanes', B.lanes, 'subTurns', B.subTurns, 'cost $' + B.cost.toFixed(2), 'fails', B.fails, '=', failPct + '%');
